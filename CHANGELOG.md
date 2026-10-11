# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.0] — 2026-10-11

面板入口收敛 + 重连可控。

- **删除会话头部的「终端」按钮**。它和右侧「终端」竖条功能完全重复，还挤占头部空间。
  现在 `shell.overlay` 的侧边竖条是**唯一入口**（注册的 slot 由 2 个减为 1 个）。
- **新增「停止重连」按钮**：面板处于重连中时出现在标题栏，点了立即取消待执行的重试
  定时器并回到未连接态，**不会**断开已经建立的会话。
- **自动重连改为有上限**：最多 **3 次**，每次间隔固定 **10 秒**。
  - 原先是 1/2/4/8/16/30 秒的无限指数退避，面板可能长时间停在「重连中」，
    用户既等不到结果也没有退出方式。
  - 3 次用尽后主动停下，状态置为出错并明确提示
    「自动重连已达上限（3 次），已停止重试。请检查目标与密码后点「重连」。」
- 进度文案改为「第 N / 3 次，10 秒后重试」，用户能直接看到还剩几次。
- 远端 pty 意外退出（`exit`）的重试也并入同一套预算，不再走原来写死的 800ms × 3，
  避免两条重连路径互相绕过上限。
- 修复一处潜在崩溃：重连常量定义在被引用作用域之外，会导致前端加载即
  `ReferenceError`。已提升到 factory 作用域。
- 测试：客户端断言由 45 增至 53，覆盖「只注册一个 slot」、重连策略数值、
  上限提示与「停止重连」控件的存在。

## [0.4.2] — 2026-10-11

修复桌面版（DeepSeek Harness.app）下面板永远「重连中」的问题。

- **根因**：桌面版把应用页面加载在自有的自定义协议 `dsh-app://app/` 下，
  而不是本地 HTTP 服务器上。在这种渲染进程里 `location.host` 的字面值是
  `"app"`、`location.protocol` 是 `"dsh-app:"`，于是前端拼接 WebSocket 地址的
  `proto + location.host + "/ssh-terminal"` 算出了 `ws://app/ssh-terminal` ——
  一个无法解析的主机名。握手瞬间失败 → 触发 `onclose` →
  `scheduleReconnect()` 指数退避，面板就一直停在
  「连接中断，正在自动重连（第 N 次…）」，而后端其实完全健康。
- **修复**：`wsUrl()` 只在 `http:` / `https:` 这类真实 HTTP origin 下使用
  `location.host`；其他协议（`dsh-app:`、`file:` 等）一律回落到本地 Host
  `127.0.0.1:19387`（桌面版启动时 `--port 19387`）。可用
  `window.__DSH_SSH_SHELL_WS_HOST__` 覆盖，便于自定义部署。
- 新增测试缝 `exports.__wsUrl`（与既有 `__terminalStore` 同类，仅供测试），
  并补 6 条断言覆盖 http / https / dsh-app 三种 origin 与覆盖项。
  客户端测试由 39 条增至 45 条。

## [0.4.1] — 2026-09-28

开源发布，功能无变化。

- 许可证由 `UNLICENSED` 改为 **Apache-2.0**，新增 `LICENSE` 文件；
  README 的 License 段同步更新，并补上 `author` / `bugs` / `homepage`。
- 新增 `devDependencies`（`@deepseek-ai/dsh-tools` / `ws` / `node-pty`）。
  这三个依赖运行时由 DSH 安装自带、经 DSH 加载器解析，插件本身不需要 `npm install`；
  声明它们是为了让 `npm test` 在干净 clone 里也能独立跑起来（此前会直接
  `ERR_MODULE_NOT_FOUND`）。`private` 标记移除，仓库转为公开。
- README 安装说明改写：不再假设读者已经知道 DSH 的 profile 目录布局，
  补上 clone 与 `dsh web` 重启步骤；测试段说明首次需要 `npm install`。
- 修复 `extractCwdFromStderr()` 的正则转义错误：`/^\\s+|\s+$/g` 实际匹配的是字面反斜杠，
  导致从 ssh stderr 提取工作目录后**残留的换行从未被修剪**，多出的空行会跟着命令结果
  一起回传给模型。已改为 `/^\s+|\s+$/g`，并有回归测试覆盖。
- 测试从 `/tmp` 迁移进仓库 `tests/`（`/tmp` 会被系统清理，原来那三套脚本已丢失，
  而 README 仍在宣称它们存在）。新增统一入口 `npm test`，共 105 项断言。
- 修正 `package.json`：补上 `repository` / `engines` / `files` / `scripts`。
- 新增 `__test__` 内部导出，仅暴露纯函数供测试使用，不影响插件对外契约。

## [0.4.0] — 2026-09-22

浮动面板自由调节。

- 拖标题栏移动整个面板；拖四条边或四个角调整宽高（九种拖拽模式）。
- 几何（x / y / 宽 / 高）按标签页持久化到 `sessionStorage`，刷新后仍在。
- 钳位在可视区域内：最小 340×240，且始终保留可抓握的标题栏区域，面板拖不出屏幕外。
- 窗口缩小后把超出可视区域的部分拉回来。
- 拖动结束把新的行列数同步给远端 PTY，全屏程序（vim / top）跟着变。
- `measureSize` 在面板隐藏（`display:none` 使 `clientWidth` 为 0）时回落到几何值，
  不再上报极小尺寸。

## [0.3.0] — 2026-09-18

断连治理。

- pty 按 target 持久化：面板折叠、页面刷新、切标签页都不再杀掉远端 shell。
- SSH 双保活：`ServerAliveInterval=30` + `TCPKeepAlive=yes`，抗 NAT / 防火墙 / sshd 掐断静默连接。
- WebSocket 空闲看门狗：25s 一次 ping，60s 无响应即断开该客户端（不动 pty）。
- pty 意外退出而 master 还活着时原地重建，订阅者自动迁移（最多 3 次）。
- 前端指数退避自动重连（1/2/4/8/16/30 秒），凭据存当前标签页。
- 修正 `connect()` 的过期闭包与凭据 memo 失效问题。

## [0.2.0] — 2026-09-16

初版 WebSocket 终端面板。

- 浏览器右侧浮动终端面板，真实 PTY（`node-pty` + `ssh -tt`），原始终端模式、
  方向键、Ctrl+C、全屏程序、Tab 补全均正常。
- 后端经 `/ssh-terminal` WebSocket 路由桥接。
