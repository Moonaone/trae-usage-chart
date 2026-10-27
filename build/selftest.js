'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require(path.join(__dirname, '..', 'extension', 'store.js'));
const zoom = require(path.join(__dirname, '..', 'extension', 'media', 'zoom.js'));
const chartLayout = require(path.join(__dirname, '..', 'extension', 'media', 'chartLayout.js'));
const reconcile = require(path.join(__dirname, '..', 'extension', 'media', 'reconcile.js'));
const mergePolicy = require(path.join(__dirname, '..', 'extension', 'media', 'mergePolicy.js'));

const localtimePath = path.join(__dirname, '..', 'extension', 'media', 'localtime.js');
let localtimeAvailable = false;
let localtime;
if (fs.existsSync(localtimePath)) {
  localtime = require(localtimePath);
  localtimeAvailable = true;
} else {
  localtime = {
    dateKey: (ms) => new Date(ms).toISOString().slice(0, 10),
    dateFromKey: (key) => new Date(key + 'T12:00:00Z'),
    addDays: (date, days) => { const copy = new Date(date.getTime()); copy.setUTCDate(copy.getUTCDate() + days); return copy; },
    pad2: (value) => String(value).padStart(2, '0')
  };
}

const policyPath = path.join(__dirname, '..', 'extension', 'media', 'cdpPolicy.js');
let policy;
if (fs.existsSync(policyPath)) policy = require(policyPath);

const output = { appendLine() {} };
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-usage-selftest-'));
let failures = 0;
let totalCases = 0;

function failText(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function report(name, pass, expected, actual) {
  if (pass) console.log('PASS ' + name);
  else {
    failures += 1;
    console.log('FAIL ' + name + ' expected=' + failText(expected) + ' actual=' + failText(actual));
  }
}

function makeDir(name) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ctx(dir) {
  return { globalStorageUri: { fsPath: dir } };
}

function usage(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
}

function allRecords(value) {
  return Object.values(value.days || {}).reduce((all, rows) => all.concat(rows), []);
}

function totalCredits(value) {
  return allRecords(value).reduce((sum, row) => sum + (typeof row.cr === 'number' ? row.cr : 0), 0);
}

function localKey(date) {
  return date.getFullYear() + '-' + localtime.pad2(date.getMonth() + 1) + '-' + localtime.pad2(date.getDate());
}

function layoutSlots(values) {
  return values.map((row) => ({ key: row[0], values: new Map(Object.entries(row[1])) }));
}

function assertFiniteTree(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertFiniteTree);
    return;
  }
  if (value && typeof value === 'object') Object.values(value).forEach(assertFiniteTree);
}

async function open(dir) {
  await store.init(ctx(dir), output);
}

async function close() {
  await store.flush();
  store.dispose();
}

async function addMany(rows) {
  for (let i = 0; i < rows.length; i += 9) {
    rows.slice(i, i + 9).forEach((row) => store.addRecord(row));
    await store.flush();
  }
}

async function test(name, fn) {
  totalCases += 1;
  try { await fn(); report(name, true); }
  catch (error) { report(name, false, 'no error', error.message || String(error)); try { store.dispose(); } catch (_) {} }
}

(async () => {
  try {
    await test('local-date-day-key', async () => {
      const dir = makeDir('date');
      const local = new Date(2026, 9, 26, 0, 30, 0, 0);
      await open(dir);
      store.addRecord({ t: local.getTime(), m: 'm', p: 1, c: 1, ca: 0, cr: 1, s: 'test', e: 'test', sid: 'date' });
      await close();
      const value = usage(dir);
      if (!value.days[localKey(local)] || value.days[localKey(local)].length !== 1) throw new Error('record is not under local day');
    });

    await test('date-key-round-trip', async () => {
      if (!localtimeAvailable) throw new Error('localtime module missing');
      const key = '2026-10-26';
      const actual = localtime.dateKey(localtime.dateFromKey(key).getTime());
      if (actual !== key) throw new Error(actual);
    });

    await test('date-cross-month-year', async () => {
      const oct = localtime.dateKey(localtime.addDays(localtime.dateFromKey('2026-10-31'), 1).getTime());
      const jan = localtime.dateKey(localtime.addDays(localtime.dateFromKey('2026-12-31'), 1).getTime());
      if (oct !== '2026-11-01' || jan !== '2027-01-01') throw new Error(oct + ' / ' + jan);
    });

    await test('zoom-total-zero', async () => {
      const view = zoom.clampWindow(4, 3, 0, 2);
      const slice = zoom.windowSlice(view, 0);
      if (failText(view) !== '{"start":0,"size":0}' || failText(slice) !== '{"from":0,"to":-1,"count":0}') throw new Error(failText({ view, slice }));
    });

    await test('zoom-total-one', async () => {
      const view = zoom.clampWindow(-4, 8, 1, 2);
      if (view.start !== 0 || view.size !== 1) throw new Error(failText(view));
    });

    await test('zoom-total-five-min-two', async () => {
      const view = zoom.clampWindow(1, 3, 5, 2);
      if (view.start !== 1 || view.size !== 3) throw new Error(failText(view));
    });

    await test('zoom-negative-start', async () => {
      const view = zoom.clampWindow(-9, 2, 5, 2);
      if (view.start !== 0 || view.size !== 2) throw new Error(failText(view));
    });

    await test('zoom-size-over-total', async () => {
      const view = zoom.clampWindow(2, 99, 5, 2);
      if (view.start !== 0 || view.size !== 5) throw new Error(failText(view));
    });

    await test('zoom-anchor-stays', async () => {
      const before = zoom.clampWindow(2, 8, 20, 2);
      const ratio = 0.5;
      const beforeAnchor = Math.floor(before.start + ratio * before.size);
      const after = zoom.zoomWindow(before, ratio, 2, 20, 2);
      const afterAnchor = Math.floor(after.start + ratio * after.size);
      if (beforeAnchor !== afterAnchor || after.size >= before.size) throw new Error(failText({ before, after, beforeAnchor, afterAnchor }));
    });

    await test('zoom-scroll-out-grows', async () => {
      const view = zoom.zoomWindow({ start: 4, size: 2 }, 0.5, 1 / 1.15, 10, 2);
      if (view.size <= 2) throw new Error(failText(view));
    });

    await test('zoom-pan-left-boundary', async () => {
      const view = zoom.panWindow({ start: 4, size: 3 }, -99, 10, 2);
      if (view.start !== 0 || view.size !== 3) throw new Error(failText(view));
    });

    await test('zoom-pan-right-boundary', async () => {
      const view = zoom.panWindow({ start: 4, size: 3 }, 99, 10, 2);
      if (view.start !== 7 || view.size !== 3) throw new Error(failText(view));
    });

    await test('zoom-window-slice', async () => {
      const slice = zoom.windowSlice({ start: 1, size: 2 }, 5);
      if (slice.from !== 1 || slice.to !== 2 || slice.count !== 2) throw new Error(failText(slice));
    });

    await test('layout-empty', async () => {
      const plot = { left: 10, top: 4, width: 100, height: 80 };
      const bars = chartLayout.layoutBars([], ['A'], 10, plot);
      const lines = chartLayout.layoutLines([], ['A'], 10, plot);
      if (bars.length !== 0 || lines.lines.length !== 0 || lines.points.length !== 0) throw new Error(failText({ bars, lines }));
    });

    await test('layout-zero-top', async () => {
      const slots = layoutSlots([['a', { A: 1 }]]);
      const bars = chartLayout.layoutBars(slots, ['A'], 0, { left: 0, top: 0, width: 100, height: 80 });
      const lines = chartLayout.layoutLines(slots, ['A'], 0, { left: 0, top: 0, width: 100, height: 80 });
      if (bars.length !== 0 || lines.lines.length !== 0) throw new Error(failText({ bars, lines }));
    });

    await test('layout-skip-zero-bars', async () => {
      const bars = chartLayout.layoutBars(layoutSlots([['a', { A: 0, B: 2 }]]), ['A', 'B'], 2, { left: 0, top: 0, width: 100, height: 80 });
      if (bars.length !== 1 || bars[0].groupIndex !== 1) throw new Error(failText(bars));
    });

    await test('layout-stack-from-bottom', async () => {
      const bars = chartLayout.layoutBars(layoutSlots([['a', { A: 1, B: 1 }]]), ['A', 'B'], 2, { left: 0, top: 0, width: 100, height: 80 });
      const totalHeight = bars.reduce((sum, bar) => sum + bar.height, 0);
      if (bars.length !== 2 || Math.abs(totalHeight - 80) > 1e-9 || Math.abs(bars[0].y + bars[0].height - 80) > 1e-9 || Math.abs(bars[1].y + bars[1].height - bars[0].y) > 1e-9) throw new Error(failText(bars));
    });

    await test('layout-proportional', async () => {
      const one = chartLayout.layoutBars(layoutSlots([['a', { A: 1 }]]), ['A'], 2, { left: 0, top: 0, width: 100, height: 80 })[0];
      const two = chartLayout.layoutBars(layoutSlots([['a', { A: 2 }]]), ['A'], 2, { left: 0, top: 0, width: 100, height: 80 })[0];
      if (!one || !two || Math.abs(two.height - one.height * 2) > 1e-9) throw new Error(failText({ one, two }));
    });

    await test('layout-no-nan', async () => {
      const plot = { left: 10, top: 4, width: 180, height: 90 };
      const slots = layoutSlots([['a', { A: 1, B: 2 }], ['b', { A: 0, B: 3 }]]);
      assertFiniteTree(chartLayout.layoutBars(slots, ['A', 'B'], 3, plot));
      assertFiniteTree(chartLayout.layoutLines(slots, ['A', 'B'], 3, plot));
      assertFiniteTree(chartLayout.layoutAxis(3, plot));
    });

    await test('reconcile-no-baseline', async () => {
      const result = reconcile.computeDrift(100, 80, null);
      if (result.offset !== 20 || result.drift !== null || result.hasBaseline) throw new Error(failText(result));
    });

    await test('reconcile-normal', async () => {
      const result = reconcile.computeDrift(101, 81, 20);
      if (result.offset !== 20 || result.drift !== 0 || !result.hasBaseline) throw new Error(failText(result));
    });

    await test('reconcile-drift-positive', async () => {
      const result = reconcile.computeDrift(103, 81, 20);
      if (result.drift !== 2 || !reconcile.needsAlert(result.drift, 0.5)) throw new Error(failText(result));
    });

    await test('reconcile-drift-negative', async () => {
      const result = reconcile.computeDrift(101, 82, 20);
      if (result.drift !== -1 || reconcile.needsAlert(result.drift, 0.5)) throw new Error(failText(result));
    });

    await test('reconcile-invalid-input', async () => {
      const result = reconcile.computeDrift(NaN, 80, 20);
      if (reconcile.computeOffset('100', 80) !== null || result.offset !== null || result.drift !== null || !result.hasBaseline || reconcile.needsAlert(NaN, 0.5)) throw new Error(failText(result));
    });

    await test('reconcile-threshold', async () => {
      if (reconcile.needsAlert(0.5, 0.5) || !reconcile.needsAlert(0.51, 0.5) || reconcile.needsAlert(null, 0.5) || reconcile.needsAlert(1, NaN)) throw new Error('threshold comparison failed');
    });

    await test('reconcile-rebaseline-on-backfill', async () => {
      if (!reconcile) throw new Error('reconcile module missing');
      if (typeof reconcile.shouldRebaseline !== 'function') throw new Error('shouldRebaseline missing');
      // 补录 33.10 后漂移为 -33.10，必须触发追平，否则告警灵敏度被永久吃掉 33.10
      if (!reconcile.shouldRebaseline(-33.1, 5)) throw new Error('backfill not detected');
      // 抖动范围内不得追平（账户 used 实测有约 2.2 的陈旧值来回跳）
      if (reconcile.shouldRebaseline(-2.2, 5)) throw new Error('noise triggered rebaseline');
      if (reconcile.shouldRebaseline(-5, 5)) throw new Error('boundary should not trigger');
      if (!reconcile.shouldRebaseline(-5.01, 5)) throw new Error('just over boundary should trigger');
      if (reconcile.shouldRebaseline(33.1, 5)) throw new Error('positive drift must not rebaseline');
      if (reconcile.shouldRebaseline(null, 5) || reconcile.shouldRebaseline(NaN, 5)) throw new Error('invalid input');
    });

    await test('alert-first-strike-no-alert', async () => {
      const result = reconcile.confirmAlert(0.8, null, 0.5);
      if (result.alert || result.pendingDrift !== 0.8) throw new Error(failText(result));
    });

    await test('alert-second-strike-alerts', async () => {
      const result = reconcile.confirmAlert(0.9, 0.8, 0.5);
      if (!result.alert || result.pendingDrift !== null) throw new Error(failText(result));
    });

    await test('alert-recovers-clears', async () => {
      const result = reconcile.confirmAlert(0.5, 0.8, 0.5);
      if (result.alert || result.pendingDrift !== null) throw new Error(failText(result));
    });

    await test('alert-rebaseline-clears-pending', async () => {
      const drift = -6;
      if (!reconcile.shouldRebaseline(drift, 5)) throw new Error('rebaseline not triggered');
      const result = reconcile.confirmAlert(0, 0.8, 0.5);
      if (result.alert || result.pendingDrift !== null) throw new Error(failText(result));
    });

    await test('merge-adds-missing-sid', async () => {
      const a = { t: 1, sid: 'a', cr: 1 };
      const b = { t: 2, sid: 'b', cr: 2 };
      const result = mergePolicy.mergeRecords([a], [b]);
      if (result.added !== 1 || result.replaced !== 0 || result.records.length !== 2 || result.records[0] !== a || result.records[1] !== b) throw new Error(failText(result));
    });

    await test('merge-keeps-larger-cr', async () => {
      const a = { t: 1, sid: 'a', cr: 1 };
      const b = { t: 2, sid: 'a', cr: 3 };
      const result = mergePolicy.mergeRecords([a], [b]);
      if (result.added !== 0 || result.replaced !== 1 || result.records.length !== 1 || result.records[0] !== b) throw new Error(failText(result));
    });

    await test('merge-does-not-downgrade', async () => {
      const a = { t: 1, sid: 'a', cr: 3 };
      const b = { t: 2, sid: 'a', cr: 2 };
      const equal = { t: 3, sid: 'a', cr: 3 };
      const result = mergePolicy.mergeRecords([a], [b, equal]);
      if (result.replaced !== 0 || result.records.length !== 1 || result.records[0] !== a) throw new Error(failText(result));
    });

    await test('merge-dedupes-sidless', async () => {
      const a = { t: 1, sid: null, m: 'm', p: 1, c: 2, ca: 3, cr: 4 };
      const b = { ...a, t: 2 };
      const c = { ...a, t: 3, cr: 5 };
      const result = mergePolicy.mergeRecords([a], [b, c]);
      if (result.added !== 1 || result.records.length !== 2 || result.records[0] !== a || result.records[1] !== c) throw new Error(failText(result));
    });

    await test('merge-empty-inputs', async () => {
      const result = mergePolicy.mergeRecords(null, [null, 3, {}, { t: null }, { t: '' }, { t: NaN }]);
      if (result.records.length !== 0 || result.added !== 0 || result.replaced !== 0) throw new Error(failText(result));
    });

    await test('lock-stale-detection', async () => {
      const fn = mergePolicy.isStaleLock;
      if (fn(0, 10000, 10000) || !fn(0, 10001, 10000) || fn(10001, 10000, 10000) || fn(NaN, 10001, 10000)) throw new Error('stale boundary failed');
    });

    await test('cdp-eligible-filter', async () => {
      if (!policy) throw new Error('cdpPolicy module missing');
      const ws = 'ws://127.0.0.1:9222/devtools/page/1';
      ['page', 'webview', 'background_page'].forEach((type) => {
        if (!policy.isEligibleTarget({ type, webSocketDebuggerUrl: ws })) throw new Error(type + ' rejected');
      });
      if (policy.isEligibleTarget({ type: 'iframe', webSocketDebuggerUrl: ws })) throw new Error('iframe accepted');
      if (policy.isEligibleTarget({ type: 'page' })) throw new Error('missing ws accepted');
      if (policy.isEligibleTarget({ type: 'page', webSocketDebuggerUrl: '   ' })) throw new Error('blank ws accepted');
      if (policy.isEligibleTarget(null)) throw new Error('null accepted');
    });

    await test('cdp-worker-rejected', async () => {
      if (!policy) throw new Error('cdpPolicy module missing');
      const ws = 'ws://127.0.0.1:9222/devtools/worker/1';
      // 实测：worker / service_worker 会接受 WebSocket 但从不回应 Network.enable，
      // 连接会永久挂起并占用名额，且从未产出过任何记录 —— 必须拒绝。
      ['worker', 'service_worker', 'shared_worker'].forEach((type) => {
        if (policy.isEligibleTarget({ type, webSocketDebuggerUrl: ws })) throw new Error(type + ' must be rejected');
      });
    });

    await test('cdp-priority-pages-first', async () => {
      if (!policy) throw new Error('cdpPolicy module missing');
      const list = [
        { type: 'service_worker' }, { type: 'worker' }, { type: 'webview' },
        { type: 'page', title: 'b' }, { type: 'page', title: 'a' }
      ];
      const order = policy.sortTargetsByPriority(list).map((item) => item.type);
      if (order[0] !== 'page' || order[1] !== 'page' || order[2] !== 'webview') throw new Error(order.join(','));
      if (list[0].type !== 'service_worker') throw new Error('input array was mutated');
    });

    await test('cdp-unknown-type-goes-last', async () => {
      if (!policy) throw new Error('cdpPolicy module missing');
      const order = policy.sortTargetsByPriority([{ type: 'weird' }, { type: 'page' }]).map((item) => item.type);
      if (order[0] !== 'page') throw new Error(order.join(','));
    });

    await test('cdp-request-tracker-isolation', async () => {
      if (!policy) throw new Error('cdpPolicy module missing');
      const first = policy.createRequestTracker(10);
      const second = policy.createRequestTracker(10);
      if (first.remember('35096.1') !== true) throw new Error('first remember should be true');
      if (first.remember('35096.1') !== false) throw new Error('duplicate should be rejected');
      // 同一个 requestId 在另一个 target 里必须仍算首次，否则两个 target 会互相吞掉记录
      if (second.remember('35096.1') !== true) throw new Error('cross-target collision');
    });

    await test('cdp-request-tracker-evicts-oldest', async () => {
      if (!policy) throw new Error('cdpPolicy module missing');
      const tracker = policy.createRequestTracker(3);
      ['a', 'b', 'c', 'd'].forEach((id) => tracker.remember(id));
      if (tracker.size() !== 3) throw new Error('size=' + tracker.size());
      if (tracker.has('a')) throw new Error('oldest not evicted');
      if (!tracker.has('d')) throw new Error('newest missing');
    });

    await test('cdp-backoff-grows-and-caps', async () => {
      if (!policy) throw new Error('cdpPolicy module missing');
      const first = policy.nextBackoffDelay(1);
      const second = policy.nextBackoffDelay(2);
      const capped = policy.nextBackoffDelay(50);
      if (first !== policy.BACKOFF_BASE_MS) throw new Error('first=' + first);
      if (!(second > first)) throw new Error('not growing: ' + second);
      if (capped !== policy.BACKOFF_MAX_MS) throw new Error('cap=' + capped);
      if (policy.nextBackoffDelay(0) < policy.BACKOFF_BASE_MS) throw new Error('zero count too small');
    });

    await test('merge-cross-host-flush', async () => {
      const dir = makeDir('cross-host');
      const secondPath = require.resolve(path.join(__dirname, '..', 'extension', 'store.js'));
      delete require.cache[secondPath];
      const secondStore = require(secondPath);
      await open(dir);
      await secondStore.init(ctx(dir), output);
      store.addRecord({ t: 1792996182746, m: 'a', p: 1, c: 1, ca: 0, cr: 1, sid: 'host-a' });
      await store.flush();
      secondStore.addRecord({ t: 1792996182747, m: 'b', p: 2, c: 2, ca: 0, cr: 2, sid: 'host-b' });
      await secondStore.flush();
      store.dispose();
      secondStore.dispose();
      const rows = allRecords(usage(dir));
      if (rows.length !== 2 || !rows.some((row) => row.sid === 'host-a') || !rows.some((row) => row.sid === 'host-b')) throw new Error(failText(rows));
      if (fs.existsSync(path.join(dir, 'usage.json.lock'))) throw new Error('lock was not released');
    });

    await test('merge-disk-max-and-heal', async () => {
      const dir = makeDir('merge-heal');
      const secondPath = require.resolve(path.join(__dirname, '..', 'extension', 'store.js'));
      delete require.cache[secondPath];
      const secondStore = require(secondPath);
      await open(dir);
      await secondStore.init(ctx(dir), output);
      const base = { t: 1792996182746, m: 'm', p: 10, c: 2, ca: 4, cr: 3, sid: 'same' };
      store.addRecord(base);
      await store.flush();
      secondStore.addRecord({ ...base, t: base.t + 1, cr: 1 });
      secondStore.addRecord({ ...base, t: base.t + 2, sid: null });
      await secondStore.flush();
      store.dispose();
      secondStore.dispose();
      const rows = allRecords(usage(dir));
      if (rows.length !== 1 || rows[0].sid !== 'same' || rows[0].cr !== 3) throw new Error(failText(rows));
    });

    await test('lock-contention-keeps-dirty', async () => {
      const dir = makeDir('lock-busy');
      await open(dir);
      const lock = path.join(dir, 'usage.json.lock');
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      store.addRecord({ t: 1792996182746, m: 'm', p: 1, c: 1, ca: 0, cr: 1, sid: 'retry' });
      await store.flush();
      if (!store.getStats().dirty) throw new Error('dirty cleared during contention');
      fs.unlinkSync(lock);
      await close();
      const rows = allRecords(usage(dir));
      if (rows.length !== 1 || rows[0].sid !== 'retry') throw new Error(failText(rows));
    });

    await test('sid-keeps-maximum', async () => {
      const dir = makeDir('sid');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 1, c: 1, ca: 1, cr: 1.5, s: 'test', e: 'test', sid: 'same' });
      await close();
      await open(dir);
      store.addRecord({ t: 1792996182747, m: 'm', p: 2, c: 2, ca: 2, cr: 3, s: 'test', e: 'test', sid: 'same' });
      store.addRecord({ t: 1792996182748, m: 'm', p: 3, c: 3, ca: 3, cr: 2, s: 'test', e: 'test', sid: 'same' });
      await close();
      const rows = allRecords(usage(dir));
      if (rows.length !== 1 || rows[0].cr !== 3 || rows[0].p !== 2) throw new Error(failText(rows));
    });

    await test('no-sid-signature-window', async () => {
      const dir = makeDir('signature');
      await open(dir);
      const row = { t: 1792996182746, m: 'm', p: 1, c: 1, ca: 1, cr: 1.5, s: 'test', e: 'test', sid: null };
      store.addRecord(row);
      store.addRecord({ ...row, t: row.t + 1 });
      await close();
      if (allRecords(usage(dir)).length !== 1) throw new Error('duplicate was stored');
    });

    await test('twin-loose-then-sid', async () => {
      const dir = makeDir('twin-a');
      await open(dir);
      const base = { m: 'm', p: 100, c: 5, ca: 50, cr: 2.5, s: 'cdp', e: 'e' };
      store.addRecord({ ...base, t: 1792996182746, sid: null });
      store.addRecord({ ...base, t: 1792996182746 + 9999249, sid: 'late-sid' });
      await close();
      const rows = allRecords(usage(dir));
      if (rows.length !== 1 || rows[0].sid !== 'late-sid') throw new Error(failText(rows));
    });

    await test('twin-sid-then-loose', async () => {
      const dir = makeDir('twin-b');
      await open(dir);
      const base = { m: 'm', p: 200, c: 6, ca: 60, cr: 3.5, s: 'cdp', e: 'e' };
      store.addRecord({ ...base, t: 1792996182746, sid: 'early-sid' });
      store.addRecord({ ...base, t: 1792996182746 + 9999249, sid: null });
      await close();
      const rows = allRecords(usage(dir));
      if (rows.length !== 1 || rows[0].sid !== 'early-sid') throw new Error(failText(rows));
    });

    await test('init-heals-existing-twins', async () => {
      const dir = makeDir('heal');
      const base = { m: 'm', p: 300, c: 7, ca: 70, cr: 4.5, s: 'cdp', e: 'e' };
      const payload = { v: 1, days: { '2026-10-26': [
        { ...base, t: 1792996182746, sid: null },
        { ...base, t: 1792996182746 + 9999249, sid: 'healed-sid' }
      ] } };
      fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(payload), 'utf8');
      await open(dir);
      await close();
      const rows = allRecords(usage(dir));
      if (rows.length !== 1 || rows[0].sid !== 'healed-sid') throw new Error(failText(rows));
    });

    await test('history-merge-idempotent', async () => {
      const dir = makeDir('history');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 1, c: 1, ca: 1, cr: 1, s: 'cdp', e: 'e', sid: 'a' });
      store.addRecord({ t: 1792996182747, m: 'm', p: 2, c: 2, ca: 2, cr: 2, s: 'cdp', e: 'e', sid: 'b' });
      await close();
      fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ v: 1, generatedAt: Date.now(), source: 'test', records: [
        { t: 1792996182747, m: 'm', p: 2, c: 2, ca: 2, cr: 2, s: 'history', e: 'e', sid: 'b' },
        { t: 1792996182748, m: 'm', p: 3, c: 3, ca: 3, cr: 3, s: 'history', e: 'e', sid: 'c' }
      ] }), 'utf8');
      await open(dir);
      await close();
      const first = usage(dir);
      await open(dir);
      await close();
      const second = usage(dir);
      if (allRecords(first).length !== 3 || allRecords(second).length !== 3 || totalCredits(first) !== totalCredits(second)) throw new Error(failText({ first, second }));
    });

    await test('history-collision-keeps-distinct', async () => {
      const dir = makeDir('collision');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 10, c: 1, ca: 3, cr: 1, s: 'cdp', e: 'e', sid: null });
      await close();
      fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ v: 1, records: [{ t: 1792996182747, m: 'h', p: 10, c: 9, ca: 3, cr: 9, s: 'history', e: 'e', sid: 'h' }] }), 'utf8');
      await open(dir);
      await close();
      if (allRecords(usage(dir)).length !== 2) throw new Error('distinct full signature was skipped');
    });

    await test('history-full-signature-dedupes', async () => {
      const dir = makeDir('history-full-signature');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 10, c: 1, ca: 3, cr: 1, s: 'cdp', e: 'e', sid: null });
      await close();
      fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ v: 1, records: [
        { t: 1792996182747, m: 'm', p: 10, c: 1, ca: 3, cr: 1, s: 'history', e: 'e', sid: null },
        { t: 1792996182748, m: 'm', p: 10, c: 2, ca: 3, cr: 1, s: 'history', e: 'e', sid: null }
      ] }), 'utf8');
      await open(dir);
      await close();
      if (allRecords(usage(dir)).length !== 2) throw new Error('full signature deduplication failed');
    });

    await test('prune-90-days', async () => {
      const dir = makeDir('days');
      await open(dir);
      const rows = [];
      for (let i = 0; i < 91; i += 1) {
        const date = localtime.addDays(localtime.dateFromKey('2026-01-01'), i);
        rows.push({ t: date.getTime(), m: 'm', p: 1, c: 1, ca: 1, cr: 1, s: 'test', e: 'e', sid: 'd-' + i });
      }
      await addMany(rows);
      await close();
      if (Object.keys(usage(dir).days).length !== 90) throw new Error('wrong day count');
    });

    await test('prune-5000-oldest', async () => {
      const dir = makeDir('records');
      await open(dir);
      const t = localtime.dateFromKey('2026-01-01').getTime();
      const rows = [];
      for (let i = 0; i < 5001; i += 1) rows.push({ t: t + i, m: 'm', p: i, c: 0, ca: 0, cr: 1, s: 'test', e: 'e', sid: 'r-' + i });
      await addMany(rows);
      await close();
      const savedRows = allRecords(usage(dir));
      if (savedRows.length !== 5000 || savedRows.some((row) => row.p === 0)) throw new Error('len=' + savedRows.length + ' min=' + Math.min.apply(null, savedRows.map((row) => row.p)) + ' max=' + Math.max.apply(null, savedRows.map((row) => row.p))); 
    });

    await test('atomic-write', async () => {
      const dir = makeDir('atomic');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 1, c: 1, ca: 1, cr: 1, s: 'test', e: 'e', sid: 'atomic' });
      await close();
      JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
      if (fs.existsSync(path.join(dir, 'usage.json.tmp'))) throw new Error('tmp remains');
    });

    await test('corrupt-recovery', async () => {
      const dir = makeDir('corrupt');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 1, c: 1, ca: 1, cr: 1, s: 'test', e: 'e', sid: 'old' });
      await close();
      await open(dir);
      store.addRecord({ t: 1792996182747, m: 'm', p: 2, c: 2, ca: 2, cr: 2, s: 'test', e: 'e', sid: 'new' });
      await close();
      fs.writeFileSync(path.join(dir, 'usage.json'), 'broken', 'utf8');
      await open(dir);
      await close();
      const rows = allRecords(usage(dir));
      const corrupt = fs.readdirSync(dir).some((name) => /^usage\.json\.corrupt-\d{8}-\d{6}$/.test(name));
      if (!corrupt || !rows.some((row) => row.sid === 'old')) throw new Error(failText({ rows, files: fs.readdirSync(dir) }));
    });

    await test('merge-aborts-on-corrupt-disk', async () => {
      const dir = makeDir('merge-corrupt');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 1, c: 1, ca: 1, cr: 1, s: 'test', e: 'e', sid: 'good' });
      await close();
      await open(dir);
      store.addRecord({ t: 1792996182747, m: 'm', p: 2, c: 2, ca: 2, cr: 2, s: 'test', e: 'e', sid: 'good2' });
      await close();
      // 到这里 usage.json 有两条，.bak 有一份可用的上一版
      await open(dir);
      fs.writeFileSync(path.join(dir, 'usage.json'), 'broken', 'utf8');
      store.addRecord({ t: 1792996182748, m: 'm', p: 3, c: 3, ca: 3, cr: 3, s: 'test', e: 'e', sid: 'later' });
      await store.flush();
      const mainText = fs.readFileSync(path.join(dir, 'usage.json'), 'utf8');
      if (mainText !== 'broken') throw new Error('损坏的主文件被覆盖了: ' + mainText.slice(0, 60));
      const backupRows = allRecords(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json.bak'), 'utf8')));
      if (!backupRows.some((row) => row.sid === 'good')) throw new Error('可用备份被损坏文件覆盖: ' + failText(backupRows));
      store.dispose();
    });

    await test('dispose-preserves-unflushed-records', async () => {
      const dir = makeDir('exit-recovery');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 1, c: 1, ca: 1, cr: 1, s: 'test', e: 'e', sid: 'unsaved' });
      store.dispose();
      const pending = fs.readdirSync(dir).filter((name) => name.startsWith('pending-'));
      if (pending.length !== 1) throw new Error('没有写出退出恢复文件: ' + failText(fs.readdirSync(dir)));
      await open(dir);
      await close();
      const rows = allRecords(usage(dir));
      if (!rows.some((row) => row.sid === 'unsaved')) throw new Error('未落盘记录丢失: ' + failText(rows));
      if (fs.readdirSync(dir).some((name) => name.startsWith('pending-'))) throw new Error('恢复文件未被清理');
    });

    await test('history-adopts-sid', async () => {
      const dir = makeDir('history-adopt');
      await open(dir);
      store.addRecord({ t: 1792996182746, m: 'm', p: 10, c: 1, ca: 3, cr: 1, s: 'cdp', e: 'e', sid: null });
      await close();
      fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ v: 1, records: [
        { t: 1792996182746, m: 'm', p: 10, c: 1, ca: 3, cr: 1, s: 'history', e: 'e', sid: 'S1' }
      ] }), 'utf8');
      await open(dir);
      await close();
      const rows = allRecords(usage(dir));
      if (rows.length !== 1) throw new Error('同内容记录被重复计入: ' + failText(rows));
      if (rows[0].sid !== 'S1') throw new Error('同内容记录没有补回 sid: ' + failText(rows[0]));
    });
  } finally {
    try { store.dispose(); } catch (_) {}
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log('selftest summary: ' + (totalCases - failures) + '/' + totalCases + ' passed');
  process.exitCode = failures ? 1 : 0;
})();




