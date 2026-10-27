(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraeUsageCdpPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 可接入的 target 类型。
  // 不含 worker / service_worker / shared_worker：实测这三类 target 会接受 WebSocket，
  // 但从不回应 Network.enable，导致连接永久挂起并占用名额，且从未产出过任何一条记录。
  // AI 请求的实际来源只有 page（IDE / Agent 窗口）与 webview。
  const ELIGIBLE_TYPES = ['page', 'webview', 'background_page'];

  // 越靠前越优先接入。连接数有上限，page（真正的 AI 页面）必须排在最前面，
  // 否则 target 一多，主窗口/Agent 会被 webview 挤掉且长期接不上。
  const TYPE_PRIORITY = ['page', 'webview', 'background_page'];

  const BACKOFF_BASE_MS = 5000;
  const BACKOFF_MAX_MS = 120000;

  function isEligibleTarget(target) {
    if (!target || typeof target !== 'object') return false;
    if (!ELIGIBLE_TYPES.includes(target.type)) return false;
    const url = target.webSocketDebuggerUrl;
    return typeof url === 'string' && url.trim().length > 0;
  }

  function priorityOf(target) {
    const index = target && TYPE_PRIORITY.indexOf(target.type);
    return index === undefined || index < 0 ? TYPE_PRIORITY.length : index;
  }

  function sortTargetsByPriority(list) {
    const rows = Array.isArray(list) ? list : [];
    return rows.slice().sort((a, b) => priorityOf(a) - priorityOf(b));
  }

  // 连续失败后指数退避，避免某个 target 长期连不上时每 3 秒重试刷屏。
  function nextBackoffDelay(failureCount) {
    const count = Number.isFinite(failureCount) && failureCount > 0 ? Math.floor(failureCount) : 1;
    const exponent = Math.min(count - 1, 5);
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, exponent));
  }

  // requestId 只在单个 target 内唯一（workbench 是 35096.N，Agent 是 42132.N），
  // 所以每个连接必须持有独立实例；共享一份会把两个 target 的合法记录互相误判为重复。
  function createRequestTracker(limit) {
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1000;
    const seen = new Set();
    const order = [];
    return {
      remember(id) {
        const key = String(id);
        if (seen.has(key)) return false;
        seen.add(key);
        order.push(key);
        while (order.length > max) seen.delete(order.shift());
        return true;
      },
      has(id) {
        return seen.has(String(id));
      },
      size() {
        return seen.size;
      }
    };
  }

  return {
    ELIGIBLE_TYPES,
    TYPE_PRIORITY,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    isEligibleTarget,
    sortTargetsByPriority,
    nextBackoffDelay,
    createRequestTracker
  };
});