'use strict';

const fs = require('fs');
const path = require('path');
const { dateKey } = require('./media/localtime.js');
const { mergeRecords, isStaleLock } = require('./media/mergePolicy.js');

const fsp = fs.promises;
const FLUSH_DELAY_MS = 5000;
const MAX_DAYS = 90;
const MAX_RECORDS = 5000;
const SIGNATURE_DEDUPE_MS = 2000;
const LOCK_STALE_MS = 10000;

let context;
let output;
let usagePath;
let lockPath;
let lockOwner;
let historyPath;
let rawSamplePath;
let data = { v: 1, days: {} };
let dirty = false;
let dirtyVersion = 0;
let pendingCount = 0;
let flushTimer;
let flushInFlight;
let rawSamples = [];
let rawWriteChain = Promise.resolve();
let recentSignatures = new Map();
let sidFingerprints = new Set();
let sidlessFingerprints = new Set();
let onChange;

function log(message, error) {
  if (!output) return;
  const detail = error && error.stack ? error.stack : String(error || '');
  output.appendLine(`[store] ${message}${detail ? `: ${detail}` : ''}`);
}

function validData(value) {
  if (!value || typeof value !== 'object' || !value.days || typeof value.days !== 'object') {
    return { v: 1, days: {} };
  }
  const days = {};
  for (const [day, records] of Object.entries(value.days)) {
    if (Array.isArray(records)) days[day] = records.filter((record) => record && typeof record === 'object');
  }
  return { v: 1, days };
}

function isDataRoot(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.days && typeof value.days === 'object' && !Array.isArray(value.days));
}

function corruptFilePath() {
  const date = new Date();
  const stamp = date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0') + '-' + String(date.getHours()).padStart(2, '0') + String(date.getMinutes()).padStart(2, '0') + String(date.getSeconds()).padStart(2, '0');
  return `${usagePath}.corrupt-${stamp}`;
}

// dispose() 在退出时可能仍有未落盘数据（例如锁争用超时、随后立刻重载窗口）。
// 那种情况落盘只是「稍后重试」，而宿主退出会清掉重试定时器，记录将永久丢失。
// 因此 dispose() 会同步写出一份每宿主独立的 pending-*.json，这里在启动时并回。
async function mergeRecoveryFiles() {
  const dir = context.globalStorageUri.fsPath;
  let names;
  try {
    names = (await fsp.readdir(dir)).filter((name) => name.startsWith('pending-') && name.endsWith('.json'));
  } catch (error) {
    log('扫描退出恢复文件失败', error);
    return 0;
  }
  let adopted = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const parsed = JSON.parse(await fsp.readFile(full, 'utf8'));
      if (!isDataRoot(parsed)) throw new Error('结构无效');
      const incoming = Object.values(validData(parsed).days).flat();
      const current = Object.values(data.days).flat();
      const result = mergeRecords(current, incoming);
      const days = {};
      result.records.forEach((record) => {
        const key = dateKey(Number(record.t));
        if (!Array.isArray(days[key])) days[key] = [];
        days[key].push(record);
      });
      data = { v: 1, days };
      adopted += result.added + result.replaced;
      await fsp.rm(full, { force: true });
      log(`[recovery] 已合并退出恢复文件 ${name}：新增 ${result.added} 条，取大替换 ${result.replaced} 条`);
    } catch (error) {
      log(`[recovery] 合并 ${name} 失败`, error);
    }
  }
  return adopted;
}

async function init(extensionContext, channel) {
  context = extensionContext;
  output = channel;
  usagePath = path.join(context.globalStorageUri.fsPath, 'usage.json');
  lockPath = path.join(context.globalStorageUri.fsPath, 'usage.json.lock');
  lockOwner = undefined;
  historyPath = path.join(context.globalStorageUri.fsPath, 'history.json');
  rawSamplePath = path.join(context.globalStorageUri.fsPath, 'raw-sample.json');
  data = { v: 1, days: {} };
  dirty = false;
  dirtyVersion = 0;
  pendingCount = 0;
  rawSamples = [];
  rawWriteChain = Promise.resolve();
  recentSignatures = new Map();

  try {
    await fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  } catch (error) {
    log('创建存储目录失败', error);
  }

  let recovered = false;
  try {
    const text = await fsp.readFile(usagePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!isDataRoot(parsed)) throw new Error('usage.json 结构无效');
    data = validData(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // 主文件不存在有两种可能：真的首次运行，或上次落盘在
      // rm(usage.json) 与 rename(.tmp -> usage.json) 之间被打断
      // （Windows 上 rename 可能因杀软/索引器占用而抛 EPERM）。
      // 不能直接建空账本，必须先尝试把残留的完整副本捞回来。
      data = null;
      const candidates = [
        [`${usagePath}.tmp`, '上次落盘中断留下的 .tmp'],
        [`${usagePath}.bak`, '上一次成功落盘的 .bak']
      ];
      for (const [candidate, label] of candidates) {
        try {
          const parsed = JSON.parse(await fsp.readFile(candidate, 'utf8'));
          if (!isDataRoot(parsed)) throw new Error('结构无效');
          data = validData(parsed);
          log(`[recovery] usage.json 缺失，已从 ${label} 恢复`);
          recovered = true;
          break;
        } catch (candidateError) {
          if (!candidateError || candidateError.code !== 'ENOENT') {
            log(`[recovery] 尝试 ${label} 失败`, candidateError);
          }
        }
      }
      if (data === null) {
        data = { v: 1, days: {} };
        log('[recovery] 无可用副本，建立新账本');
      }
    } else {
      log('读取 usage.json 失败', error);
      try {
        const backup = JSON.parse(await fsp.readFile(`${usagePath}.bak`, 'utf8'));
        if (!isDataRoot(backup)) throw new Error('usage.json.bak 结构无效');
        data = validData(backup);
        log('[recovery] 已从 usage.json.bak 恢复');
      } catch (backupError) {
        data = { v: 1, days: {} };
        log('[recovery] 备份恢复失败', backupError);
      }
      try {
        await fsp.rename(usagePath, corruptFilePath());
        log('[recovery] 已隔离损坏的 usage.json');
      } catch (renameError) {
        if (!renameError || renameError.code !== 'ENOENT') log('[recovery] 隔离损坏文件失败', renameError);
      }
      recovered = true;
    }
  }

  const exitCount = await mergeRecoveryFiles();
  const added = await mergeHistory();
  const cleaned = rebuildFingerprintIndexes();
  if (added > 0 || recovered || cleaned || exitCount > 0) {
    if (added > 0) log(`[history] 合并历史记录 ${added} 条`);
    if (cleaned) log('[twin] 启动自检清除了重复副本，已安排落盘');
    dirty = true;
    dirtyVersion += 1;
    await flush();
  }
}

function historyList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.records)) return parsed.records;
  return [];
}

async function mergeHistory() {
  let list;
  try {
    list = historyList(JSON.parse(await fsp.readFile(historyPath, 'utf8')));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') log('读取 history.json 失败', error);
    return 0;
  }
  const knownSids = new Set();
  const looseKeys = new Set();
  Object.values(data.days).forEach((records) => {
    records.forEach((record) => {
      if (!record || typeof record !== 'object') return;
      if (record.sid) knownSids.add(String(record.sid));
      else looseKeys.add(recordSignature(record));
    });
  });
  let added = 0;
  let adopted = 0;
  list.forEach((raw) => {
    if (!raw || typeof raw !== 'object' || !Number.isFinite(Number(raw.t))) return;
    const sid = raw.sid === null || raw.sid === undefined || raw.sid === '' ? null : String(raw.sid);
    if (sid && knownSids.has(sid)) return;
    const signature = recordSignature(raw);
    if (looseKeys.has(signature)) {
      // 账本里已有同内容的无 sid 副本。直接跳过会留下一条没有身份的记录：
      // 之后 CDP 抓到同一会话更高的 cr 快照时签名已变，无法再按 sid 桥接，
      // 两条会同时存在并重复计费。所以这里应当把 sid 补到那条记录上。
      if (sid && adoptSidBySignature(signature, sid)) {
        knownSids.add(sid);
        looseKeys.delete(signature);
        adopted += 1;
        log(`[history] 为同内容的无 sid 记录补回 sid=${sid}`);
      }
      return;
    }
    const key = dateKey(Number(raw.t));
    if (!Array.isArray(data.days[key])) data.days[key] = [];
    data.days[key].push({
      t: Number(raw.t),
      m: raw.m ?? null,
      p: raw.p ?? null,
      c: raw.c ?? null,
      ca: raw.ca ?? null,
      cr: raw.cr ?? null,
      s: raw.s ?? 'history',
      e: raw.e ?? null,
      sid
    });
    if (sid) knownSids.add(sid);
    else looseKeys.add(recordSignature(raw));
    added += 1;
  });
  if (added > 0 || adopted > 0) {
    Object.keys(data.days).forEach((key) => data.days[key].sort((a, b) => (a.t || 0) - (b.t || 0)));
  }
  return added + adopted;
}

// 把 sid 补到「内容完全相同、但没有身份」的那条记录上，返回是否成功。
function adoptSidBySignature(signature, sid) {
  for (const records of Object.values(data.days)) {
    for (const record of records) {
      if (record && !record.sid && recordSignature(record) === signature) {
        record.sid = sid;
        return true;
      }
    }
  }
  return false;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordSignature(record) {
  return [record.m, record.p, record.c, record.ca, record.cr].join('|');
}

function findBySid(sid) {
  for (const [day, records] of Object.entries(data.days)) {
    const index = records.findIndex((item) => item && item.sid === sid);
    if (index >= 0) return { day, index, record: records[index] };
  }
  return null;
}

// 同一次会话可能先以「无 sid」形态落盘（早期版本缺陷，或接口某次没返回 session_id），
// 之后同一会话带着 sid 再次被抓到。sid 去重接不上这两条记录，而 (m,p,c,ca,cr) 内容指纹
// 完全一致 —— 用它在两种形态之间做一次桥接，避免同一次会话被计两遍。
// 返回 true 表示清理过重复，调用方需要落盘。
function rebuildFingerprintIndexes() {
  sidFingerprints = new Set();
  sidlessFingerprints = new Set();
  Object.values(data.days).forEach((records) => {
    records.forEach((record) => {
      if (record && typeof record === 'object' && record.sid) sidFingerprints.add(recordSignature(record));
    });
  });
  let cleaned = false;
  Object.keys(data.days).forEach((day) => {
    const kept = [];
    data.days[day].forEach((record) => {
      if (!record || typeof record !== 'object') return;
      const fingerprint = recordSignature(record);
      if (isEmptyRecord(record)) {
        cleaned = true;
        log('[heal] 清除空会话记录（无模型、无积分、无 token）');
        return;
      }
      if (!record.sid) {
        if (sidFingerprints.has(fingerprint)) {
          cleaned = true;
          log('[twin] 启动自检清除同会话的无 sid 副本 signature=' + fingerprint);
          return;
        }
        sidlessFingerprints.add(fingerprint);
      }
      kept.push(record);
    });
    if (kept.length === 0) delete data.days[day];
    else data.days[day] = kept;
  });
  return cleaned;
}

function isEmptyRecord(record) {
  return record.m === null && record.cr === null
    && !(Number(record.p) > 0) && !(Number(record.c) > 0) && !(Number(record.ca) > 0);
}

function dropSidlessTwin(fingerprint) {
  for (const [day, records] of Object.entries(data.days)) {
    const index = records.findIndex((item) => item && !item.sid && recordSignature(item) === fingerprint);
    if (index < 0) continue;
    records.splice(index, 1);
    if (records.length === 0) delete data.days[day];
    return true;
  }
  return false;
}

function getSummary() {
  const todayKey = dateKey(Date.now());
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 6);
  const startKey = dateKey(cutoff.getTime());
  const summary = { todayCount: 0, todayTokens: null, todayCredits: null, todayCacheRate: null, recent7Tokens: null, recent7Credits: null, lastRecordAt: null };
  let todayTokens = 0;
  let recentTokens = 0;
  let todayCredits = 0;
  let recentCredits = 0;
  let todayTokenSeen = false;
  let recentTokenSeen = false;
  let todayCreditSeen = false;
  let recentCreditSeen = false;
  let todayPrompt = 0;
  let todayCached = 0;
  let todayPromptSeen = false;
  let todayCachedSeen = false;
  // Number(null) === 0 且 Number.isFinite(0) === true，所以直接用 Number() 会把
  // 「数值缺失」误当成「真的是 0」，让状态栏显示 0 积分 / 0 Token 而不是未知。
  // 必须要求字段本身就是有限数字。
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  Object.entries(data.days).forEach(([day, records]) => records.forEach((record) => {
    const timestamp = Number(record.t);
    if (Number.isFinite(timestamp) && (summary.lastRecordAt === null || timestamp > summary.lastRecordAt)) summary.lastRecordAt = timestamp;
    const hasToken = isNum(record.p) || isNum(record.c);
    if (day === todayKey) {
      summary.todayCount += 1;
      if (hasToken) { todayTokens += isNum(record.p) ? record.p : 0; todayTokens += isNum(record.c) ? record.c : 0; todayTokenSeen = true; }
      if (isNum(record.cr)) { todayCredits += record.cr; todayCreditSeen = true; }
      if (isNum(record.p)) { todayPrompt += record.p; todayPromptSeen = true; }
      if (isNum(record.ca)) { todayCached += record.ca; todayCachedSeen = true; }
    }
    if (day >= startKey && day <= todayKey) {
      if (hasToken) { recentTokens += isNum(record.p) ? record.p : 0; recentTokens += isNum(record.c) ? record.c : 0; recentTokenSeen = true; }
      if (isNum(record.cr)) { recentCredits += record.cr; recentCreditSeen = true; }
    }
  }));
  summary.todayTokens = todayTokenSeen ? todayTokens : null;
  summary.todayCredits = todayCreditSeen ? todayCredits : null;
  summary.todayCacheRate = todayPromptSeen && todayPrompt > 0 && todayCachedSeen ? (todayCached / todayPrompt) * 100 : null;
  summary.recent7Tokens = recentTokenSeen ? recentTokens : null;
  summary.recent7Credits = recentCreditSeen ? recentCredits : null;
  return summary;
}

function setOnChange(callback) {
  onChange = typeof callback === 'function' ? callback : undefined;
}
function markDirty() {
  dirty = true;
  dirtyVersion += 1;
  if (pendingCount >= 10) {
    void flush();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, FLUSH_DELAY_MS);
  }
}

function addRecord(record) {
  if (!record || !Number.isFinite(Number(record.t))) {
    log('忽略无效记录');
    return;
  }
  const normalized = {
    t: Number(record.t),
    m: record.m ?? null,
    p: record.p ?? null,
    c: record.c ?? null,
    ca: record.ca ?? null,
    cr: record.cr ?? null,
    s: record.s ?? 'cdp',
    e: record.e ?? null,
    sid: record.sid === null || record.sid === undefined || record.sid === '' ? null : String(record.sid)
  };
  const key = dateKey(normalized.t);
  const fingerprint = recordSignature(normalized);
  if (normalized.sid) {
    const existing = findBySid(normalized.sid);
    if (existing) {
      const oldCr = numberOrNull(existing.record.cr);
      const newCr = numberOrNull(normalized.cr);
      if (newCr !== null && (oldCr === null || newCr > oldCr)) {
        const oldFingerprint = recordSignature(existing.record);
        if (existing.day === key) data.days[existing.day][existing.index] = normalized;
        else {
          data.days[existing.day].splice(existing.index, 1);
          if (data.days[existing.day].length === 0) delete data.days[existing.day];
          if (!Array.isArray(data.days[key])) data.days[key] = [];
          data.days[key].push(normalized);
        }
        sidFingerprints.delete(oldFingerprint);
        sidFingerprints.add(fingerprint);
        log('[dup] sid=' + normalized.sid + ' old_cr=' + (oldCr ?? 'null') + ' new_cr=' + newCr + ' action=replace');
        pendingCount += 1;
        markDirty();
        return;
      }
      log('[dup] sid=' + normalized.sid + ' old_cr=' + (oldCr ?? 'null') + ' new_cr=' + (newCr ?? 'null') + ' action=drop');
      return;
    }
    if (sidlessFingerprints.has(fingerprint) && dropSidlessTwin(fingerprint)) {
      sidlessFingerprints.delete(fingerprint);
      log('[twin] 清除同会话的无 sid 副本 sid=' + normalized.sid + ' signature=' + fingerprint);
    }
    sidFingerprints.add(fingerprint);
  } else {
    if (sidFingerprints.has(fingerprint)) {
      log('[dup] 同会话已有带 sid 记录，丢弃无 sid 副本 signature=' + fingerprint + ' action=drop');
      return;
    }
    const now = Date.now();
    for (const [signature, item] of recentSignatures) if (now - item.t >= SIGNATURE_DEDUPE_MS) recentSignatures.delete(signature);
    const previous = recentSignatures.get(fingerprint);
    recentSignatures.set(fingerprint, { t: now, cr: normalized.cr });
    if (previous) {
      log('[dup] sid=null old_cr=' + (previous.cr ?? 'null') + ' new_cr=' + (normalized.cr ?? 'null') + ' action=drop');
      return;
    }
    sidlessFingerprints.add(fingerprint);
  }
  if (!Array.isArray(data.days[key])) data.days[key] = [];
  data.days[key].push(normalized);
  pendingCount += 1;
  markDirty();
}

function prune() {
  let removed = false;
  const keys = Object.keys(data.days).sort();
  const droppedDays = [];
  while (keys.length > MAX_DAYS) {
    const oldest = keys.shift();
    droppedDays.push(oldest);
    delete data.days[oldest];
    removed = true;
  }
  if (droppedDays.length) {
    // 裁掉历史是一次真实的数据损失，必须留痕，否则用户无法察觉
    log(`[prune] 超过 ${MAX_DAYS} 天上限，删除最旧日期：${droppedDays.join('、')}`);
  }

  let total = Object.values(data.days).reduce((sum, records) => sum + records.length, 0);
  while (total > MAX_RECORDS) {
    const oldest = Object.keys(data.days).sort()[0];
    if (!oldest) break;
    // 必须先按时间排序再裁：同 sid 的快照更新是「原位替换」，
    // 数组位置不一定等于时间先后，直接按位置 slice 可能删掉较新的记录。
    data.days[oldest] = data.days[oldest].slice().sort((a, b) => (a.t || 0) - (b.t || 0));
    const records = data.days[oldest];
    const removeCount = Math.min(records.length, total - MAX_RECORDS);
    if (removeCount >= records.length) {
      delete data.days[oldest];
    } else {
      data.days[oldest] = records.slice(removeCount);
    }
    total -= removeCount;
    removed = true;
    log(`[prune] 超过 ${MAX_RECORDS} 条上限，从 ${oldest} 删除最旧的 ${removeCount} 条`);
  }
  if (removed) rebuildFingerprintIndexes();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(maxAttempts = 8, waitMs = 40) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let handle;
    try {
      handle = await fsp.open(lockPath, 'wx');
      const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      await handle.writeFile(owner, 'utf8');
      await handle.close();
      lockOwner = owner;
      return true;
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch {}
        try { await fsp.rm(lockPath, { force: true }); } catch {}
        log('[lock] 创建锁文件失败', error);
        return false;
      }
      if (!error || error.code !== 'EEXIST') {
        log('[lock] 获取锁失败', error);
        return false;
      }
      try {
        const stat = await fsp.stat(lockPath);
        if (isStaleLock(stat.mtimeMs, Date.now(), LOCK_STALE_MS)) {
          // 用 rename 抢占陈旧锁：rename 是原子的，两个清理者里只有一个能成功
          // 移动同一个文件。若直接 rm，B 可能删掉 A 刚重建的新锁，形成双持锁。
          const claim = `${lockPath}.stale-${process.pid}-${Date.now()}`;
          try {
            await fsp.rename(lockPath, claim);
            await fsp.rm(claim, { force: true });
            log('[lock] 已清理超过 10 秒的陈旧锁');
          } catch (claimError) {
            if (!claimError || claimError.code !== 'ENOENT') log('[lock] 回收陈旧锁失败', claimError);
          }
          continue;
        }
      } catch (readError) {
        if (readError && readError.code === 'ENOENT') continue;
        log('[lock] 检查锁文件失败', readError);
      }
      if (attempt < maxAttempts - 1) await delay(waitMs);
    }
  }
  log('[lock] 争用超时，保留待落盘数据');
  return false;
}

async function releaseLock() {
  const owner = lockOwner;
  lockOwner = undefined;
  if (!owner) return;
  try {
    const current = await fsp.readFile(lockPath, 'utf8');
    if (current !== owner) {
      log('[lock] 锁所有者已变化，跳过释放');
      return;
    }
    await fsp.rm(lockPath, { force: true });
  } catch (error) {
    if (!error || error.code !== 'ENOENT') log('[lock] 释放锁失败', error);
  }
}

async function mergeFromDisk() {
  let text;
  try {
    text = await fsp.readFile(usagePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, count: 0 };
    log('[merge] 无法读取 usage.json', error);
    return { ok: false, count: 0 };
  }
  let disk;
  try {
    const parsed = JSON.parse(text);
    if (!isDataRoot(parsed)) throw new Error('usage.json 结构无效');
    disk = validData(parsed);
  } catch (error) {
    // 磁盘存在但读不出结构：此时内存账本不完整，若继续落盘会连同
    // 唯一有效的 .bak 一起被覆盖。必须中止本次写入，等下次启动走恢复流程。
    log('[merge] usage.json 无法解析，本次不覆盖磁盘（保留待落盘数据）', error);
    return { ok: false, count: 0 };
  }
  const memoryRecords = Object.values(data.days).flat();
  const diskRecords = Object.values(disk.days).flat();
  const result = mergeRecords(memoryRecords, diskRecords);
  const days = {};
  result.records.forEach((record) => {
    const key = dateKey(Number(record.t));
    if (!Array.isArray(days[key])) days[key] = [];
    days[key].push(record);
  });
  data = { v: 1, days };
  if (result.added || result.replaced) log(`[merge] 从磁盘补齐 ${result.added} 条，取大替换 ${result.replaced} 条`);
  return { ok: true, count: result.added + result.replaced };
}

async function flush() {
  if (!dirty) {
    await rawWriteChain;
    return;
  }
  if (flushInFlight) return flushInFlight;
  const versionAtStart = dirtyVersion;
  flushInFlight = (async () => {
    let locked = false;
    try {
      await fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true });
      locked = await acquireLock();
      if (!locked) {
        if (dirty && !flushTimer) {
          flushTimer = setTimeout(() => { flushTimer = undefined; void flush(); }, FLUSH_DELAY_MS);
        }
        return;
      }
      const merged = await mergeFromDisk();
      if (!merged.ok) {
        // 磁盘账本不可信：本次绝不写入，否则会毁掉 .bak 与另一宿主的记录。
        if (dirty && !flushTimer) {
          flushTimer = setTimeout(() => { flushTimer = undefined; void flush(); }, FLUSH_DELAY_MS);
        }
        return;
      }
      prune();
      if (rebuildFingerprintIndexes()) log('[twin] 合并后自愈清除了重复或空记录');
      try {
        await fsp.copyFile(usagePath, `${usagePath}.bak`);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const tempPath = `${usagePath}.tmp`;
      await fsp.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rm(usagePath, { force: true });
      await fsp.rename(tempPath, usagePath);
      if (onChange) {
        try { onChange(getSummary()); } catch (error) { log('onChange failed', error); }
      }
      await rawWriteChain;
      if (dirtyVersion === versionAtStart) {
        dirty = false;
        pendingCount = 0;
      }
    } catch (error) {
      log('写入 usage.json 失败', error);
      if (dirty && !flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flush();
        }, FLUSH_DELAY_MS);
      }
    } finally {
      if (locked) await releaseLock();
      flushInFlight = undefined;
      if (dirty && dirtyVersion !== versionAtStart && !flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flush();
        }, FLUSH_DELAY_MS);
      }
    }
  })();
  return flushInFlight;
}

function addRawSample(sample) {
  if (rawSamples.length >= 3) return;
  rawSamples.push(sample);
  rawWriteChain = rawWriteChain
    .then(async () => {
      try {
        await fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true });
        await fsp.writeFile(rawSamplePath, JSON.stringify({ samples: rawSamples }, null, 2), 'utf8');
      } catch (error) {
        log('写入 raw-sample.json 失败', error);
      }
    })
    .catch((error) => log('raw-sample 写入队列失败', error));
}

function getStats() {
  const entries = Object.entries(data.days);
  const records = entries.reduce((sum, item) => sum + item[1].length, 0);
  let lastRecordAt = null;
  entries.forEach((item) => item[1].forEach((record) => {
    if (Number.isFinite(Number(record.t)) && (lastRecordAt === null || Number(record.t) > lastRecordAt)) lastRecordAt = Number(record.t);
  }));
  return { usagePath, historyPath, rawSamplePath, recordCount: records, dayCount: entries.length, lastRecordAt, dirty };
}

function getAudit() {
  const dayCounts = {};
  const sidCounts = new Map();
  let tokenSum = 0;
  let tokenSeen = false;
  let creditSum = 0;
  let creditSeen = false;
  let noSidCount = 0;
  let invalidCount = 0;
  Object.entries(data.days).forEach(([day, records]) => {
    dayCounts[day] = records.length;
    records.forEach((record) => {
      if (!record || typeof record !== 'object' || !Number.isFinite(Number(record.t))) {
        invalidCount += 1;
        return;
      }
      const p = numberOrNull(record.p);
      const c = numberOrNull(record.c);
      if (p !== null || c !== null) {
        tokenSum += (p ?? 0) + (c ?? 0);
        tokenSeen = true;
      }
      const cr = numberOrNull(record.cr);
      if (cr !== null) { creditSum += cr; creditSeen = true; }
      if (record.sid) sidCounts.set(String(record.sid), (sidCounts.get(String(record.sid)) || 0) + 1);
      else noSidCount += 1;
    });
  });
  let duplicateSidCount = 0;
  sidCounts.forEach((count) => { if (count > 1) duplicateSidCount += count - 1; });
  return {
    dayCounts,
    tokenSum: tokenSeen ? tokenSum : null,
    creditSum: creditSeen ? creditSum : null,
    uniqueSidCount: sidCounts.size,
    duplicateSidCount,
    noSidCount,
    invalidCount
  };
}

function dispose() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  // 锁争用超时后落盘只是「稍后重试」，而重载/关闭窗口会立刻清掉那个定时器。
  // 这里同步写出一份每宿主独立的恢复文件，下次启动由 mergeRecoveryFiles() 并回，
  // 因此「退出时恰好没拿到锁」不再等于丢记录。
  if (!dirty || !context) return;
  try {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `pending-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    log(`[recovery] 退出时仍有未落盘数据，已写出 ${path.basename(file)}，下次启动合并`);
  } catch (error) {
    log('写入退出恢复文件失败', error);
  }
}

module.exports = { init, addRecord, addRawSample, flush, dispose, getStats, getSummary, getAudit, setOnChange };




