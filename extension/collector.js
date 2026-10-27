'use strict';

const cdp = require('./cdp');
const store = require('./store');

const state = {
  started: false,
  output: undefined,
  parsedCount: 0,
  recentParsed: []
};

function log(message, error) {
  if (!state.output) return;
  const detail = error && error.stack ? error.stack : (error ? String(error) : '');
  state.output.appendLine(`[collector] ${message}${detail ? `: ${detail}` : ''}`);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function modelOrNull(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function hasUsage(record) {
  // 空会话（刚创建、还没产生消耗）会返回 model/credits 全空、token 全 0 的响应。
  // 它不是一次真实的用量，存下来会虚增请求数并在明细表里留一行空白。
  return record.m !== null || record.cr !== null
    || (record.p || 0) > 0 || (record.c || 0) > 0 || (record.ca || 0) > 0;
}

function parseRecords(bodyText) {
  let body;
  try { body = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText; } catch (error) { return { records: [], reason: 'invalid-json' }; }
  const usage = body?.user_usage_group_by_session;
  if (!usage || typeof usage !== 'object') return { records: [], reason: 'missing-user-usage-group' };
  const details = Array.isArray(usage.usage_group_details) ? usage.usage_group_details.filter((item) => item && typeof item === 'object') : [];
  const items = details.length ? details : [null];
  const sid = modelOrNull(usage.session_id);
  const records = items.map((item) => {
    const info = details.length ? item?.extra_info : usage.extra_info;
    const model = modelOrNull(item?.model_display_name) ?? modelOrNull(usage.model_name);
    const credits = details.length ? numberOrNull(item?.credits_float) : numberOrNull(usage.credits_float);
    return { t: Date.now(), m: model, p: numberOrNull(info?.input_token), c: numberOrNull(info?.output_token), ca: numberOrNull(info?.cache_read_token), cr: credits, s: 'cdp', e: 'commercial/get_session_usage', sid };
  }).filter(hasUsage);
  if (!records.length) return { records: [], reason: 'empty-session' };
  return { records };
}

function logDrop(reason, bodyText) {
  log(`[drop] reason=${reason} body=${String(bodyText || '').slice(0, 200)}`);
}

function emitRecord(record) {
  state.parsedCount += 1;
  state.recentParsed.push(record);
  while (state.recentParsed.length > 3) state.recentParsed.shift();
  store.addRecord(record);
  log(`[parsed] sid=${record.sid ?? 'null'} m=${record.m ?? 'null'} p=${record.p ?? 'null'} c=${record.c ?? 'null'} ca=${record.ca ?? 'null'} cr=${record.cr ?? 'null'}`);
}

async function handlePayload(payload) {
  const bodyText = String(payload.bodyText || '');
  store.addRawSample({ capturedAt: Date.now(), url: payload.url, requestId: payload.requestId, bytes: payload.bytes, body: bodyText.slice(0, 65536), truncated: bodyText.length > 65536 });
  try {
    const parsed = parseRecords(bodyText);
    if (!parsed.records.length) { logDrop(parsed.reason || 'no-record', bodyText); return; }
    parsed.records.forEach(emitRecord);
  } catch (error) {
    logDrop(error.message || 'parse-error', bodyText);
  }
}

async function startCollector(context, output) {
  if (state.started) return;
  state.started = true;
  state.output = output;
  state.parsedCount = 0;
  state.recentParsed = [];
  try {
    await store.init(context, output);
    await cdp.start({ output, onPayload: handlePayload });
  } catch (error) {
    log('startup failed', error);
  }
}

async function stopCollector() {
  if (!state.started) return;
  state.started = false;
  try { await cdp.stop(); } catch (error) { log('stop CDP failed', error); }
  try { await store.flush(); } catch (error) { log('flush on stop failed', error); }
  store.dispose();
}

function getStatus() {
  return { parsedCount: state.parsedCount, recentParsed: state.recentParsed.slice(), cdp: cdp.getStatus(), store: store.getStats() };
}

module.exports = { startCollector, stopCollector, getStatus, parsePayload: (bodyText) => parseRecords(bodyText).records[0] || null };
