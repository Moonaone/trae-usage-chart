# Trae Usage Chart

[English](README.md) | **简体中文**

一个**离线、纯本地**的 [TRAE CN](https://www.trae.ai/) 用量统计扩展。记录每次 AI 会话消耗的 token、缓存与积分，
并绘制成面板图表。不上传、不联网、无遥测。

> **非官方扩展**，与 TRAE 官方无关。它通过 Chrome DevTools Protocol 读取 TRAE 自身的网络响应，
> 因此 TRAE 升级后可能失效。

---

## 功能

- **总积分 / 请求数 / 总 Token 数**：可选 7 天、30 天、90 天或全部
- **缓存命中率**：缓存读取 token ÷ 输入 token
- **每日活跃热力图**（120 天），可在 token 与积分之间切换
- **堆叠柱状图 / 折线图**：按模型、来源或接口维度；可拖动平移、滚轮缩放，下方带概览缩放条
- **逐次调用明细表**：每页 10 行，显示精确的 token 数与积分
- **状态栏**：常驻显示今日积分；采集异常时显示健康提示

## 使用前提

| 条件 | 说明 |
|---|---|
| 编辑器 | **仅支持 TRAE CN**。它使用了私有的 `vscode.icubeAI` API 和 TRAE 专有命令，**装在 VS Code 上无法工作**。 |
| 调试端口 | TRAE 必须以 `--remote-debugging-port=9222` 启动。不开这个参数，扩展连不上任何东西。 |
| 系统 | Windows（构建脚本是 PowerShell；扩展本身跨平台）。 |

### 开启调试端口

扩展通过 DevTools 协议接入 TRAE 自身的渲染进程来取数。这个端口默认不开，必须给 TRAE 的启动方式加上参数：

1. 右键 TRAE 快捷方式 → **属性**
2. 在 **目标** 一栏的引号外面追加 ` --remote-debugging-port=9222`
3. **完全关闭 TRAE**，然后从这个快捷方式重新启动

验证方法：浏览器打开 `http://127.0.0.1:9222/json/version`，能看到一段 JSON 就说明成功了。

> 安全提示：开放的 DevTools 端口允许本机任意进程检查 TRAE。不要把它暴露到网络上；
> 不再需要这个扩展时，建议把参数去掉。

## 安装

1. 从 [Releases](../../releases) 下载 `trae-usage-chart-0.1.1.vsix`
2. 在 TRAE 中按 `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → 选择该文件
3. 按 `Ctrl+Shift+P` → **Developer: Reload Window**

然后按 `Ctrl+Shift+P` → **Trae Usage Chart: 打开用量面板**。

## 命令

| 命令 | 作用 |
|---|---|
| `Trae Usage Chart: 打开用量面板` | 打开面板 |
| `Trae Usage Chart: 刷新` | 重新读取数据并刷新面板 |
| `Trae Usage Chart: 显示诊断` | 输出连接状态、target 列表和完整的数据自检 |

面板顶部出现黄条时，先跑 **显示诊断** —— 它会告诉你调试端口是否可达、接了几个页面、
以及账户总额与本库记录是否吻合。

## 数据存放在哪

```
%APPDATA%\Trae CN\User\globalStorage\local.trae-usage-chart\
  usage.json          # 已记录的会话
  usage.json.bak      # 上一版备份，用于故障恢复
  history.json        # 可选的历史补录数据
  raw-sample.json     # 最多 3 条原始响应，用于排查接口字段变化
  reconcile.json      # 账户总额与本库记录的差额基线
```

保留策略：90 天或 5000 条，先到为准。裁剪时会输出 `[prune]` 日志。

所有数据都留在你本机。扩展不发起任何对外请求，只做被动监听。

## 采集原理

两个互相独立的环节共同保证数字可信：

1. **CDP 监听**：接入 TRAE 的每个页面 target（主窗口与 Agent 窗口），等待
   `commercial/get_session_usage` 的响应，记录该会话真实的 token 与积分。
   只读取这一个 URL，且会跳过 CORS 预检请求。
2. **跨进程合并**：TRAE 每个窗口一个扩展宿主，若不处理，两个窗口会互相覆盖对方的记录。
   因此每次落盘都会先取锁，再把磁盘上的记录合并进来。

另有一个对账检查：比较账户积分总额与本库记录之和。差额持续增长时会亮黄条提示，
而**不会伪造占位记录** —— 明细表里每一行都来自真实响应。

## 开发

不需要 npm。构建脚本基于 Windows PowerShell 5.1；`build\node.cmd` 会优先使用 PATH 上的
`node`，没有则回退到 TRAE 自带的 Electron（`ELECTRON_RUN_AS_NODE` 模式）。

```bat
build\verify.ps1              :: 语法检查 + 单元测试 + 渲染冒烟测试 + 打包
build\verify.ps1 -Install     :: 以上全部，然后复制到 %USERPROFILE%\.trae-cn\extensions
```

如果你的 TRAE 不在默认路径，先设置 `TRAE_EXE` 环境变量。

```
extension/                  扩展本体
  extension.js              激活、命令、状态栏、webview 宿主、诊断
  cdp.js                    多 target 接入、响应体抓取、退避重连
  collector.js              响应解析
  store.js                  内存账本、跨进程锁、原子落盘、合并、自愈
  media/                    面板（HTML/CSS/JS）与纯函数模块
    cdpPolicy.js            target 白名单、优先级、退避、按连接隔离的去重
    mergePolicy.js          跨进程记录合并、陈旧锁判定
    reconcile.js            差额计算与告警策略
    localtime.js            本地时区日期键
    zoom.js / chartLayout.js  缩放与图表几何（均有单元测试）
build/                      打包与测试工具
  pack.ps1                  自行生成 VSIX 外壳，不依赖任何第三方包
  check-syntax.js           解析全部 .js（能发现「调用了已删除的函数」这类问题）
  selftest.js               纯函数模块与存储层的单元测试
  render-smoke.js           用 DOM 桩执行真实面板代码并断言渲染结果
```

测试是这个扩展可用的前提：渲染冒烟测试会执行真实的面板代码，存储层测试覆盖去重、
自愈、裁剪、原子写入与跨进程合并。

## 已知限制

- 仅在 TRAE 以调试端口启动时可用。
- 依赖 TRAE 私有接口，升级可能失效。跑一次 **显示诊断** 即可确认。
- 账户总额包含安装本扩展之前的消耗，因此永远大于本库合计。这个差额会被记一次基线，
  之后只报告它的**增量**。
- 未上架插件市场，只能通过 VSIX 安装。

## 许可

MIT