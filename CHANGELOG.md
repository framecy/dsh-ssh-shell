# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.4.1] — 未发布

仓库规范化，功能无变化。

- 修复 `extractCwdFromStderr()` 的正则转义错误：`/^\\s+|\s+$/g` 实际匹配的是字面反斜杠，
  导致从 ssh stderr 提取工作目录后**残留的换行从未被修剪**，多出的空行会跟着命令结果
  一起回传给模型。已改为 `/^\s+|\s+$/g`，并有回归测试覆盖。
- 测试从 `/tmp` 迁移进仓库 `tests/`（`/tmp` 会被系统清理，原来那三套脚本已丢失，
  而 README 仍在宣称它们存在）。新增统一入口 `npm test`，共 105 项断言。
- 修正 `package.json`：许可证由 `MIT` 改为 `UNLICENSED`（本仓库为私有、未开源，
  原先的 MIT 声明与实际状态不符），并补上 `repository` / `engines` / `files` / `scripts`。
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
