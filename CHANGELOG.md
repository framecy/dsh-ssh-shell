# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.0] — 2026-09-28

用竖条描边表达连接状态；入口收敛为一处。

- 右侧「终端」竖条的**描边本身就是连接状态指示**，不用打开面板就能看出会话状态：
  灰 = 未连接、琥珀（发光呼吸）= 连接中／重连中、绿 = 已连接、红 = 连接断开。
  竖条贴着屏幕右缘，因此只有上/左/下三边有描边，右边留空（逐边声明，
  避免 `border` 简写落在 `borderRight` 之后又把右边线带回来）。
- 呼吸效果只动 `box-shadow`，不动 `opacity`——动 opacity 会把「终端」两个字
  一起变淡，每周期掉两次可读性。已在真实 Chrome 采样验证：
  发光在 3px↔14px 之间变化，文字透明度恒为 1。
- 连接状态由面板镜像到共享 store（`getStatus` / `setStatus`），
  快照是字符串原语，满足 `useSyncExternalStore` 的稳定性要求。
- **移除会话头部的「终端」按钮**：入口只保留右侧竖条。原来两个入口功能重复，
  且头部按钮会占掉会话头区域的空间。
- 新增 `__terminalPanelBody` / `__panelSetStatus` 测试导出，让测试能驱动面板真实的
  React 状态链路，而不是绕过组件直接改 store。
- 清理测试里只写不读的死脚手架（`useStateCalls` / `useStateSetters` / `observed.status`），
  并修正一处重复的章节编号。断言数 105 → 162。

## [0.4.1] — 2026-09-28

开源发布。

- 许可证由 `UNLICENSED` 改为 **Apache-2.0**，新增 `LICENSE` 文件；
  README 的 License 段同步更新，并补上 `author` / `bugs` / `homepage`。
- `private` 标记移除，仓库转为公开。
- 依赖声明修正：`node-pty` / `ws` 移入 `dependencies`（本插件自己要用，随插件安装），
  `@deepseek-ai/dsh-tools` 移入 `peerDependencies`（由 DSH 宿主提供）。
  此前三者都缺失，干净 clone 后 `npm test` 会直接 `ERR_MODULE_NOT_FOUND`。
- `cordis.patch.yml` 的 `name` 由本机相对路径改为裸包名 `dsh-ssh-shell`，
  否则别人装上去后加载器解析不到模块。
- README 安装说明改写：补上 `dsh plugin add` 的推荐装法、DSH 前置条件与重启步骤，
  并说明本地软链接方式必须写相对路径。
- 修复 `extractCwdFromStderr()` 的正则转义错误：`/^\\s+|\s+$/g` 实际匹配的是字面反斜杠，
  导致从 ssh stderr 提取工作目录后**残留的换行从未被修剪**，多出的空行会跟着命令结果
  一起回传给模型。已改为 `/^\s+|\s+$/g`，并有回归测试覆盖。
- 测试从 `/tmp` 迁移进仓库 `tests/`（`/tmp` 会被系统清理，原来那三套脚本已丢失，
  而 README 仍在宣称它们存在）。新增统一入口 `npm test`，当时 105 项断言。
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
