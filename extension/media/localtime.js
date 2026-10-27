(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraeUsageLocalTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function pad2(value) { return String(value).padStart(2, '0'); }
  function dateKey(timestamp) {
    const date = new Date(timestamp);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }
  function dateFromKey(key) { return new Date(String(key) + 'T12:00:00'); }
  function addDays(date, days) {
    const copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + days);
    return copy;
  }
  function dayTitle(key) {
    const date = dateFromKey(key);
    return date.getFullYear() + '\u5e74' + (date.getMonth() + 1) + '\u6708' + date.getDate() + '\u65e5';
  }
  return { dateKey, dateFromKey, addDays, dayTitle, pad2 };
});
