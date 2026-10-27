(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraeUsageMergePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function validRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && value.t !== null && value.t !== undefined && value.t !== ''
      && Number.isFinite(Number(value.t));
  }

  function signature(record) {
    return [record.m, record.p, record.c, record.ca, record.cr].join('|');
  }

  function credit(record) {
    return typeof record.cr === 'number' && Number.isFinite(record.cr) ? record.cr : -Infinity;
  }

  function mergeRecords(memoryRecords, diskRecords) {
    const records = [];
    const bySid = new Map();
    const sidless = new Set();
    let added = 0;
    let replaced = 0;
    function accept(record, fromDisk) {
      if (!validRecord(record)) return;
      const sid = record.sid === null || record.sid === undefined || record.sid === '' ? null : String(record.sid);
      if (sid !== null) {
        const index = bySid.get(sid);
        if (index !== undefined) {
          if (credit(record) > credit(records[index])) {
            records[index] = record;
            if (fromDisk) replaced += 1;
          }
          return;
        }
        bySid.set(sid, records.length);
      } else {
        const key = signature(record);
        if (sidless.has(key)) return;
        sidless.add(key);
      }
      records.push(record);
      if (fromDisk) added += 1;
    }
    if (Array.isArray(memoryRecords)) memoryRecords.forEach((record) => accept(record, false));
    if (Array.isArray(diskRecords)) diskRecords.forEach((record) => accept(record, true));
    return { records, added, replaced };
  }

  function isStaleLock(mtimeMs, nowMs, staleMs) {
    return Number.isFinite(mtimeMs) && Number.isFinite(nowMs)
      && Number.isFinite(staleMs) && staleMs >= 0 && nowMs - mtimeMs > staleMs;
  }

  return { mergeRecords, isStaleLock };
});
