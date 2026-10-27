'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { startCollector, stopCollector, getStatus: getCollectorStatus } = require('./collector');
const store = require('./store');
const { dateKey } = require('./media/localtime');
const { computeDrift, confirmAlert, shouldRebaseline } = require('./media/reconcile');

const CREDIT_COMMAND = 'workbench.action.icubeGetCreditsUsageInfo';
const MAX_PAYLOADS = 3;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 3;
const DRIFT_THRESHOLD = 0.5;
// 负漂移超过此值才追平基线。取 5 是为了忽略账户 used 的陈旧值抖动（实测约 2.2）。
const REBASELINE_THRESHOLD = 5;

let output;
let dashboardPanel;
let extensionContext;
let statusBar;
let latestQuota;
let reconciliationState;
let reconciliationMainValid = false;
let reconciliationQueue = Promise.resolve();
const recentPayloads = [];

function appendLine(value = '') {
  if (output) output.appendLine(String(value));
}

function getIcubeAI() {
  try {
    return vscode.icubeAI;
  } catch (error) {
    appendLine(`读取 vscode.icubeAI 失败：${formatError(error)}`);
    return undefined;
  }
}

function listPropertyNames(value) {
  if (value === null || value === undefined) return [];

  const names = new Set();
  let current = value;
  let level = 0;
  while (current && level < 3) {
    try {
      for (const name of Object.getOwnPropertyNames(current)) names.add(name);
      current = Object.getPrototypeOf(current);
    } catch {
      break;
    }
    level += 1;
  }
  return Array.from(names).sort();
}

function truncateForJson(value, depth = 0, seen = new WeakSet()) {
  if (value === null) return null;
  if (value === undefined) return '[undefined]';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => truncateForJson(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) result.push(`[... ${value.length - MAX_ARRAY_ITEMS} more items]`);
  } else {
    result = {};
    for (const key of Object.keys(value)) {
      try {
        result[key] = truncateForJson(value[key], depth + 1, seen);
      } catch (error) {
        result[key] = `[Unreadable: ${formatError(error)}]`;
      }
    }
  }
  seen.delete(value);
  return result;
}

function stringifyJson(value) {
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch (error) {
    return `JSON.stringify 失败：${formatError(error)}\n${JSON.stringify(truncateForJson(value), null, 2)}`;
  }
}

function formatError(error) {
  if (error && typeof error === 'object') {
    if (typeof error.stack === 'string' && error.stack) return error.stack;
    const name = typeof error.name === 'string' ? error.name : 'Error';
    const message = typeof error.message === 'string' ? error.message : String(error);
    return `${name}: ${message}`;
  }
  return String(error);
}

async function readUsageCreditsSum() {
  const usagePath = path.join(extensionContext.globalStorageUri.fsPath, 'usage.json');
  try {
    const data = JSON.parse(await fs.promises.readFile(usagePath, 'utf8'));
    if (!data || !data.days || typeof data.days !== 'object' || Array.isArray(data.days)) throw new Error('usage.json days 无效');
    let sum = 0;
    for (const records of Object.values(data.days)) {
      if (!Array.isArray(records)) continue;
      for (const record of records) if (Number.isFinite(record?.cr)) sum += record.cr;
    }
    return Number.isFinite(sum) ? sum : null;
  } catch (error) {
    // 文件暂时缺失不能当作「本库合计为 0」——否则会拿账户 used 算出巨大的假漂移。
    // 真正的首次建库由 performReconciliation 的 hasBaseline 分支处理。
    if (error && error.code === 'ENOENT') {
      appendLine('差额检查跳过：usage.json 暂时不存在（可能正在落盘）');
      return null;
    }
    appendLine(`差额检查读取 usage.json 失败：${formatError(error)}`);
    return null;
  }
}

async function readReconciliation() {
  const filename = path.join(extensionContext.globalStorageUri.fsPath, 'reconcile.json');
  const readValid = async (source) => {
    const saved = JSON.parse(await fs.promises.readFile(source, 'utf8'));
    if (saved?.v !== 1 || !Number.isFinite(saved.baselineOffset)) throw new Error('reconcile.json 结构无效');
    return saved;
  };
  try {
    const saved = await readValid(filename);
    reconciliationMainValid = true;
    return saved;
  } catch (primaryError) {
    reconciliationMainValid = false;
    try {
      const saved = await readValid(filename + '.bak');
      appendLine(`reconcile.json 不可用，已从备份恢复基线：${formatError(primaryError)}`);
      return saved;
    } catch (backupError) {
      if (primaryError?.code === 'ENOENT' && backupError?.code === 'ENOENT') {
        appendLine('reconcile.json 与备份均不存在，首次建立差额基线');
      } else {
        appendLine(`reconcile.json 与备份均不可用，无法恢复既有基线；将当前差额作为新基线。主文件：${formatError(primaryError)}；备份：${formatError(backupError)}`);
      }
      return null;
    }
  }
}

async function performReconciliation(quotaResult) {
  let result = quotaResult;
  if (result === undefined) {
    try { result = await vscode.commands.executeCommand(CREDIT_COMMAND); }
    catch (error) { appendLine(`差额检查读取账户额度失败：${formatError(error)}`); return null; }
  }
  const used = result?.used;
  const creditsSum = await readUsageCreditsSum();
  if (!Number.isFinite(used) || creditsSum === null) {
    appendLine('差额检查缺少有效的 used 或本库积分合计');
    return null;
  }
  if (reconciliationState === undefined) reconciliationState = await readReconciliation();
  const baseline = reconciliationState?.baselineOffset ?? null;
  const computed = computeDrift(used, creditsSum, baseline);
  if (computed.offset === null) return null;
  // 负漂移（本库记录多于基线预期）会把同额的告警灵敏度永久吃掉，必须把基线追平。
  // 典型触发场景：补录历史数据。
  const rebaselined = computed.hasBaseline && shouldRebaseline(computed.drift, REBASELINE_THRESHOLD);
  const baselineOffset = !computed.hasBaseline || rebaselined ? computed.offset : baseline;
  const drift = !computed.hasBaseline || rebaselined ? 0 : computed.drift;
  if (rebaselined) {
    appendLine(`差额基线已追平：漂移 ${computed.drift.toFixed(2)} 说明补录了历史数据，基线从 ${baseline.toFixed(2)} 调整为 ${baselineOffset.toFixed(2)}`);
  }
  const confirmation = confirmAlert(drift, reconciliationState?.pendingDrift, DRIFT_THRESHOLD);
  const alert = confirmation.alert;
  reconciliationState = {
    v: 1, baselineOffset, lastUsed: used, lastSum: creditsSum,
    lastDrift: drift, pendingDrift: confirmation.pendingDrift, lastCheckedAt: Date.now(),
    alertCount: (Number.isFinite(reconciliationState?.alertCount) ? reconciliationState.alertCount : 0) + (alert ? 1 : 0)
  };
  try {
    await fs.promises.mkdir(extensionContext.globalStorageUri.fsPath, { recursive: true });
    const filename = path.join(extensionContext.globalStorageUri.fsPath, 'reconcile.json');
    if (reconciliationMainValid) await fs.promises.copyFile(filename, filename + '.bak');
    await fs.promises.writeFile(filename + '.tmp', JSON.stringify(reconciliationState, null, 2), 'utf8');
    await fs.promises.rm(filename, { force: true });
    await fs.promises.rename(filename + '.tmp', filename);
    reconciliationMainValid = true;
  } catch (error) {
    appendLine(`写入 reconcile.json 失败：${formatError(error)}`);
  }
  return { ...reconciliationState, alert, threshold: DRIFT_THRESHOLD };
}

function checkReconciliation(quotaResult) {
  const pending = reconciliationQueue.then(() => performReconciliation(quotaResult));
  reconciliationQueue = pending.catch((error) => { appendLine(`差额检查失败：${formatError(error)}`); return null; });
  return reconciliationQueue;
}

function rememberPayload(payload) {
  recentPayloads.push(truncateForJson(payload));
  while (recentPayloads.length > MAX_PAYLOADS) recentPayloads.shift();
}

function subscribeToTaskComplete(context) {
  const api = getIcubeAI();
  if (!api || typeof api.onAiTaskComplete !== 'function') return;

  const handler = (payload) => {
    try {
      rememberPayload(payload);
    } catch (error) {
      appendLine(`保存事件 payload 失败：${formatError(error)}`);
    }
  };

  try {
    const disposable = api.onAiTaskComplete(handler);
    if (disposable && typeof disposable.dispose === 'function') {
      context.subscriptions.push(disposable);
    }
  } catch (error) {
    appendLine(`订阅 onAiTaskComplete 失败：${formatError(error)}`);
  }
}

function formatStatusNumber(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatStatusTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function formatAuditTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '（无）';
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

// 浮点误差会产生 -0.00 这种显示，对账时看着像 bug。
function formatSigned(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);
}

function updateStatusBar() {
  if (!statusBar) return;
  const summary = store.getSummary();
  const todayCredits = summary.todayCredits;
  statusBar.text = todayCredits === null ? '$(pulse) Trae 用量' : '$(pulse) 今日 ' + formatStatusNumber(todayCredits, 1) + ' 积分';
  const limit = latestQuota && typeof latestQuota.limit === 'number' ? latestQuota.limit : null;
  const remaining = latestQuota && typeof latestQuota.remaining === 'number'
    ? latestQuota.remaining
    : (limit !== null && latestQuota && typeof latestQuota.used === 'number' ? limit - latestQuota.used : null);
  const tooltip = [
    '今日：' + summary.todayCount + ' 条请求 · ' + formatStatusNumber(summary.todayTokens, 0) + ' Token · ' + formatStatusNumber(summary.todayCredits, 2) + ' 积分 · 命中率 ' + formatStatusNumber(summary.todayCacheRate, 1) + '%',
    '近 7 天：' + formatStatusNumber(summary.recent7Tokens, 0) + ' Token · ' + formatStatusNumber(summary.recent7Credits, 2) + ' 积分',
    '剩余额度：' + formatStatusNumber(remaining, 2) + ' / ' + formatStatusNumber(limit, 2),
    '最近捕获：' + formatStatusTime(summary.lastRecordAt),
    '点击打开面板'
  ].join('\n');
  statusBar.tooltip = new vscode.MarkdownString(tooltip);
}

function dashboardHtml(context, webview) {
  const mediaRoot = path.join(context.extensionPath, 'media');
  const htmlPath = path.join(mediaRoot, 'dashboard.html');
  const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaRoot, 'dashboard.css'))).toString();
  const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaRoot, 'dashboard.js'))).toString();
  const localtimeUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaRoot, 'localtime.js'))).toString();
  const zoomUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaRoot, 'zoom.js'))).toString();
  const layoutUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaRoot, 'chartLayout.js'))).toString();
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return fs.readFileSync(htmlPath, 'utf8')
    .replace(/\{\{CSS_URI\}\}/g, cssUri)
    .replace(/\{\{JS_URI\}\}/g, jsUri)
    .replace(/\{\{LOCALTIME_URI\}\}/g, localtimeUri)
    .replace(/\{\{ZOOM_URI\}\}/g, zoomUri)
    .replace(/\{\{LAYOUT_URI\}\}/g, layoutUri)
    .replace(/\{\{CSP_SOURCE\}\}/g, webview.cspSource)
    .replace(/\{\{NONCE\}\}/g, nonce);
}

async function loadUsageData() {
  const panel = dashboardPanel;
  if (!panel || !extensionContext) return;
  try {
    const usagePath = path.join(extensionContext.globalStorageUri.fsPath, 'usage.json');
    const text = await fs.promises.readFile(usagePath, 'utf8');
    const data = JSON.parse(text);
    if (!data || !data.days || typeof data.days !== 'object') throw new Error('usage.json days 无效');
    if (dashboardPanel === panel) panel.webview.postMessage({ type: 'data', days: data.days });
  } catch (error) {
    appendLine(`读取 usage.json 失败：${formatError(error)}`);
    if (dashboardPanel === panel) panel.webview.postMessage({ type: 'empty' });
  } finally {
    updateStatusBar();
  }
}

async function loadQuota() {
  const panel = dashboardPanel;
  if (!panel) return;
  try {
    const result = await vscode.commands.executeCommand(CREDIT_COMMAND);
    if (!result || typeof result !== 'object') return;
    latestQuota = result;
    updateStatusBar();
    if (dashboardPanel === panel) panel.webview.postMessage({ ...result, type: 'quota' });
    const reconciliation = await checkReconciliation(result);
    if (dashboardPanel === panel) panel.webview.postMessage({ type: 'reconcile', reconciliation });
  } catch (error) {
    appendLine(`读取额度失败：${formatError(error)}`);
  }
}

function openDashboard() {
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.One);
    return dashboardPanel;
  }
  const mediaRoot = path.join(extensionContext.extensionPath, 'media');
  dashboardPanel = vscode.window.createWebviewPanel(
    'traeUsageChart.dashboard',
    'Trae Usage Chart',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.file(mediaRoot)]
    }
  );
  dashboardPanel.webview.html = dashboardHtml(extensionContext, dashboardPanel.webview);
  dashboardPanel.webview.onDidReceiveMessage(async (message) => {
    if (message && message.type === 'ready') dashboardPanel.webview.postMessage({ type: 'static-ready' });
    if (message && message.type === 'load') {
      await loadUsageData();
      await loadQuota();
      if (dashboardPanel) dashboardPanel.webview.postMessage({ type: 'status', status: getCollectorStatus() });
      updateStatusBar();
    }
  }, undefined, extensionContext.subscriptions);
  dashboardPanel.onDidDispose(() => {
    dashboardPanel = undefined;
  }, undefined, extensionContext.subscriptions);
  return dashboardPanel;
}

function refreshDashboard() {
  if (!dashboardPanel) return openDashboard();
  dashboardPanel.webview.postMessage({ type: 'refresh' });
  updateStatusBar();
  return dashboardPanel;
}
async function diagnose() {
  output.appendLine('--------------------');
  output.appendLine('Trae Usage Chart 诊断');
  output.appendLine('======================');

  const api = getIcubeAI();
  const properties = listPropertyNames(api);
  output.appendLine(`1. vscode.icubeAI 是否存在：${api !== undefined && api !== null}`);
  output.appendLine(`   属性名列表：${properties.length ? JSON.stringify(properties) : '[]'}`);

  const eventIsFunction = typeof api?.onAiTaskComplete === 'function';
  output.appendLine(`2. onAiTaskComplete 是否为函数：${eventIsFunction}`);

  let commands = [];
  try {
    commands = await vscode.commands.getCommands(true);
    output.appendLine(`3. getCommands(true) 是否包含 ${CREDIT_COMMAND}：${commands.includes(CREDIT_COMMAND)}`);
  } catch (error) {
    output.appendLine(`3. getCommands(true) 失败：${formatError(error)}`);
  }

  output.appendLine(`4. 执行 ${CREDIT_COMMAND} 的返回值：`);
  let diagnosticQuota = null;
  try {
    const result = await vscode.commands.executeCommand(CREDIT_COMMAND);
    diagnosticQuota = result;
    output.appendLine(stringifyJson(result));
  } catch (error) {
    output.appendLine(`执行抛错：${formatError(error)}`);
  }

  output.appendLine('5. 最近 3 条 onAiTaskComplete 原始 payload（深度最多 6 层，数组最多 3 项）：');
  if (recentPayloads.length === 0) {
    output.appendLine('（暂无事件 payload；请在 Trae 中完成任务后再次执行本命令）');
  } else {
    recentPayloads.forEach((payload, index) => {
      output.appendLine(`--- payload ${index + 1}/${recentPayloads.length} ---`);
      output.appendLine(JSON.stringify(payload, null, 2));
    });
  }

  const stats = store.getStats();
  const audit = store.getAudit();
  let historyCount = 0;
  try {
    const history = JSON.parse(await fs.promises.readFile(stats.historyPath, 'utf8'));
    historyCount = Array.isArray(history) ? history.length : (Array.isArray(history && history.records) ? history.records.length : 0);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') output.appendLine('   history.json 读取失败：' + formatError(error));
  }
  const daySummary = Object.entries(audit.dayCounts).sort((a, b) => a[0].localeCompare(b[0])).map((item) => item[0].slice(5) + ': ' + item[1]).join('，') || '（无）';
  const collectorStatus = getCollectorStatus();
  const cdpStatus = collectorStatus.cdp || {};
  output.appendLine('6. 数据自检：');
  output.appendLine('   存储目录：' + extensionContext.globalStorageUri.fsPath);
  output.appendLine('   usage.json：' + stats.recordCount + ' 条（' + daySummary + '）');
  const todayKey = dateKey(Date.now());
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 6);
  const startKey = dateKey(cutoff.getTime());
  const recentCount = Object.entries(audit.dayCounts).reduce((sum, [day, count]) =>
    sum + (day >= startKey && day <= todayKey && Number.isFinite(count) ? count : 0), 0);
  // 只把「有记录的日子」计入分母。用 7 做分母会在停用几天后严重低估日均，
  // 让上限剩余天数的估计虚高。
  const activeDays = Object.keys(audit.dayCounts).filter((day) => day >= startKey && day <= todayKey).length;
  const remaining = Math.max(0, 5000 - stats.recordCount);
  const daily = activeDays > 0 ? recentCount / activeDays : 0;
  output.appendLine('   容量：5000 条上限已用 ' + stats.recordCount + ' 条（剩余 ' + remaining
    + ' 条，按活跃日 ' + (activeDays > 0 ? activeDays : '—') + ' 天计日均 '
    + (daily > 0 ? daily.toFixed(1) : '—')
    + ' 条，约可再用 ' + (daily > 0 ? Math.floor(remaining / daily) : '—') + ' 天）');
  output.appendLine('   history.json：' + historyCount + ' 条');
  output.appendLine('   积分合计：' + (audit.creditSum === null ? '—' : audit.creditSum.toFixed(2)));
  output.appendLine('   Token 合计：' + (audit.tokenSum === null ? '—' : audit.tokenSum));
  output.appendLine('   唯一 sid：' + audit.uniqueSidCount + ' 条；无 sid：' + audit.noSidCount + ' 条；重复 sid：' + audit.duplicateSidCount + ' 条');
  output.appendLine('   最近一条记录：' + formatAuditTime(stats.lastRecordAt) + '（本地）');
  output.appendLine('   采集状态：connected=' + (cdpStatus.connected === true) + ' 目标响应=' + (cdpStatus.targetResponseCount ?? 0) + ' 解析成功=' + collectorStatus.parsedCount + ' 最近错误=' + (cdpStatus.lastError || '（无）'));
  const pages = Array.isArray(cdpStatus.targets) ? cdpStatus.targets : [];
  output.appendLine('   已连页面：' + pages.length + ' 个' + (pages.length ? '（' + pages.map((item) => (item.title || '?') + (item.connected ? '' : ' [未连接]')).join('、') + '）' : '') + '；目标发现=' + (cdpStatus.discoveryEnabled === true));

  const reconciliation = await checkReconciliation(diagnosticQuota);
  output.appendLine('   账户 used：' + (Number.isFinite(reconciliation?.lastUsed) ? reconciliation.lastUsed : '—'));
  output.appendLine('   本库积分合计：' + (Number.isFinite(reconciliation?.lastSum) ? reconciliation.lastSum.toFixed(2) : '—')
    + '（基线偏移 ' + (Number.isFinite(reconciliation?.baselineOffset) ? reconciliation.baselineOffset.toFixed(2) : '—')
    + '，当前漂移 ' + formatSigned(reconciliation?.lastDrift) + '）');
  if (reconciliation?.alert === true) output.appendLine('   漏采告警：账户用量比本库记录多 ' + formatSigned(reconciliation.lastDrift) + ' 积分（已连续两次确认）');
  else if (Number.isFinite(reconciliation?.pendingDrift)) output.appendLine('   漏采告警：疑似漏采 ' + formatSigned(reconciliation.pendingDrift) + ' 积分，待下次检查确认');

  output.show(true);
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Trae Usage Chart');
  context.subscriptions.push(output);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'traeUsageChart.open';
  statusBar.show();
  context.subscriptions.push(statusBar);
  store.setOnChange(updateStatusBar);
  updateStatusBar();
  context.subscriptions.push(vscode.commands.registerCommand('traeUsageChart.open', openDashboard));
  context.subscriptions.push(vscode.commands.registerCommand('traeUsageChart.diagnose', diagnose));
  context.subscriptions.push(vscode.commands.registerCommand('traeUsageChart.refresh', refreshDashboard));
  const collectorTimer = setTimeout(() => {
    Promise.resolve(startCollector(context, output)).then(async () => {
      updateStatusBar();
      await checkReconciliation();
    }).catch((error) => {
      appendLine(`采集启动失败：${formatError(error)}`);
    });
  }, 3000);
  context.subscriptions.push({ dispose: () => clearTimeout(collectorTimer) });
}

async function deactivate() {
  try {
    await stopCollector();
  } catch (error) {
    appendLine(`采集停止失败：${formatError(error)}`);
  }
}

module.exports = { activate, deactivate };







