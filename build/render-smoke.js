'use strict';

// 渲染层冒烟测试：用最小 DOM 桩加载 media/dashboard.js，喂一份真实形状的数据，
// 然后断言「图表画出了柱子」「明细表渲染出了行」。
//
// 为什么需要它：selftest 只覆盖纯数学模块（store / zoom / chartLayout），
// 完全不碰 DOM。第四轮曾把一个 svgElement('line') 少传参数的错误发到生产，
// 表现为「图表空白 + 明细表显示 0 条」——这类错误只有真正跑一遍渲染才能抓到。
//
// 运行：build\node.cmd build\render-smoke.js

const fs = require('fs');
const path = require('path');

const mediaRoot = path.join(__dirname, '..', 'extension', 'media');

globalThis.TraeUsageLocalTime = require(path.join(mediaRoot, 'localtime.js'));
globalThis.TraeUsageZoom = require(path.join(mediaRoot, 'zoom.js'));
globalThis.TraeUsageChartLayout = require(path.join(mediaRoot, 'chartLayout.js'));

const registry = new Map();

class FakeNode {
  constructor(name) {
    this.tagName = name;
    this.attributes = {};
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] === undefined ? '' : this[name]; }
    };
    this.dataset = {};
    this.classList = {
      _set: new Set(),
      add: (value) => this.classList._set.add(value),
      remove: (value) => this.classList._set.delete(value),
      contains: (value) => this.classList._set.has(value),
      toggle: (value, force) => {
        if (force === undefined) {
          if (this.classList._set.has(value)) this.classList._set.delete(value);
          else this.classList._set.add(value);
        } else if (force) this.classList._set.add(value);
        else this.classList._set.delete(value);
      }
    };
    this.children = [];
    this.textContent = '';
    this._innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.clientWidth = 1000;
    this.clientHeight = 320;
    this.offsetWidth = 100;
    this.offsetHeight = 40;
    this.listeners = {};
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }
  addEventListener(name, handler) { (this.listeners[name] = this.listeners[name] || []).push(handler); }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 320, width: 1000, height: 320 }; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); }
  descendants() {
    const all = [];
    const walk = (node) => node.children.forEach((child) => { all.push(child); walk(child); });
    walk(this);
    return all;
  }
}

function nodeFor(selector) {
  if (!registry.has(selector)) registry.set(selector, new FakeNode(selector));
  return registry.get(selector);
}

globalThis.document = {
  querySelector: (selector) => nodeFor(selector),
  querySelectorAll: () => [],
  createElementNS: (namespace, name) => new FakeNode(name),
  createElement: (name) => new FakeNode(name),
  addEventListener: () => {}
};

globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  devicePixelRatio: 1,
  addEventListener: (name, handler) => {
    globalThis.window._listeners = globalThis.window._listeners || {};
    (globalThis.window._listeners[name] = globalThis.window._listeners[name] || []).push(handler);
  },
  removeEventListener: () => {},
  getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px' }),
  requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  clearTimeout,
  setTimeout
};

globalThis.localStorage = {
  _map: new Map(),
  getItem: (key) => (globalThis.localStorage._map.has(key) ? globalThis.localStorage._map.get(key) : null),
  setItem: (key, value) => globalThis.localStorage._map.set(key, String(value)),
  removeItem: (key) => globalThis.localStorage._map.delete(key)
};

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log('PASS ' + name);
  else {
    failures.push(name);
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function dispatch(message) {
  const listeners = (globalThis.window._listeners && globalThis.window._listeners.message) || [];
  listeners.forEach((handler) => handler({ data: message }));
}

(async () => {
  const before = [];
  const originalError = console.error;
  console.error = (...args) => { before.push(args.map(String).join(' ')); };

  try {
    const source = fs.readFileSync(path.join(mediaRoot, 'dashboard.js'), 'utf8');
    // 用 Function 包一层，避免 require 缓存和严格模式的模块作用域差异
    new Function(source)();

    const now = Date.now();
    const day = (offset, extra) => Object.assign({
      t: now - offset * 3600000,
      m: 'DeepSeek-V4.1-Flash',
      p: 100000,
      c: 2000,
      ca: 80000,
      cr: 1.5,
      s: 'cdp',
      e: 'commercial/get_session_usage',
      sid: 'sid-' + offset
    }, extra || {});

    dispatch({
      type: 'data',
      days: {
        [globalThis.TraeUsageLocalTime.dateKey(now)]: [day(1), day(2, { cr: 2.5, sid: 'sid-2' })],
        [globalThis.TraeUsageLocalTime.dateKey(now - 86400000)]: [day(26), day(27, { m: 'Seed-2.1-Pro-0915', sid: 'sid-3' })]
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const chart = nodeFor('#chart');
    const bars = chart.descendants().filter((node) => (node.attributes.class || '').split(' ').includes('bar'));
    const gridLines = chart.descendants().filter((node) => (node.attributes.class || '').split(' ').includes('grid-line'));
    const axisLines = chart.descendants().filter((node) => (node.attributes.class || '').split(' ').includes('axis-line'));
    const hits = chart.descendants().filter((node) => (node.attributes.class || '').split(' ').includes('hit'));
    const detailHtml = nodeFor('#detail-rows').innerHTML;

    check('chart-has-grid-lines', gridLines.length === 5, 'got ' + gridLines.length);
    check('chart-has-axis-line', axisLines.length === 1, 'got ' + axisLines.length);
    check('chart-has-bars', bars.length >= 3, 'got ' + bars.length);
    check('chart-bars-visible', bars.every((node) => node.style.display !== 'none'), 'some bars hidden');
    check('chart-has-hits', hits.length >= 2, 'got ' + hits.length);
    check('detail-has-rows', (detailHtml.match(/<tr>/g) || []).length === 4, 'rows=' + (detailHtml.match(/<tr>/g) || []).length);
    check('detail-summary-count', nodeFor('#detail-summary').textContent.includes('4'), nodeFor('#detail-summary').textContent);
    // 4 条记录 × (100000 + 2000) = 408,000：副标题必须给出精确值，不能只有「40.8 万」
    check('kpi-token-exact-subtitle', nodeFor('#kpi-grid').innerHTML.includes('408,000'), 'KPI 缺少精确 Token 总数');
    const old = now - 200 * 86400000;
    dispatch({ type: 'data', days: { [globalThis.TraeUsageLocalTime.dateKey(old)]: [day(200 * 24)] } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('recent-range-ends-today', nodeFor('#chart-empty').hidden === false, 'stale record appeared in recent range');
    check('heatmap-ends-today', !nodeFor('#heatmap').innerHTML.includes(globalThis.TraeUsageLocalTime.dateKey(old)), 'stale date in heatmap');
    dispatch({ type: 'data', days: { [globalThis.TraeUsageLocalTime.dateKey(now)]: [day(1, { m: '<b>Model & Co</b>' })] } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('model-name-escaped', nodeFor('#kpi-grid').innerHTML.includes('&lt;b&gt;Model &amp; Co&lt;/b&gt;')
      && nodeFor('#legend').innerHTML.includes('&lt;b&gt;Model &amp; Co&lt;/b&gt;'), 'model name was not escaped');
    check('no-console-error', before.length === 0, before.join(' | '));

    dispatch({ type: 'status', status: { parsedCount: 1, cdp: { connected: true, connectionCount: 2, targetResponseCount: 1 }, store: { lastRecordAt: now } } });
    check('health-shows-connection-count', nodeFor('#health-status').textContent.includes('2 个页面'), nodeFor('#health-status').textContent);
    dispatch({ type: 'status', status: { parsedCount: 1, cdp: { connected: true, connectionCount: 2, targets: [{ networkReady: true }, { networkReady: false }], targetResponseCount: 1 }, store: {} } });
    check('health-shows-network-pending', nodeFor('#health-status').textContent.includes('网络监听未就绪'), nodeFor('#health-status').textContent);
    dispatch({ type: 'reconcile', reconciliation: { alert: true, lastDrift: 1.23 } });
    check('drift-alert-visible', nodeFor('#health-banner').hidden === false && nodeFor('#health-banner').textContent.includes('1.23 积分'), nodeFor('#health-banner').textContent);
    dispatch({ type: 'reconcile', reconciliation: { alert: false, pendingDrift: 0.82 } });
    check('drift-pending-visible', nodeFor('#health-banner').hidden === false && nodeFor('#health-banner').textContent.includes('待下次检查确认'), nodeFor('#health-banner').textContent);
    dispatch({ type: 'status', status: { parsedCount: 1, cdp: { connected: false, connectionCount: 0, targetResponseCount: 1 }, store: {} } });
    check('connection-alert-priority', nodeFor('#health-banner').textContent.includes('未连接到调试端口 9222'), nodeFor('#health-banner').textContent);
    dispatch({ type: 'status', status: { parsedCount: 0, cdp: { connected: true, connectionCount: 2, targetResponseCount: 1 }, store: {} } });
    check('parse-alert-priority', nodeFor('#health-banner').textContent.includes('一条都没解析成功'), nodeFor('#health-banner').textContent);

    // 空数据不应抛异常，且空态提示应显示
    dispatch({ type: 'data', days: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('empty-state-does-not-throw', before.length === 0, before.join(' | '));
    check('empty-state-shows-hint', nodeFor('#chart-empty').hidden === false, 'hidden=' + nodeFor('#chart-empty').hidden);

    // 重新灌数据，然后把所有已绑定的事件处理器都触发一遍。
    // 目的：捕获「处理器里调用了不存在的函数」这一类运行时错误
    // （第四轮的 resetView 就是这种，静态语法检查完全看不出来）。
    dispatch({
      type: 'data',
      days: {
        [globalThis.TraeUsageLocalTime.dateKey(now)]: [day(1), day(2, { cr: 2.5, sid: 'sid-2' })],
        [globalThis.TraeUsageLocalTime.dateKey(now - 86400000)]: [day(26), day(27, { m: 'Seed-2.1-Pro-0915', sid: 'sid-3' })]
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const errorsBefore = before.length;
    const fakeEvent = {
      clientX: 400,
      clientY: 200,
      deltaY: -100,
      pointerId: 1,
      preventDefault() {},
      stopPropagation() {},
      target: { value: '7' },
      currentTarget: { value: '7' }
    };
    let handlerCount = 0;
    registry.forEach((node, selector) => {
      Object.keys(node.listeners).forEach((name) => {
        node.listeners[name].forEach((handler) => {
          handlerCount += 1;
          try {
            handler(fakeEvent);
          } catch (error) {
            before.push(selector + ':' + name + ' -> ' + (error && error.message ? error.message : String(error)));
          }
        });
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('handlers-bound', handlerCount >= 10, 'got ' + handlerCount);
    check('handlers-do-not-throw', before.length === errorsBefore, before.slice(errorsBefore).join(' | '));
  } catch (error) {
    failures.push('render-threw');
    console.log('FAIL render-threw :: ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' / ') : String(error)));
  }

  console.error = originalError;
  console.log(failures.length === 0 ? 'RENDER OK' : 'RENDER FAILED ' + failures.length);
  process.exitCode = failures.length === 0 ? 0 : 1;
})();
