# Trae Usage Chart

**English** | [简体中文](README.zh-CN.md)

[![tests](https://github.com/Moonaone/trae-usage-chart/actions/workflows/tests.yml/badge.svg)](https://github.com/Moonaone/trae-usage-chart/actions/workflows/tests.yml)

An **offline, local-only** usage monitor for [TRAE CN](https://www.trae.ai/). It records how many tokens and credits
each AI session consumes, and draws them as an overview dashboard — no account upload, no telemetry, no network calls.

> **Unofficial.** This extension is not affiliated with or endorsed by TRAE. It reads TRAE's own local network
> traffic through the Chrome DevTools Protocol, so it may stop working after a TRAE update.

---

## What it shows

- **Total credits / requests / tokens** for the selected range (7 / 30 / 90 days or all)
- **Cache hit rate** — cache-read tokens over input tokens
- **Daily activity heatmap** (120 days), switchable between tokens and credits
- **Stacked bar / line chart** by model, source or endpoint — drag to pan, wheel to zoom,
  with an overview scrubber
- **Per-call detail table** (10 rows per page) with exact token counts and credits
- **Status bar** entry showing today's credits, plus a health indicator when collection stops working

## Requirements

| Requirement | Detail |
|---|---|
| Editor | **TRAE CN only.** Uses the private `vscode.icubeAI` API and a TRAE-specific command; it does **not** work in VS Code. |
| Debug port | TRAE must run with `--remote-debugging-port=9222`. Without it the extension can connect to nothing. |
| OS | Windows (the build scripts are PowerShell; the extension itself is portable). |

### Enabling the debug port

The extension gets data by attaching to TRAE's own renderer over the DevTools Protocol. That port is not on by
default, so you must launch TRAE with the flag:

1. Right-click your TRAE shortcut → **Properties**
2. In **Target**, append ` --remote-debugging-port=9222` after the quoted executable path
3. Close TRAE completely, then start it from that shortcut

Verify it worked: open `http://127.0.0.1:9222/json/version` in a browser — you should see a JSON document.

> Security note: an open DevTools port lets any local process inspect TRAE. Do not expose it to a network,
> and consider removing the flag when you no longer need the extension.

## Install

1. Download `trae-usage-chart-0.1.1.vsix` from [Releases](../../releases)
2. In TRAE: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file
3. `Ctrl+Shift+P` → **Developer: Reload Window**

Then `Ctrl+Shift+P` → **Trae Usage Chart: 打开用量面板**.

## Commands

| Command | What it does |
|---|---|
| `Trae Usage Chart: 打开用量面板` | Opens the dashboard |
| `Trae Usage Chart: 刷新` | Re-reads data and updates the panel |
| `Trae Usage Chart: 显示诊断` | Prints connection state, target list and a full data self-check |

If the panel shows a yellow banner, run **显示诊断** first — it tells you whether the debug port is reachable,
how many pages are attached, and whether the account total and local records agree.

## Where data lives

```
%APPDATA%\Trae CN\User\globalStorage\local.trae-usage-chart\
  usage.json          # recorded sessions
  usage.json.bak      # previous copy, used for recovery
  history.json        # optional imported backlog
  raw-sample.json     # up to 3 raw responses, for debugging field changes
  reconcile.json      # account-vs-records drift baseline
```

Retention: 90 days / 5000 records, whichever comes first. Old data is trimmed with a `[prune]` log line.

Nothing leaves your machine. The extension makes no outbound requests; it only listens.

## How it collects

Two independent capture points keep the numbers honest:

1. **CDP listener** — attaches to every TRAE page target (main window and the Agent window), waits for
   `commercial/get_session_usage` responses, and records the real per-session numbers.
   Only that one URL is ever read; preflight requests are skipped.
2. **Cross-process merge** — TRAE runs one extension host per window, so two windows would otherwise overwrite
   each other's records. Every save takes a lock file and merges the on-disk copy before writing.

A reconciliation check compares the account's credit total against the sum of recorded sessions. A growing gap
raises a warning instead of inventing a placeholder row — every record in the table comes from a real response.

## Development

No npm. The build scripts use Windows PowerShell 5.1, and `build\node.cmd` runs JavaScript with either a
standalone `node` on `PATH` or TRAE's bundled Electron in Node mode (`ELECTRON_RUN_AS_NODE`).

```bat
build\verify.ps1              :: syntax + unit tests + render smoke test + package
build\verify.ps1 -Install     :: the above, then copy into %USERPROFILE%\.trae-cn\extensions
```

If your TRAE is not at the default path, set `TRAE_EXE` before building.

```
extension/                  the extension itself
  extension.js              activation, commands, status bar, webview host, diagnostics
  cdp.js                    multi-target CDP attachment, body capture, backoff
  collector.js              response parsing
  store.js                  in-memory ledger, cross-process lock, atomic save, merge, healing
  media/                    dashboard (HTML/CSS/JS) and pure-function modules
    cdpPolicy.js            target eligibility, priority, backoff, per-connection dedupe
    mergePolicy.js          cross-process record merge, stale-lock detection
    reconcile.js            drift math and alert policy
    localtime.js            local-timezone date keys
    zoom.js / chartLayout.js  zoom and chart geometry, unit-tested
build/                      packaging and test harness
  pack.ps1                  generates the VSIX shell itself — no third-party package needed
  check-syntax.js           parses every .js (catches deleted-function references)
  selftest.js               unit tests for the pure modules and the store
  render-smoke.js           runs the dashboard against a DOM stub and asserts it renders
```

Tests are the reason this thing is usable: the render smoke test executes the real dashboard code, and the store
tests cover deduplication, healing, pruning, atomic writes and cross-process merging.

## Limitations

- Works only while TRAE runs with the debug port enabled.
- Uses TRAE's private internals; a TRAE update can break it. Run **显示诊断** to check.
- The account total includes usage from before the extension was installed, so it will always exceed the
  recorded sum. That gap is baselined once and only *growth* of it is reported.
- No marketplace publishing — install from the VSIX file.

## License

MIT
