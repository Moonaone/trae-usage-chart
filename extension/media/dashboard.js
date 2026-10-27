'use strict';

const vscodeApi = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi()
  : { postMessage() {} };

const { dateKey, dateFromKey, addDays, dayTitle, pad2 } = globalThis.TraeUsageLocalTime;
const { clampWindow, panWindow, zoomWindow, windowSlice } = globalThis.TraeUsageZoom;
const { layoutBars, layoutLines, layoutAxis } = globalThis.TraeUsageChartLayout;

const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const state = {
  records: [],
  range: '7',
  heatMetric: 'tokens',
  group: 'model',
  metric: 'tokens',
  top: 5,
  chart: 'bar',
  granularity: 'day',
  detailPage: 0,
  view: { start: 0, size: 0 },
  chartPool: null,
  zoomPool: null,
  currentSlots: [],
  quota: null,
  status: null,
  reconciliation: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  return finite(Number(value));
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const timestamp = numeric(value.t);
  if (timestamp === null) return null;
  return {
    t: timestamp,
    m: value.m == null ? null : String(value.m),
    p: numeric(value.p),
    c: numeric(value.c),
    ca: numeric(value.ca),
    cr: numeric(value.cr),
    s: value.s == null ? null : String(value.s),
    e: value.e == null ? null : String(value.e)
  };
}

function flattenPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.records)) return payload.records;
  if (payload && payload.days && typeof payload.days === 'object') {
    return Object.keys(payload.days).reduce((all, day) => all.concat(payload.days[day] || []), []);
  }
  return [];
}

function formatNumber(value) {
  const number = finite(value);
  return number === null ? '—' : Math.round(number).toLocaleString('en-US');
}

function formatCompact(value) {
  const number = finite(value);
  if (number === null) return '—';
  const absolute = Math.abs(number);
  // 「亿」档只有 2 位有效数字（1.2 亿 ≈ ±4% 误差），对账时不可用，所以保留 2 位小数；
  // 「万」档有 5 位有效数字（2742.5 万 ≈ 误差 <0.001%），1 位小数已足够。
  if (absolute >= 100000000) return `${(number / 100000000).toFixed(2)} 亿`;
  if (absolute >= 10000) return `${(number / 10000).toFixed(1)} 万`;
  return Math.round(number).toLocaleString('en-US');
}

function formatPercent(value) {
  const number = finite(value);
  return number === null ? '—' : `${number.toFixed(1)}%`;
}

function tokenValue(record) {
  if (record.p === null && record.c === null) return null;
  return (record.p || 0) + (record.c || 0);
}

function metricValue(record, metric) {
  if (metric === 'requests') return 1;
  if (metric === 'credits') return record.cr;
  return tokenValue(record);
}

function sumNullable(records, getter) {
  let total = 0;
  let seen = false;
  records.forEach((record) => {
    const value = finite(getter(record));
    if (value !== null) {
      total += value;
      seen = true;
    }
  });
  return seen ? total : null;
}

function rangeInfo() {
  const timestamps = state.records.map((record) => record.t).filter(Number.isFinite);
  const latestKey = dateKey(Date.now());
  if (state.range === 'all') {
    const earliest = timestamps.length ? new Date(Math.min(...timestamps)) : dateFromKey(latestKey);
    return { start: dateKey(earliest.getTime()), end: latestKey };
  }
  const days = Number(state.range);
  return { start: dateKey(addDays(dateFromKey(latestKey), -(days - 1)).getTime()), end: latestKey };
}

function recordsInRange(range = rangeInfo()) {
  return state.records.filter((record) => {
    const key = dateKey(record.t);
    return key >= range.start && key <= range.end;
  });
}

function dailyBuckets(records) {
  const result = new Map();
  records.forEach((record) => {
    const key = dateKey(record.t);
    if (!result.has(key)) result.set(key, { tokens: null, credits: null, requests: 0, records: [] });
    const bucket = result.get(key);
    const tokens = tokenValue(record);
    if (tokens !== null) bucket.tokens = (bucket.tokens || 0) + tokens;
    if (record.cr !== null) bucket.credits = (bucket.credits || 0) + record.cr;
    bucket.requests += 1;
    bucket.records.push(record);
  });
  return result;
}

function consecutiveDays(keys) {
  if (!keys.length) return 0;
  const sorted = Array.from(new Set(keys)).sort();
  let longest = 1;
  let current = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = dateFromKey(sorted[index - 1]);
    const currentDate = dateFromKey(sorted[index]);
    const difference = Math.round((currentDate - previous) / 86400000);
    if (difference === 1) current += 1;
    else current = 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

function sparkline(values) {
  const numeric = values.map(finite).filter((value) => value !== null);
  if (numeric.length < 2) return '';
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 64;
    const y = value === null ? 25 : 24 - ((value - min) / span) * 21;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="sparkline" viewBox="0 0 64 26" aria-hidden="true"><polyline points="${points}"></polyline></svg>`;
}

function renderKpis() {
  const range = rangeInfo();
  const records = recordsInRange(range);
  const days = dailyBuckets(records);
  const dayKeys = Array.from(days.keys()).sort();
  const tokenTotal = sumNullable(records, tokenValue);
  const creditTotal = sumNullable(records, (record) => record.cr);
  const requestTotal = records.length ? records.length : null;
  const promptTotal = sumNullable(records, (record) => record.p);
  const cachedTotal = sumNullable(records, (record) => record.ca);
  const cacheRate = promptTotal !== null && promptTotal > 0 && cachedTotal !== null ? (cachedTotal / promptTotal) * 100 : null;
  const dailyTokenValues = dayKeys.map((key) => days.get(key).tokens);
  const dailyCreditValues = dayKeys.map((key) => days.get(key).credits);
  const dailyRequestValues = dayKeys.map((key) => days.get(key).requests);

  let peakKey = null;
  let peakValue = null;
  dayKeys.forEach((key) => {
    const candidate = days.get(key).tokens !== null ? days.get(key).tokens : days.get(key).credits;
    if (candidate !== null && (peakValue === null || candidate > peakValue)) {
      peakKey = key;
      peakValue = candidate;
    }
  });

  const modelTotals = new Map();
  records.forEach((record) => {
    const tokens = tokenValue(record);
    if (tokens === null || !record.m) return;
    modelTotals.set(record.m, (modelTotals.get(record.m) || 0) + tokens);
  });
  const topModel = Array.from(modelTotals.entries()).sort((a, b) => b[1] - a[1])[0] || [null, null];
  const rangeDays = Math.max(1, Math.round((dateFromKey(range.end) - dateFromKey(range.start)) / 86400000) + 1);
  const average = tokenTotal === null ? null : tokenTotal / rangeDays;
  const quotaText = state.quota && finite(state.quota.remaining) !== null ? formatNumber(state.quota.remaining) : '—';
  const hasRecords = records.length > 0;
  const cards = [
    ['总积分消耗', hasRecords ? creditTotal : null, '按当前范围累计', sparkline(dailyCreditValues)],
    ['请求数', requestTotal, '—', sparkline(dailyRequestValues)],
    ['总 Token 数', tokenTotal, formatExact(tokenTotal), sparkline(dailyTokenValues)],
    ['缓存命中率', cacheRate, cachedTotal === null ? '可观测输入 —' : `可观测输入 ${formatCompact(promptTotal)}`, sparkline(dailyTokenValues)],
    ['活跃天数', hasRecords ? dayKeys.length : null, hasRecords ? `最长连续 ${consecutiveDays(dayKeys)} 天` : '—', ''],
    ['高峰日', peakValue, peakKey || '日期 —', ''],
    ['用量最高模型', topModel[0], topModel[1] === null ? '该模型 Token 数 —' : `该模型 ${formatCompact(topModel[1])} Token`, 'model'],
    ['日均', average, `剩余额度 ${quotaText}`, '']
  ];
  $('#range-summary-text').textContent = `${state.range === 'all' ? '全部' : `最近 ${state.range} 天`} · ${formatCompact(tokenTotal)} Token / ${formatNumber(requestTotal)} 个请求`;
  $('#analysis-summary').textContent = `当前范围总量 ${formatCompact(tokenTotal)} Token · ${formatCompact(creditTotal)} 积分`;
  $('#kpi-grid').innerHTML = cards.map((card) => {
    const title = card[0];
    const value = card[1];
    let display = title === '缓存命中率' ? formatPercent(value) : (title === '活跃天数' ? formatNumber(value) : (title === '用量最高模型' ? escapeHtml(value || '—') : formatCompact(value)));
    const valueClass = title === '用量最高模型' ? 'kpi-value model' : 'kpi-value';
    const sub = card[2];
    const subHtml = sub && sub !== '—' ? `<div class="kpi-sub">${sub}</div>` : '';
    return `<article class="kpi"><div class="kpi-top"><div class="kpi-title">${title}</div>${card[3] && card[3].startsWith('<svg') ? card[3] : ''}</div><div class="${valueClass}">${display}</div>${subHtml}</article>`;
  }).join('');
}

function heatLevel(value, sorted) {
  if (value === null || value <= 0 || !sorted.length) return 0;
  const index = sorted.findIndex((candidate) => candidate >= value);
  const percentile = index < 0 ? 1 : (index + 1) / sorted.length;
  if (percentile <= .25) return 1;
  if (percentile <= .5) return 2;
  if (percentile <= .75) return 3;
  return 4;
}

function resizeHeatmap(totalColumns) {
  const heatmap = $('#heatmap');
  const columns = totalColumns || (heatmap ? heatmap.children.length : 0);
  if (!heatmap || !columns) return;
  const styles = window.getComputedStyle(heatmap);
  const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  const available = Math.max(0, heatmap.clientWidth - padding);
  let gap = 3;
  let cell = Math.floor((available - (columns - 1) * gap) / columns);
  cell = Math.max(10, Math.min(24, cell));
  gap = cell >= 16 ? 4 : 3;
  while (cell > 10 && columns * cell + (columns - 1) * gap > available) cell -= 1;
  if (cell >= 24 && columns > 1) {
    gap = Math.max(3, Math.min(6, Math.floor((available - columns * cell) / (columns - 1))));
  }
  heatmap.style.setProperty('--heat-cell', cell + 'px');
  heatmap.style.setProperty('--heat-gap', gap + 'px');
  heatmap.style.minHeight = (18 + 7 * (cell + gap)) + 'px';
}

function renderHeatmap() {
  const endKey = dateKey(Date.now());
  const start = addDays(dateFromKey(endKey), -119);
  const firstDay = start.getDay() === 0 ? 6 : start.getDay() - 1;
  const gridStart = addDays(start, -firstDay);
  const values = new Map();
  state.records.forEach((record) => {
    const key = dateKey(record.t);
    const value = state.heatMetric === 'credits' ? record.cr : tokenValue(record);
    if (value !== null) values.set(key, (values.get(key) || 0) + value);
  });
  const sorted = Array.from(values.values()).filter((value) => value > 0).sort((a, b) => a - b);
  const totalColumns = Math.ceil((119 + firstDay + 1) / 7);
  const html = [];
  for (let column = 0; column < totalColumns; column += 1) {
    const columnStart = addDays(gridStart, column * 7);
    let label = '';
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(columnStart, row);
      if (date.getDate() === 1 || (column === 0 && row === 0)) label = `${date.getMonth() + 1}月`;
    }
    const cells = [`<span class="month-label">${label}</span>`];
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(columnStart, row);
      const key = dateKey(date.getTime());
      const inside = key >= dateKey(start.getTime()) && key <= endKey;
      const value = inside ? (values.get(key) ?? null) : null;
      const level = inside ? heatLevel(value, sorted) : 0;
      cells.push(`<span class="heat-cell level-${level}${inside ? '' : ' outside'}"${inside ? ` data-key="${key}"` : ''}></span>`);
    }
    html.push(`<div class="heat-column">${cells.join('')}</div>`);
  }
  $('#heatmap').innerHTML = html.join('');
  resizeHeatmap(totalColumns);
  hideTooltip();
  $('#heatmap').querySelectorAll('.heat-cell[data-key]').forEach((cell) => {
    bindTooltip(cell, () => heatmapTooltip(cell.dataset.key));
  });
}

function heatmapTooltip(key) {
  const records = state.records.filter((record) => dateKey(record.t) === key);
  return tooltipHtml(dayTitle(key), groupEntries(records, state.heatMetric, (record) => record.m || '未知模型'));
}

function groupName(record) {
  if (state.group === 'source') return record.s || '未知来源';
  if (state.group === 'endpoint') return record.e || '未知接口';
  return record.m || '未知模型';
}

function buildChartModel() {
  const records = recordsInRange();
  const totals = new Map();
  records.forEach((record) => {
    const value = metricValue(record, state.metric);
    if (value === null) return;
    const group = groupName(record);
    totals.set(group, (totals.get(group) || 0) + value);
  });
  const ordered = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  const topNames = ordered.slice(0, state.top).map((entry) => entry[0]);
  const hasOther = ordered.length > state.top;
  const groups = hasOther ? topNames.concat('其他') : topNames;
  const buckets = new Map();
  if (state.granularity === 'hour') {
    for (let hour = 0; hour < 24; hour += 1) buckets.set(String(hour).padStart(2, '0'), new Map());
  } else {
    const range = rangeInfo();
    let cursor = dateFromKey(range.start);
    const end = dateFromKey(range.end);
    while (cursor <= end) {
      buckets.set(dateKey(cursor.getTime()), new Map());
      cursor = addDays(cursor, 1);
    }
  }
  records.forEach((record) => {
    const value = metricValue(record, state.metric);
    if (value === null) return;
    const group = groupName(record);
    const bucketKey = state.granularity === 'hour' ? String(new Date(record.t).getHours()).padStart(2, '0') : dateKey(record.t);
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, new Map());
    const targetGroup = topNames.includes(group) ? group : (hasOther ? '其他' : group);
    const bucket = buckets.get(bucketKey);
    bucket.set(targetGroup, (bucket.get(targetGroup) || 0) + value);
  });
  return { groups, buckets: Array.from(buckets.entries()).map(([key, values]) => ({ key, values })) };
}

function svgElement(name, attrs = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.keys(attrs).forEach((key) => element.setAttribute(key, attrs[key]));
  return element;
}

function axisValue(value) {
  if (value >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return Math.round(value).toLocaleString('en-US');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function metricText(value, metric) {
  const number = finite(value);
  if (number === null) return '—';
  if (metric === 'credits') return number.toFixed(2);
  return formatCompact(number);
}

function tooltipHtml(title, entries) {
  const rows = entries.map((entry) => {
    const zero = !(entry.value > 0);
    return `<div class="tip-row${zero ? ' zero' : ''}"><i class="tip-dot" style="background:${entry.color}"></i><span class="tip-name">${escapeHtml(entry.name)}</span><span class="tip-val">${escapeHtml(entry.text)}</span></div>`;
  }).join('');
  return `<div class="tip-title">${escapeHtml(title)}</div>${rows}`;
}

function groupEntries(records, metric, groupOf) {
  const totals = new Map();
  records.forEach((record) => {
    const value = metricValue(record, metric);
    if (value === null) return;
    const group = groupOf ? groupOf(record) : groupName(record);
    totals.set(group, (totals.get(group) || 0) + value);
  });
  return Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).map(([name, value], index) => ({
    name,
    value,
    color: name === '其他' ? 'var(--border)' : (COLORS[index] || 'var(--border)'),
    text: metricText(value, metric)
  }));
}

function showTooltip(event, html) {
  const tooltip = $('#tooltip');
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const width = Math.round(tooltip.offsetWidth);
  const height = Math.round(tooltip.offsetHeight);
  const cursorX = Math.round(event.clientX);
  const cursorY = Math.round(event.clientY);
  const gap = 14;
  const margin = 8;
  const rightFits = cursorX + gap + width + margin <= window.innerWidth;
  const leftFits = cursorX - gap - width >= margin;
  let left;
  if (rightFits) left = cursorX + gap;
  else if (leftFits) left = cursorX - gap - width;
  else left = Math.min(Math.max(margin, cursorX + gap), Math.max(margin, window.innerWidth - width - margin));
  let top = cursorY - height - 12;
  if (top < margin) top = cursorY + 16;
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function hideTooltip() {
  $('#tooltip').hidden = true;
}

function bindTooltip(element, buildHtml) {
  element.addEventListener('mouseenter', (event) => showTooltip(event, buildHtml()));
  element.addEventListener('mousemove', (event) => showTooltip(event, buildHtml()));
  element.addEventListener('mouseleave', hideTooltip);
}

function renderLegend(groups) {
  $('#legend').innerHTML = groups.map((group, index) => `<span class="legend-item"><i class="legend-dot" style="background:${group === '其他' ? 'var(--border)' : (COLORS[index] || 'var(--border)')}"></i>${escapeHtml(group)}</span>`).join('');
}

function ensureZoomPool(svg) {
  if (state.zoomPool) return state.zoomPool;
  const pool = { bars: [], barsLayer: svgElement('g', { class: 'zoom-bars' }), masks: [], border: null, handles: [], hit: null };
  svg.appendChild(pool.barsLayer);
  for (let index = 0; index < 2; index += 1) {
    const mask = svgElement('rect', { class: 'zoom-mask' });
    svg.appendChild(mask);
    pool.masks.push(mask);
  }
  pool.border = svgElement('rect', { class: 'zoom-window-border', rx: 4 });
  svg.appendChild(pool.border);
  for (let index = 0; index < 2; index += 1) {
    const handle = svgElement('rect', { class: 'zoom-handle', rx: 3 });
    svg.appendChild(handle);
    pool.handles.push(handle);
  }
  pool.hit = svgElement('rect', { class: 'zoom-window-hit', rx: 4 });
  svg.appendChild(pool.hit);
  state.zoomPool = pool;
  return pool;
}

function renderZoom(model) {
  const svg = $('#zoom-chart');
  const wrap = $('#zoom-wrap');
  const summary = $('#zoom-summary');
  const leftLabel = $('#zoom-left-label');
  const rightLabel = $('#zoom-right-label');
  if (!svg || !wrap || !summary || !leftLabel || !rightLabel) return;
  const pool = ensureZoomPool(svg);
  const total = model.buckets.length;
  const width = Math.max(1, Math.round(wrap.clientWidth || 1));
  const minSize = total < 2 ? total : 2;
  svg.setAttribute('viewBox', '0 0 ' + width + ' 46');
  wrap.classList.toggle('disabled', total < 2);
  if (total <= 0) {
    summary.textContent = '—';
    leftLabel.hidden = true;
    rightLabel.hidden = true;
    hidePool(pool.bars, 0);
    pool.masks.forEach((mask) => { mask.style.display = 'none'; });
    pool.border.style.display = 'none';
    pool.handles.forEach((handle) => { handle.style.display = 'none'; });
    pool.hit.style.display = 'none';
    return;
  }
  state.view = clampWindow(state.view.start, state.view.size || total, total, minSize);
  const values = model.buckets.map((bucket) => Array.from(bucket.values.values()).reduce((sum, value) => sum + (value > 0 ? value : 0), 0));
  const maximum = Math.max(...values, 1);
  const barWidth = Math.max(1, width / total - 1);
  ensurePool(pool.bars, total, () => svgElement('rect', { class: 'zoom-bar' }), pool.barsLayer);
  values.forEach((value, index) => {
    const node = pool.bars[index];
    const height = Math.max(1, (value / maximum) * 32);
    node.setAttribute('x', index * width / total);
    node.setAttribute('y', 42 - height);
    node.setAttribute('width', barWidth);
    node.setAttribute('height', height);
    node.style.display = '';
  });
  hidePool(pool.bars, total);
  const left = state.view.start * width / total;
  const right = (state.view.start + state.view.size) * width / total;
  pool.masks[0].setAttribute('x', 0);
  pool.masks[0].setAttribute('y', 0);
  pool.masks[0].setAttribute('width', left);
  pool.masks[0].setAttribute('height', 46);
  pool.masks[0].style.display = left > 0 ? '' : 'none';
  pool.masks[1].setAttribute('x', right);
  pool.masks[1].setAttribute('y', 0);
  pool.masks[1].setAttribute('width', Math.max(0, width - right));
  pool.masks[1].setAttribute('height', 46);
  pool.masks[1].style.display = right < width ? '' : 'none';
  pool.border.setAttribute('x', left);
  pool.border.setAttribute('y', 0);
  pool.border.setAttribute('width', Math.max(0, right - left));
  pool.border.setAttribute('height', 46);
  pool.border.style.display = '';
  pool.handles[0].setAttribute('x', Math.max(0, left - 3));
  pool.handles[0].setAttribute('y', 8);
  pool.handles[0].setAttribute('width', 6);
  pool.handles[0].setAttribute('height', 30);
  pool.handles[0].style.display = '';
  pool.handles[1].setAttribute('x', Math.min(width - 6, Math.max(0, right - 3)));
  pool.handles[1].setAttribute('y', 8);
  pool.handles[1].setAttribute('width', 6);
  pool.handles[1].setAttribute('height', 30);
  pool.handles[1].style.display = '';
  pool.hit.setAttribute('x', left);
  pool.hit.setAttribute('y', 0);
  pool.hit.setAttribute('width', Math.max(0, right - left));
  pool.hit.setAttribute('height', 46);
  pool.hit.style.display = '';
  const first = model.buckets[Math.min(total - 1, state.view.start)];
  const last = model.buckets[Math.min(total - 1, Math.max(state.view.start, state.view.start + state.view.size - 1))];
  summary.textContent = first.key + ' ~ ' + last.key + ' · ' + state.view.size + (state.granularity === 'day' ? ' 天' : ' 个点');
  leftLabel.hidden = total < 2;
  rightLabel.hidden = total < 2;
  leftLabel.textContent = first.key;
  rightLabel.textContent = last.key;
  leftLabel.style.left = Math.max(0, left) + 'px';
  rightLabel.style.right = Math.max(0, width - right) + 'px';
  if (total >= 2 && leftLabel.getBoundingClientRect().right >= rightLabel.getBoundingClientRect().left) {
    leftLabel.hidden = true;
    rightLabel.hidden = true;
  }
}

function ensurePool(list, needed, createFn, parent) {
  while (list.length < needed) {
    const node = createFn(list.length);
    parent.appendChild(node);
    list.push(node);
  }
}

function hidePool(list, from) {
  for (let index = from; index < list.length; index += 1) {
    list[index].style.display = 'none';
    if (list[index].classList.contains('hit')) list[index].style.pointerEvents = 'none';
  }
}

function ensureChartPool(svg) {
  if (state.chartPool) return state.chartPool;
  const layers = {
    grid: svgElement('g', { class: 'layer-grid' }),
    bands: svgElement('g', { class: 'layer-bands' }),
    guide: svgElement('g', { class: 'layer-guide' }),
    series: svgElement('g', { class: 'layer-series' }),
    hits: svgElement('g', { class: 'layer-hits' })
  };
  Object.values(layers).forEach((layer) => svg.appendChild(layer));
  const pool = { gridLines: [], gridLabels: [], axisLabels: [], bands: [], guide: null, bars: [], lines: [], points: [], hits: [], layers };
  pool.guide = svgElement('line', { class: 'guide' });
  pool.guide.style.display = 'none';
  layers.guide.appendChild(pool.guide);
  state.chartPool = pool;
  return pool;
}

function bindChartHit(node) {
  node.addEventListener('mouseenter', (event) => {
    const slotIndex = Number(node.dataset.slotIndex);
    const slot = state.currentSlots[slotIndex];
    if (!slot) return;
    const pool = state.chartPool;
    if (state.chart === 'bar' && pool.bands[slotIndex]) pool.bands[slotIndex].classList.add('on');
    if (state.chart !== 'bar') {
      const center = Number(node.dataset.center);
      pool.guide.setAttribute('x1', center);
      pool.guide.setAttribute('x2', center);
      pool.guide.style.display = '';
      pool.guide.classList.add('on');
    }
    const entries = state.currentGroups.map((group, groupIndex) => {
      const value = slot.values.get(group) || 0;
      return { name: group, color: group === '其他' ? 'var(--border)' : (COLORS[groupIndex] || 'var(--border)'), value, text: metricText(value, state.metric) };
    });
    const title = state.granularity === 'hour' ? slot.key + '时' : dayTitle(slot.key);
    showTooltip(event, tooltipHtml(title, entries));
  });
  node.addEventListener('mousemove', (event) => {
    const slotIndex = Number(node.dataset.slotIndex);
    const slot = state.currentSlots[slotIndex];
    if (!slot) return;
    const entries = state.currentGroups.map((group, groupIndex) => {
      const value = slot.values.get(group) || 0;
      return { name: group, color: group === '其他' ? 'var(--border)' : (COLORS[groupIndex] || 'var(--border)'), value, text: metricText(value, state.metric) };
    });
    const title = state.granularity === 'hour' ? slot.key + '时' : dayTitle(slot.key);
    showTooltip(event, tooltipHtml(title, entries));
  });
  node.addEventListener('mouseleave', () => {
    const slotIndex = Number(node.dataset.slotIndex);
    if (state.chartPool && state.chartPool.bands[slotIndex]) state.chartPool.bands[slotIndex].classList.remove('on');
    if (state.chartPool && state.chartPool.guide) {
      state.chartPool.guide.classList.remove('on');
      state.chartPool.guide.style.display = 'none';
    }
    hideTooltip();
  });
}

// size = 0 表示「全量」，renderZoom 里会用 total 归一化。
function resetView() {
  state.view = { start: 0, size: 0 };
}

function renderChart() {
  const svg = $('#chart');
  const pool = ensureChartPool(svg);
  hideTooltip();
  const model = buildChartModel();
  state.currentGroups = model.groups;
  renderLegend(model.groups);
  renderZoom(model);
  const slice = windowSlice(state.view, model.buckets.length);
  const visible = slice.count ? model.buckets.slice(slice.from, slice.to + 1) : [];
  state.currentSlots = visible;
  const wrap = $('#chart-wrap');
  const width = Math.max(320, Math.round((wrap && wrap.clientWidth) || 0) || 1000);
  const height = 320;
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  const margin = { left: 54, right: 18, top: 16, bottom: 42 };
  const plot = { left: margin.left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom, width: width - margin.left - margin.right, height: height - margin.top - margin.bottom };
  const hasValue = visible.some((bucket) => Array.from(bucket.values.values()).some((value) => value > 0));
  const empty = !model.groups.length || !hasValue;
  $('#chart-empty').hidden = !empty;
  const maximum = Math.max(...visible.map((bucket) => Array.from(bucket.values.values()).reduce((sum, value) => sum + value, 0)), 1);
  const base = 10 ** Math.floor(Math.log10(maximum));
  const top = Math.ceil(maximum / base) * base;
  const axis = layoutAxis(top, plot);
  ensurePool(pool.gridLines, axis.gridLines.length, () => svgElement('line'), pool.layers.grid);
  axis.gridLines.forEach((item, index) => {
    const node = pool.gridLines[index];
    node.setAttribute('class', item.isAxis ? 'axis-line' : 'grid-line');
    node.setAttribute('x1', plot.left);
    node.setAttribute('x2', plot.right);
    node.setAttribute('y1', item.y);
    node.setAttribute('y2', item.y);
    node.style.display = '';
  });
  hidePool(pool.gridLines, axis.gridLines.length);
  ensurePool(pool.gridLabels, axis.ticks.length, () => svgElement('text'), pool.layers.grid);
  axis.ticks.forEach((item, index) => {
    const node = pool.gridLabels[index];
    node.setAttribute('x', plot.left - 8);
    node.setAttribute('y', item.y + 4);
    node.setAttribute('text-anchor', 'end');
    node.textContent = item.text;
    node.style.display = '';
  });
  hidePool(pool.gridLabels, axis.ticks.length);
  const slot = visible.length ? plot.width / visible.length : 0;
  const labelsEvery = visible.length > 12 ? Math.ceil(visible.length / 12) : 1;
  const xLabels = [];
  visible.forEach((bucket, index) => {
    if (index % labelsEvery === 0) xLabels.push({ bucket, index });
  });
  ensurePool(pool.axisLabels, xLabels.length, () => svgElement('text'), pool.layers.grid);
  xLabels.forEach((item, index) => {
    const node = pool.axisLabels[index];
    node.setAttribute('x', plot.left + slot * item.index + slot / 2);
    node.setAttribute('y', height - 14);
    node.setAttribute('text-anchor', 'middle');
    node.textContent = state.granularity === 'hour' ? item.bucket.key + '时' : item.bucket.key.slice(5);
    node.style.display = '';
  });
  hidePool(pool.axisLabels, xLabels.length);
  ensurePool(pool.bands, visible.length, () => svgElement('rect', { class: 'col-hl', rx: 4 }), pool.layers.bands);
  visible.forEach((bucket, index) => {
    const node = pool.bands[index];
    node.setAttribute('x', plot.left + slot * index);
    node.setAttribute('y', plot.top);
    node.setAttribute('width', slot);
    node.setAttribute('height', plot.height);
    node.classList.remove('on');
    node.style.display = empty ? 'none' : '';
  });
  hidePool(pool.bands, visible.length);
  pool.guide.setAttribute('y1', plot.top);
  pool.guide.setAttribute('y2', plot.top + plot.height);
  pool.guide.style.display = 'none';
  pool.guide.classList.remove('on');
  if (!empty) {
    if (state.chart === 'bar') {
      const bars = layoutBars(visible, model.groups, top, plot);
      ensurePool(pool.bars, bars.length, () => svgElement('rect', { class: 'bar chart-animate', rx: 3 }), pool.layers.series);
      bars.forEach((item, index) => {
        const node = pool.bars[index];
        node.setAttribute('x', item.x);
        node.setAttribute('y', item.y);
        node.setAttribute('width', item.width);
        node.setAttribute('height', Math.max(1, item.height));
        node.setAttribute('fill', COLORS[item.groupIndex] || 'var(--border)');
        node.style.display = '';
      });
      hidePool(pool.bars, bars.length);
      hidePool(pool.lines, 0);
      hidePool(pool.points, 0);
    } else {
      const lineGeometry = layoutLines(visible, model.groups, top, plot);
      ensurePool(pool.lines, lineGeometry.lines.length, () => svgElement('path', { class: 'line chart-animate' }), pool.layers.series);
      lineGeometry.lines.forEach((item, index) => {
        const node = pool.lines[index];
        node.setAttribute('d', item.d);
        node.setAttribute('stroke', COLORS[item.groupIndex] || 'var(--border)');
        node.style.display = '';
      });
      hidePool(pool.lines, lineGeometry.lines.length);
      ensurePool(pool.points, lineGeometry.points.length, () => svgElement('circle', { class: 'point chart-animate', r: 3.5 }), pool.layers.series);
      lineGeometry.points.forEach((item, index) => {
        const node = pool.points[index];
        node.setAttribute('cx', item.x);
        node.setAttribute('cy', item.y);
        node.setAttribute('fill', COLORS[item.groupIndex] || 'var(--border)');
        node.style.display = '';
      });
      hidePool(pool.points, lineGeometry.points.length);
      hidePool(pool.bars, 0);
    }
  } else {
    hidePool(pool.bars, 0);
    hidePool(pool.lines, 0);
    hidePool(pool.points, 0);
  }
  ensurePool(pool.hits, visible.length, () => {
    const node = svgElement('rect', { class: 'hit' });
    bindChartHit(node);
    return node;
  }, pool.layers.hits);
  visible.forEach((bucket, index) => {
    const node = pool.hits[index];
    node.dataset.slotIndex = String(index);
    node.dataset.center = String(plot.left + slot * index + slot / 2);
    node.setAttribute('x', plot.left + slot * index);
    node.setAttribute('y', plot.top);
    node.setAttribute('width', slot);
    node.setAttribute('height', plot.height);
    node.style.display = empty ? 'none' : '';
    node.style.pointerEvents = empty ? 'none' : '';
  });
  hidePool(pool.hits, visible.length);
}

function formatCaptureTime(timestamp) {
  const date = new Date(timestamp);
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function renderHealth() {
  const banner = $('#health-banner');
  const indicator = $('#health-status');
  if (!banner || !indicator) return;
  const status = state.status || {};
  const cdp = status.cdp || {};
  const parsed = Number(status.parsedCount) || 0;
  const targetResponses = Number(cdp.targetResponseCount) || 0;
  const pageCount = Number(cdp.connectionCount) || 0;
  const pageText = pageCount > 1 ? ' · ' + pageCount + ' 个页面' : '';
  const networkPending = Array.isArray(cdp.targets) && cdp.targets.some((target) => target.networkReady === false);
  const lastRecordAt = status.store && status.store.lastRecordAt;
  const normalText = '采集正常' + pageText + (lastRecordAt ? ' · 最近 ' + formatCaptureTime(lastRecordAt) : '')
    + (networkPending ? ' · 部分页面网络监听未就绪' : '');
  banner.hidden = true;
  banner.textContent = '';
  indicator.className = 'health-status';
  if (cdp.connected === false && networkPending) {
    indicator.textContent = '网络监听未就绪';
    indicator.className = 'health-status warn';
  } else if (cdp.connected === false) {
    banner.textContent = '未连接到调试端口 9222，无法采集新用量。请确认 Trae 是用带 --remote-debugging-port=9222 参数的快捷方式启动的。' + (cdp.lastError ? ' ' + cdp.lastError : '');
    banner.hidden = false;
    indicator.textContent = '未连接 9222';
    indicator.className = 'health-status warn';
  } else if (cdp.connected === true && parsed === 0 && targetResponses > 0) {
    banner.textContent = '已连接调试端口，但最近 ' + targetResponses + ' 次目标响应一条都没解析成功，可能是接口字段变了。请运行「Trae Usage Chart: 显示诊断」把输出反馈给开发者。';
    banner.hidden = false;
    indicator.textContent = '已连接但解析失败';
    indicator.className = 'health-status warn';
  } else if (state.reconciliation && state.reconciliation.alert === true && Number.isFinite(state.reconciliation.lastDrift)) {
    banner.textContent = '账户用量比本库记录多 ' + state.reconciliation.lastDrift.toFixed(2) + ' 积分，可能有调用未被采集。可运行「显示诊断」查看详情。';
    banner.hidden = false;
    indicator.textContent = normalText;
  } else if (state.reconciliation && Number.isFinite(state.reconciliation.pendingDrift)) {
    banner.textContent = '疑似漏采 ' + state.reconciliation.pendingDrift.toFixed(2) + ' 积分，待下次检查确认。';
    banner.hidden = false;
    indicator.textContent = normalText;
  } else if (cdp.connected === true) {
    indicator.textContent = normalText;
  }
}

// 明细表是台账，必须精确到个位；formatCompact（「458.7 万」）只用于卡片和图表。
function formatExact(value) {
  const number = finite(value);
  return number === null ? '—' : Math.round(number).toLocaleString('en-US');
}

function detailTime(timestamp) {
  const date = new Date(timestamp);
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function sourceLabel(source) {
  return ({ cdp: 'CDP', native: '原生', history: '历史' })[source] || source || '—';
}

function renderDetails() {
  const rows = $('#detail-rows');
  const empty = $('#detail-empty');
  const pager = $('#detail-pager');
  if (!rows || !empty || !pager) return;
  const records = recordsInRange().slice().sort((a, b) => b.t - a.t);
  const pageCount = Math.max(1, Math.ceil(records.length / 10));
  state.detailPage = Math.max(0, Math.min(state.detailPage, pageCount - 1));
  const start = state.detailPage * 10;
  const visible = records.slice(start, start + 10);
  $('#detail-summary').textContent = '当前范围 ' + records.length + ' 条记录';
  empty.hidden = records.length !== 0;
  rows.innerHTML = visible.map((record) => '<tr><td>' + detailTime(record.t) + '</td><td>' + escapeHtml(record.m || '—') + '</td><td>' + formatExact(record.p) + '</td><td>' + formatExact(record.c) + '</td><td class="detail-cache">' + formatExact(record.ca) + '</td><td>' + (record.cr === null ? '—' : record.cr.toFixed(2)) + '</td><td>' + escapeHtml(sourceLabel(record.s)) + '</td></tr>').join('');
  pager.hidden = records.length === 0 || pageCount <= 1;
  $('#detail-page-label').textContent = '第 ' + (state.detailPage + 1) + ' / ' + pageCount + ' 页';
  $('#detail-prev').disabled = state.detailPage === 0;
  $('#detail-next').disabled = state.detailPage >= pageCount - 1;
}

function renderAll() {
  const tokenOption = $('#metric-select option[value="tokens"]');
  const tokenAvailable = state.records.some((record) => tokenValue(record) !== null);
  tokenOption.hidden = !tokenAvailable;
  if (!tokenAvailable && state.metric === 'tokens') {
    state.metric = 'credits';
    $('#metric-select').value = 'credits';
  }
  renderKpis();
  renderHeatmap();
  renderChart();
  renderDetails();
  renderHealth();
}

function requestLoad() {
  vscodeApi.postMessage({ type: 'load' });
}

function refreshData() {
  cancelScheduledRender();
  resetView();
  state.detailPage = 0;
  requestLoad();
}

let zoomDrag;
let mainPan;
let renderFrame = 0;

function scheduleRender() {
  if (renderFrame) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0;
    renderChart();
  });
}

function cancelScheduledRender() {
  if (!renderFrame) return;
  window.cancelAnimationFrame(renderFrame);
  renderFrame = 0;
}

function zoomPointerDown(event) {
  const svg = $('#zoom-chart');
  if (!svg) return;
  const model = buildChartModel();
  const total = model.buckets.length;
  if (total < 2) return;
  const rect = svg.getBoundingClientRect();
  const view = clampWindow(state.view.start, state.view.size || total, total, 2);
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const left = view.start * rect.width / total;
  const right = (view.start + view.size) * rect.width / total;
  const edge = 9;
  let mode = null;
  if (Math.abs(x - left) <= edge) mode = 'left';
  else if (Math.abs(x - right) <= edge) mode = 'right';
  else if (x > left && x < right) mode = 'pan';
  if (!mode) return;
  event.preventDefault();
  zoomDrag = { mode, pointerId: event.pointerId, startX: x, lastX: x, startView: view, total, rectWidth: rect.width };
  svg.classList.add('dragging');
  try { svg.setPointerCapture(event.pointerId); } catch (_) {}
}

function applyZoomDrag(x) {
  if (!zoomDrag) return;
  const drag = zoomDrag;
  const delta = (x - drag.startX) / Math.max(1, drag.rectWidth) * drag.total;
  if (drag.mode === 'pan') {
    state.view = panWindow(drag.startView, delta, drag.total, 2);
  } else if (drag.mode === 'left') {
    const end = drag.startView.start + drag.startView.size;
    const nextStart = Math.round(drag.startView.start + delta);
    state.view = clampWindow(nextStart, end - nextStart, drag.total, 2);
  } else {
    const nextEnd = Math.round(drag.startView.start + drag.startView.size + delta);
    state.view = clampWindow(drag.startView.start, nextEnd - drag.startView.start, drag.total, 2);
  }
  scheduleRender();
}

function zoomPointerMove(event) {
  if (!zoomDrag) return;
  const rect = $('#zoom-chart').getBoundingClientRect();
  zoomDrag.lastX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  applyZoomDrag(zoomDrag.lastX);
}

function zoomPointerStop(event) {
  if (!zoomDrag) return;
  const drag = zoomDrag;
  applyZoomDrag(drag.lastX);
  cancelScheduledRender();
  renderChart();
  const svg = $('#zoom-chart');
  try { svg.releasePointerCapture(event.pointerId); } catch (_) {}
  svg.classList.remove('dragging');
  zoomDrag = undefined;
}

function zoomWheel(event) {
  const model = buildChartModel();
  const total = model.buckets.length;
  if (total < 2) return;
  const rect = $('#chart-wrap').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  event.preventDefault();
  state.view = zoomWindow(state.view, ratio, factor, total, 2);
  scheduleRender();
}

function mainPanDown(event) {
  const chartWrap = $('#chart-wrap');
  const model = buildChartModel();
  const total = model.buckets.length;
  if (!chartWrap || total < 2) return;
  const view = clampWindow(state.view.start, state.view.size || total, total, 2);
  const rect = chartWrap.getBoundingClientRect();
  mainPan = {
    pointerId: event.pointerId,
    startX: event.clientX,
    lastX: event.clientX,
    startView: view,
    total,
    plotWidth: Math.max(1, rect.width - 54 - 18),
    dragging: false
  };
  try { chartWrap.setPointerCapture(event.pointerId); } catch (_) {}
}

function mainPanMove(event) {
  if (!mainPan) return;
  mainPan.lastX = event.clientX;
  const deltaPixels = event.clientX - mainPan.startX;
  if (!mainPan.dragging && Math.abs(deltaPixels) > 4) {
    mainPan.dragging = true;
    $('#chart-wrap').classList.add('panning');
    hideTooltip();
  }
  if (!mainPan.dragging) return;
  const delta = (event.clientX - mainPan.startX) / mainPan.plotWidth * mainPan.total;
  state.view = panWindow(mainPan.startView, -delta, mainPan.total, 2);
  scheduleRender();
}

function mainPanStop(event) {
  if (!mainPan) return;
  const chartWrap = $('#chart-wrap');
  const pan = mainPan;
  if (pan.dragging) {
    cancelScheduledRender();
    renderChart();
  }
  try { chartWrap.releasePointerCapture(event.pointerId); } catch (_) {}
  chartWrap.classList.remove('panning');
  mainPan = undefined;
}

function bindControls() {
  $('#refresh-button').addEventListener('click', refreshData);
  $$('#range-tabs .pill').forEach((button) => button.addEventListener('click', () => {
    $$('#range-tabs .pill').forEach((item) => item.classList.toggle('active', item === button));
    state.range = button.dataset.range;
    cancelScheduledRender();
    resetView();
    state.detailPage = 0;
    renderAll();
  }));
  $$('#heat-tabs .pill').forEach((button) => button.addEventListener('click', () => {
    $$('#heat-tabs .pill').forEach((item) => item.classList.toggle('active', item === button));
    state.heatMetric = button.dataset.heat;
    cancelScheduledRender();
    renderHeatmap();
  }));
  $('#group-select').addEventListener('change', (event) => { cancelScheduledRender(); state.group = event.target.value; resetView(); renderChart(); });
  $('#metric-select').addEventListener('change', (event) => { cancelScheduledRender(); state.metric = event.target.value; resetView(); state.detailPage = 0; renderChart(); renderDetails(); });
  $('#top-select').addEventListener('change', (event) => { cancelScheduledRender(); state.top = Number(event.target.value); resetView(); renderChart(); });
  $$('.pill[data-chart]').forEach((button) => button.addEventListener('click', () => {
    $$('.pill[data-chart]').forEach((item) => item.classList.toggle('active', item === button));
    cancelScheduledRender();
    state.chart = button.dataset.chart;
    renderChart();
  }));
  $$('.pill[data-granularity]').forEach((button) => button.addEventListener('click', () => {
    $$('.pill[data-granularity]').forEach((item) => item.classList.toggle('active', item === button));
    state.granularity = button.dataset.granularity;
    cancelScheduledRender();
    resetView();
    renderChart();
  }));
  $('#zoom-reset').addEventListener('click', () => { cancelScheduledRender(); resetView(); renderChart(); });
  $('#zoom-chart').addEventListener('pointerdown', zoomPointerDown);
  $('#zoom-chart').addEventListener('pointermove', zoomPointerMove);
  $('#zoom-chart').addEventListener('pointerup', zoomPointerStop);
  $('#zoom-chart').addEventListener('pointercancel', zoomPointerStop);
  $('#chart-wrap').addEventListener('wheel', zoomWheel, { passive: false });
  $('#chart-wrap').addEventListener('pointerdown', mainPanDown);
  $('#chart-wrap').addEventListener('pointermove', mainPanMove);
  $('#chart-wrap').addEventListener('pointerup', mainPanStop);
  $('#chart-wrap').addEventListener('pointercancel', mainPanStop);
  $('#detail-prev').addEventListener('click', () => { state.detailPage -= 1; renderDetails(); });
  $('#detail-next').addEventListener('click', () => { state.detailPage += 1; renderDetails(); });
}

window.addEventListener('message', async (event) => {
  const message = event.data || {};
  if (message.type === 'refresh') {
    await refreshData();
    return;
  }
  if (message.type === 'data') {
    cancelScheduledRender();
    state.records = flattenPayload({ days: message.days }).map(normalizeRecord).filter(Boolean);
    resetView();
    state.detailPage = 0;
    renderAll();
  }
  if (message.type === 'empty') {
    cancelScheduledRender();
    state.records = [];
    resetView();
    state.detailPage = 0;
    renderAll();
  }
  if (message.type === 'quota') {
    state.quota = message;
    renderKpis();
  }
  if (message.type === 'status') {
    state.status = message.status || null;
    renderHealth();
  }
  if (message.type === 'reconcile') {
    state.reconciliation = message.reconciliation || null;
    renderHealth();
  }
});

(async function init() {
  bindControls();
  window.addEventListener('beforeunload', cancelScheduledRender);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      cancelScheduledRender();
      resizeHeatmap();
      renderChart();
    }, 120);
  });
  requestLoad();
  renderAll();
  vscodeApi.postMessage({ type: 'ready' });
})();







