(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraeUsageReconcile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function computeOffset(used, creditsSum) {
    if (!Number.isFinite(used) || !Number.isFinite(creditsSum)) return null;
    const offset = used - creditsSum;
    return Number.isFinite(offset) ? offset : null;
  }

  function computeDrift(used, creditsSum, baseline) {
    const offset = computeOffset(used, creditsSum);
    if (offset === null) return { offset: null, drift: null, hasBaseline: Boolean(baseline) };
    if (baseline === null || baseline === undefined || !Number.isFinite(baseline)) {
      return { offset, drift: null, hasBaseline: false };
    }
    const drift = offset - baseline;
    return { offset, drift: Number.isFinite(drift) ? drift : null, hasBaseline: true };
  }

  function needsAlert(drift, threshold) {
    return Number.isFinite(drift) && Number.isFinite(threshold) && drift > threshold;
  }

  function confirmAlert(drift, pendingDrift, threshold) {
    if (!needsAlert(drift, threshold)) return { alert: false, pendingDrift: null };
    if (needsAlert(pendingDrift, threshold)) return { alert: true, pendingDrift: null };
    return { alert: false, pendingDrift: drift };
  }

  // 负漂移意味着「本库记录比基线预期更多」，典型来源是补录历史数据。
  // 此时必须把基线追平，否则这份多出来的量会永久吃掉同额的告警灵敏度
  // （例如补进 33.10 后，要真的丢 33.60 才会报警）。
  // 阈值取 5 而非 0：账户 used 存在服务端多实例导致的陈旧值抖动（实测出现过 2.2 的来回跳）。
  function shouldRebaseline(drift, threshold) {
    return Number.isFinite(drift) && Number.isFinite(threshold) && drift < -threshold;
  }

  return { computeOffset, computeDrift, needsAlert, confirmAlert, shouldRebaseline };
});
