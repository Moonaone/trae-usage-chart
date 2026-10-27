(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraeUsageZoom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function integer(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.floor(number) : fallback;
  }

  function clampWindow(start, size, total, minSize) {
    const count = Math.max(0, integer(total, 0));
    if (count <= 0) return { start: 0, size: 0 };
    const minimum = Math.min(count, Math.max(1, integer(minSize, 1)));
    const windowSize = Math.min(count, Math.max(minimum, integer(size, count)));
    const position = Math.min(count - windowSize, Math.max(0, integer(start, 0)));
    return { start: position, size: windowSize };
  }

  function panWindow(view, delta, total, minSize) {
    const current = clampWindow(view && view.start, view && view.size, total, minSize);
    const shift = Number.isFinite(Number(delta)) ? Math.round(Number(delta)) : 0;
    return clampWindow(current.start + shift, current.size, total, minSize);
  }

  function zoomWindow(view, anchorRatio, factor, total, minSize) {
    const current = clampWindow(view && view.start, view && view.size, total, minSize);
    if (current.size <= 0) return current;
    const ratio = Math.min(1, Math.max(0, Number.isFinite(Number(anchorRatio)) ? Number(anchorRatio) : 0.5));
    const scale = Number.isFinite(Number(factor)) && Number(factor) > 0 ? Number(factor) : 1;
    const anchor = Math.floor(current.start + ratio * current.size);
    const rawSize = current.size / scale;
    const nextSize = Math.max(1, scale < 1 && rawSize > current.size ? Math.ceil(rawSize) : Math.round(rawSize));
    const nextStart = anchor - Math.floor(ratio * nextSize);
    return clampWindow(nextStart, nextSize, total, minSize);
  }

  function windowSlice(view, total) {
    const count = Math.max(0, integer(total, 0));
    if (count <= 0) return { from: 0, to: -1, count: 0 };
    const current = clampWindow(view && view.start, view && view.size, count, 1);
    const from = Math.floor(current.start);
    const to = Math.min(count - 1, Math.ceil(current.start + current.size) - 1);
    return { from, to: Math.max(from, to), count: Math.max(0, Math.max(from, to) - from + 1) };
  }

  return { clampWindow, panWindow, zoomWindow, windowSlice };
});
