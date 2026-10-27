'use strict';

// 多 target 采集说明：
// Trae 的「IDE 模式」和「Agent 模式」是两个独立的 CDP page target
//   IDE   -> .../workbench/workbench.html
//   Agent -> .../solo/solo-lite.html
// Network.enable 只在单个 target 内生效，因此必须逐个连接。
// 新 target 的出现/消失用浏览器级 Target.setDiscoverTargets 事件发现，**不做轮询**。
// requestId 只在单个 target 内唯一（workbench 是 35096.N，Agent 是 42132.N），
// 所以去重表必须按连接隔离，不能做成全局集合。

const http = require('http');
const {
  isEligibleTarget,
  sortTargetsByPriority,
  nextBackoffDelay,
  createRequestTracker
} = require('./media/cdpPolicy.js');

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;
const HTTP_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REQUEST_IDS = 1000;
const MAX_PENDING_TARGETS = 200;
const MAX_CONNECTIONS = 10;
const BODY_RETRY_DELAYS = [150, 400, 800];
const SYNC_DELAY_MS = 3000;
const TARGET_PARTS = ['get_session_usage', 'icubeGetCreditsUsageInfo'];

const state = {
  running: false,
  output: undefined,
  onPayload: undefined,
  browser: undefined,
  browserWs: undefined,
  browserConnected: false,
  browserNextId: 1,
  browserPending: new Map(),
  discoveryEnabled: false,
  connections: new Map(),
  skippedTargets: new Set(),
  targetFailures: new Map(),
  targetList: [],
  capturedUrls: [],
  lastError: undefined,
  retryTimer: undefined,
  retryDelay: 5000,
  syncTimer: undefined,
  syncTimerAt: 0
};

function log(message, error) {
  if (!state.output) return;
  const detail = error ? (error instanceof Error ? error.message : String(error)) : '';
  state.output.appendLine(`[cdp] ${message}${detail ? `: ${detail}` : ''}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: CDP_HOST, port: CDP_PORT, path: pathname }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} ${pathname}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(HTTP_TIMEOUT_MS, () => request.destroy(new Error(`CDP HTTP timeout after ${HTTP_TIMEOUT_MS}ms`)));
    request.on('error', reject);
  });
}

function isTargetUrl(url) {
  return TARGET_PARTS.some((part) => url.includes(part));
}

const isMonitored = isEligibleTarget;

function addCapturedUrl(url) {
  state.capturedUrls.push(url);
  if (state.capturedUrls.length > 10) state.capturedUrls.shift();
}

function addSocketListener(socket, name, handler) {
  if (socket && typeof socket.addEventListener === 'function') socket.addEventListener(name, handler);
  else if (socket) socket[`on${name}`] = handler;
}

function rememberRequestId(conn, requestId) {
  return conn.requests.remember(requestId);
}

// ---------- 单个 target 连接 ----------

function createConnection(target) {
  return {
    key: String(target.id || target.webSocketDebuggerUrl || target.url),
    targetId: String(target.id || ''),
    type: target.type,
    title: target.title,
    url: target.url,
    ws: undefined,
    connected: false,
    networkReady: false,
    connecting: false,
    nextCommandId: 1,
    pending: new Map(),
    pendingTargets: new Map(),
    requests: createRequestTracker(MAX_REQUEST_IDS),
    targetResponseCount: 0,
    lastError: undefined
  };
}

const COMMAND_TIMEOUT_MS = 8000;

function sendCommand(conn, method, params) {
  if (!conn.ws || conn.ws.readyState !== 1) return Promise.reject(new Error('CDP WebSocket is not open'));
  const id = conn.nextCommandId;
  conn.nextCommandId += 1;
  return new Promise((resolve, reject) => {
    // 没有超时的话，一个「接受 socket 但永不回包」的 target 会把 Promise 永久挂起：
    // 连接既不报错也不释放，networkReady 永远为 false，还会占满连接名额。
    const timer = setTimeout(() => {
      if (!conn.pending.has(id)) return;
      conn.pending.delete(id);
      reject(new Error(`CDP 命令超时 ${COMMAND_TIMEOUT_MS}ms: ${method}`));
    }, COMMAND_TIMEOUT_MS);
    conn.pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); }
    });
    try {
      conn.ws.send(JSON.stringify({ id, method, params: params || {} }));
    } catch (error) {
      conn.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function rejectPending(conn, error) {
  for (const entry of conn.pending.values()) entry.reject(error);
  conn.pending.clear();
}

async function captureBody(conn, requestId, url, attempt) {
  let result;
  try {
    result = await sendCommand(conn, 'Network.getResponseBody', { requestId });
  } catch (error) {
    if (attempt < BODY_RETRY_DELAYS.length) {
      await delay(BODY_RETRY_DELAYS[attempt]);
      return captureBody(conn, requestId, url, attempt + 1);
    }
    throw error;
  }
  const bodyValue = result?.body;
  let bodyText;
  let bytes;
  if (result?.base64Encoded) {
    const buffer = Buffer.from(String(bodyValue || ''), 'base64');
    bytes = buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      log(`[capture] ${url} ${bytes} bytes（超过 512KB，已丢弃）`);
      return;
    }
    bodyText = buffer.toString('utf8');
  } else {
    bodyText = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue ?? null);
    bytes = Buffer.byteLength(bodyText, 'utf8');
    if (bytes > MAX_BODY_BYTES) {
      log(`[capture] ${url} ${bytes} bytes（超过 512KB，已丢弃）`);
      return;
    }
  }
  log(`[capture] ${conn.title} ${url} ${bytes}`);
  if (typeof state.onPayload === 'function') {
    await state.onPayload({ url, requestId, bytes, bodyText });
  }
}

function handleResponseReceived(conn, message) {
  try {
    const params = message && message.params;
    const response = params && params.response;
    const url = String(response?.url || '');
    if (!url || !isTargetUrl(url)) return;
    const requestId = String(params?.requestId || '');
    if (!requestId || !rememberRequestId(conn, requestId)) return;
    conn.targetResponseCount += 1;
    addCapturedUrl(url);
    const type = String(params?.type || '');
    const status = Number(response?.status || 0);
    if (type === 'Preflight') {
      log(`[skip] type=Preflight ${url}`);
      return;
    }
    conn.pendingTargets.set(requestId, url);
    log(`[queue] ${conn.title} type=${type} status=${status} mime=${String(response?.mimeType || '')} ${url}`);
    while (conn.pendingTargets.size > MAX_PENDING_TARGETS) {
      conn.pendingTargets.delete(conn.pendingTargets.keys().next().value);
    }
  } catch (error) {
    log('处理目标响应失败', error);
  }
}

async function handleLoadingFinished(conn, message) {
  const requestId = String((message?.params?.requestId) || '');
  if (!requestId) return;
  const url = conn.pendingTargets.get(requestId);
  if (!url) return;
  conn.pendingTargets.delete(requestId);
  try {
    await captureBody(conn, requestId, url, 0);
  } catch (error) {
    log(`[miss] ${conn.title} ${url} ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleMessage(conn, event) {
  try {
    const raw = event && event.data !== undefined ? event.data : event;
    if (typeof raw !== 'string') return;
    if (raw.indexOf('"id":') === -1
      && raw.indexOf('responseReceived') === -1
      && raw.indexOf('loadingFinished') === -1
      && raw.indexOf('loadingFailed') === -1) return;
    const message = JSON.parse(raw);
    if (message.id !== undefined) {
      const pending = conn.pending.get(message.id);
      if (!pending) return;
      conn.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Network.responseReceived') handleResponseReceived(conn, message);
    else if (message.method === 'Network.loadingFinished') void handleLoadingFinished(conn, message);
    else if (message.method === 'Network.loadingFailed') {
      const failedId = String(message?.params?.requestId || '');
      if (conn.pendingTargets.delete(failedId)) {
        log(`[abort] ${conn.title} ${failedId} ${String(message?.params?.errorText || '')}`);
      }
    }
  } catch (error) {
    log('解析 CDP 消息失败', error);
  }
}

function handleSocketClosed(conn) {
  conn.connected = false;
  conn.networkReady = false;
  conn.ws = undefined;
  conn.pendingTargets.clear();
  rejectPending(conn, new Error('CDP WebSocket closed'));
  if (state.connections.get(conn.key) !== conn) return;
  // 必须从连接表移除，否则 syncTargets 会认为「已存在」而永不重连
  state.connections.delete(conn.key);
  const failure = noteTargetFailure(conn.key);
  if (failure.count === 1 || failure.count % 5 === 0) {
    log(`[close] ${conn.title} 连接已断开（连续第 ${failure.count} 次，${failure.delay}ms 后再试）`);
  }
  scheduleSync(Math.min(failure.delay, SYNC_DELAY_MS));
}

function connectTarget(target) {
  const key = String(target.id || target.webSocketDebuggerUrl || target.url);
  if (state.connections.has(key)) return;
  const failure = state.targetFailures.get(key);
  if (failure) {
    const remaining = failure.nextAttemptAt - Date.now();
    if (remaining > 0) {
      // 退避中：安排到退避结束时刻再同步一次，期间不再反复重试
      scheduleSync(remaining);
      return;
    }
  }
  if (state.connections.size >= MAX_CONNECTIONS) {
    if (!state.skippedTargets.has(key)) {
      state.skippedTargets.add(key);
      log(`[skip] 连接上限 ${MAX_CONNECTIONS}，忽略 type=${target.type} title=${target.title}`);
    }
    return;
  }
  state.skippedTargets.delete(key);
  if (typeof WebSocket !== 'function') {
    log('运行时没有可用的全局 WebSocket，放弃 CDP 连接');
    return;
  }
  const conn = createConnection(target);
  state.connections.set(key, conn);
  log(`[target] 接入 type=${target.type} title=${target.title}`);
  let socket;
  try {
    socket = new WebSocket(target.webSocketDebuggerUrl);
  } catch (error) {
    log(`[target] 创建 WebSocket 失败 ${target.title}`, error);
    state.connections.delete(key);
    noteTargetFailure(key);
    scheduleSync();
    return;
  }
  conn.ws = socket;
  addSocketListener(socket, 'open', () => {
    if (!state.running || conn.ws !== socket) return;
    conn.networkReady = false;
    void sendCommand(conn, 'Network.enable', {}).then(() => {
      if (!state.running || state.connections.get(key) !== conn || conn.ws !== socket) return;
      conn.connected = true;
      conn.networkReady = true;
      conn.lastError = undefined;
      clearTargetFailure(key);
      state.retryDelay = 5000;
    }).catch((error) => {
      if (!state.running || state.connections.get(key) !== conn) return;
      conn.lastError = error instanceof Error ? error.message : String(error);
      state.lastError = conn.lastError;
      log(`Network.enable 失败 ${conn.title}`, error);
      state.connections.delete(key);
      conn.connected = false;
      conn.networkReady = false;
      rejectPending(conn, error);
      const failure = noteTargetFailure(key);
      try { socket.close(); } catch {}
      scheduleSync(Math.min(failure.delay, SYNC_DELAY_MS));
    });
  });
  addSocketListener(socket, 'message', (event) => handleMessage(conn, event));
  addSocketListener(socket, 'error', (error) => {
    conn.lastError = error instanceof Error ? error.message : String(error);
    log(`WebSocket 错误 ${conn.title}`, error);
  });
  addSocketListener(socket, 'close', () => handleSocketClosed(conn));
}

// ---------- 目标发现（浏览器级事件，不轮询） ----------

function scheduleSync(delayMs) {
  if (!state.running) return;
  const delay = Math.max(0, typeof delayMs === 'number' && Number.isFinite(delayMs) ? delayMs : SYNC_DELAY_MS);
  const at = Date.now() + delay;
  // 已经有更早的计划就保留，避免退避中的长延时把正常的短延时挤掉
  if (state.syncTimer && state.syncTimerAt <= at) return;
  if (state.syncTimer) clearTimeout(state.syncTimer);
  state.syncTimerAt = at;
  state.syncTimer = setTimeout(() => {
    state.syncTimer = undefined;
    state.syncTimerAt = 0;
    void syncTargets();
  }, delay);
}

// 连接连续失败时退避，避免某个 target 长期连不上导致每 3 秒重试刷屏。
function noteTargetFailure(key) {
  const previous = state.targetFailures.get(key);
  const count = (previous ? previous.count : 0) + 1;
  const delay = nextBackoffDelay(count);
  state.targetFailures.set(key, { count, nextAttemptAt: Date.now() + delay });
  return { count, delay };
}

function clearTargetFailure(key) {
  state.targetFailures.delete(key);
}

async function syncTargets() {
  if (!state.running) return;
  let targets;
  try {
    targets = await getJson('/json/list');
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    log('读取 target 列表失败', error);
    scheduleReconnect(error);
    return;
  }
  const list = Array.isArray(targets) ? targets : [];
  state.targetList = list.map((item) => ({ type: item?.type, url: item?.url, title: item?.title }));
  const alive = new Set();
  // 按优先级排序：page（主窗口 / Agent）永远排在 webview / worker 之前。
  // 否则 target 数量超过 MAX_CONNECTIONS 时，真正的 AI 页面可能被挤出且长期跳过。
  const eligible = sortTargetsByPriority(list.filter(isMonitored));
  eligible.forEach((target) => alive.add(String(target.id || target.webSocketDebuggerUrl || target.url)));
  for (const key of state.skippedTargets) if (!alive.has(key)) state.skippedTargets.delete(key);
  // target 真的消失了才清退避记录；退避中的 target 仍在 alive 里，必须保留计数
  for (const key of state.targetFailures.keys()) if (!alive.has(key)) clearTargetFailure(key);
  Array.from(state.connections.entries()).forEach(([key, conn]) => {
    if (alive.has(key)) return;
    log(`[target] 页面已关闭 ${conn.title}`);
    state.connections.delete(key);
    try { if (conn.ws) conn.ws.close(); } catch {}
  });
  eligible.forEach((target) => {
    const key = String(target.id || target.webSocketDebuggerUrl || target.url);
    const existing = state.connections.get(key);
    if (!existing) connectTarget(target);
    else {
      existing.title = target.title;
      existing.url = target.url;
    }
  });
  if (state.connections.size === 0) {
    log('暂无可监听的 target，稍后重试');
    scheduleReconnect(new Error('no monitored target'));
  }
}

function scheduleReconnect(reason) {
  if (!state.running || state.retryTimer) return;
  state.lastError = reason instanceof Error ? reason.message : String(reason || 'unknown');
  const delayMs = state.retryDelay;
  state.retryDelay = Math.min(60000, state.retryDelay * 2);
  log(`连接失败，${delayMs}ms 后重试`, reason);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = undefined;
    void connectBrowser();
    void syncTargets();
  }, delayMs);
}

function handleBrowserMessage(event) {
  try {
    const raw = event && event.data !== undefined ? event.data : event;
    if (typeof raw !== 'string') return;
    if (raw.indexOf('Target.') === -1) return;
    const message = JSON.parse(raw);
    if (message.id !== undefined) {
      const pending = state.browserPending.get(message.id);
      if (!pending) return;
      state.browserPending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetDestroyed'
      || message.method === 'Target.targetInfoChanged') {
      scheduleSync();
    }
  } catch (error) {
    log('解析 browser 事件失败', error);
  }
}

async function connectBrowser() {
  if (!state.running || state.browserConnected) return;
  let version;
  try {
    version = await getJson('/json/version');
  } catch (error) {
    scheduleReconnect(error);
    return;
  }
  state.browser = version?.Browser;
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl || typeof WebSocket !== 'function') return;
  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (error) {
    log('创建 browser WebSocket 失败', error);
    return;
  }
  state.browserWs = socket;
  addSocketListener(socket, 'open', () => {
    if (!state.running || state.browserWs !== socket) return;
    state.browserConnected = true;
    state.retryDelay = 5000;
    const id = state.browserNextId;
    state.browserNextId += 1;
    try {
      socket.send(JSON.stringify({ id, method: 'Target.setDiscoverTargets', params: { discover: true } }));
      state.discoveryEnabled = true;
      log('[discovery] 已开启目标发现');
    } catch (error) {
      log('开启目标发现失败', error);
    }
  });
  addSocketListener(socket, 'message', handleBrowserMessage);
  addSocketListener(socket, 'close', () => {
    state.browserConnected = false;
    state.discoveryEnabled = false;
    state.browserWs = undefined;
    if (!state.running) return;
    // 必须主动重连：发现通道断了之后，新开的 Agent / 窗口不会再产生任何事件，
    // 而既有 page 连接仍在工作，表面上"一切正常"，实际已静默失明。
    log('[discovery] browser 连接已断开，准备重连');
    scheduleReconnect(new Error('browser websocket closed'));
  });
  addSocketListener(socket, 'error', () => {});
}

// ---------- 生命周期 ----------

async function start(options = {}) {
  if (state.running) return;
  state.running = true;
  state.output = options.output;
  state.onPayload = options.onPayload;
  state.retryDelay = 5000;
  state.targetFailures.clear();
  state.skippedTargets.clear();
  await connectBrowser();
  await syncTargets();
}

async function stop() {
  state.running = false;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  if (state.syncTimer) clearTimeout(state.syncTimer);
  state.retryTimer = undefined;
  state.syncTimer = undefined;
  state.syncTimerAt = 0;
  state.targetFailures.clear();
  state.skippedTargets.clear();
  Array.from(state.connections.values()).forEach((conn) => {
    conn.connected = false;
    conn.networkReady = false;
    rejectPending(conn, new Error('CDP collector stopped'));
    try { if (conn.ws) conn.ws.close(); } catch {}
  });
  state.connections.clear();
  state.skippedTargets.clear();
  state.browserConnected = false;
  state.discoveryEnabled = false;
  const browserSocket = state.browserWs;
  state.browserWs = undefined;
  try { if (browserSocket) browserSocket.close(); } catch {}
}

function getStatus() {
  const targets = Array.from(state.connections.values()).map((conn) => ({
    type: conn.type,
    title: conn.title,
    url: conn.url,
    connected: conn.connected,
    networkReady: conn.networkReady,
    targetResponseCount: conn.targetResponseCount,
    lastError: conn.lastError,
    pendingTargetCount: conn.pendingTargets.size
  }));
  return {
    browser: state.browser,
    target: targets[0],
    targets,
    targetList: state.targetList.slice(),
    connectionCount: targets.length,
    discoveryEnabled: state.discoveryEnabled,
    connected: targets.some((item) => item.connected),
    targetResponseCount: targets.reduce((sum, item) => sum + item.targetResponseCount, 0),
    capturedUrls: state.capturedUrls.slice(),
    lastError: state.lastError,
    pendingTargetCount: targets.reduce((sum, item) => sum + item.pendingTargetCount, 0)
  };
}

module.exports = { start, stop, getStatus };
