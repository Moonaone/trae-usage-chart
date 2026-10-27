(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraeUsageChartLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function valueOf(slot, group) {
    if (!slot || !slot.values || typeof slot.values.get !== 'function') return 0;
    const value = Number(slot.values.get(group));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function layoutBars(slots, groups, top, plot) {
    const rows = Array.isArray(slots) ? slots : [];
    const names = Array.isArray(groups) ? groups : [];
    const maximum = finite(top, 0);
    const width = finite(plot && plot.width, 0);
    const height = finite(plot && plot.height, 0);
    const left = finite(plot && plot.left, 0);
    const upper = finite(plot && plot.top, 0);
    if (!rows.length || maximum <= 0 || width <= 0 || height <= 0) return [];
    const slot = width / rows.length;
    const barWidth = Math.min(46, Math.max(4, slot * 0.66));
    const result = [];
    rows.forEach((row, slotIndex) => {
      let bottom = upper + height;
      names.forEach((group, groupIndex) => {
        const barHeight = (valueOf(row, group) / maximum) * height;
        if (!(barHeight > 0)) return;
        const x = left + slot * slotIndex + Math.max(2, (slot - barWidth) / 2);
        const y = bottom - barHeight;
        result.push({ slotIndex, groupIndex, x, y, width: barWidth, height: barHeight, visible: true });
        bottom = y;
      });
    });
    return result;
  }

  function layoutLines(slots, groups, top, plot) {
    const rows = Array.isArray(slots) ? slots : [];
    const names = Array.isArray(groups) ? groups : [];
    const maximum = finite(top, 0);
    const width = finite(plot && plot.width, 0);
    const height = finite(plot && plot.height, 0);
    const left = finite(plot && plot.left, 0);
    const upper = finite(plot && plot.top, 0);
    if (!rows.length || maximum <= 0 || width <= 0 || height <= 0) return { lines: [], points: [] };
    const slot = width / rows.length;
    const lines = [];
    const points = [];
    names.forEach((group, groupIndex) => {
      const linePoints = rows.map((row, slotIndex) => {
        const x = left + slot * slotIndex + slot / 2;
        const y = upper + height - (valueOf(row, group) / maximum) * height;
        const point = { slotIndex, groupIndex, x, y };
        points.push(point);
        return { x, y };
      });
      const d = linePoints.map((point, index) => (index === 0 ? 'M' : 'L') + ' ' + point.x.toFixed(2) + ' ' + point.y.toFixed(2)).join(' ');
      lines.push({ groupIndex, points: linePoints, d });
    });
    return { lines, points };
  }

  function axisText(value) {
    if (value >= 100000000) return (value / 100000000).toFixed(1) + '亿';
    if (value >= 10000) return (value / 10000).toFixed(1) + '万';
    return Math.round(value).toLocaleString('en-US');
  }

  function layoutAxis(top, plot) {
    const maximum = finite(top, 0) > 0 ? finite(top, 0) : 1;
    const upper = finite(plot && plot.top, 0);
    const height = Math.max(0, finite(plot && plot.height, 0));
    const gridLines = [];
    const ticks = [];
    for (let index = 0; index <= 5; index += 1) {
      const value = (maximum / 5) * index;
      const y = upper + height - (value / maximum) * height;
      gridLines.push({ y, isAxis: index === 0 });
      ticks.push({ y, text: axisText(value) });
    }
    return { gridLines, ticks };
  }

  return { layoutBars, layoutLines, layoutAxis };
});
