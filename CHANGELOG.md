# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.6.1] — 2026-10-18

修复桌面版面板「始终连接失败」——即使地址和密码都正确。

- **根因**：桌面版把页面加载在 `dsh-app://app/` 下，`location.host` 是 `"app"`。
  0.4.2 为此写死了回落端口 `127.0.0.1:19387`，但当前桌面版启动 Host 用的是
  `--port 0`（每次启动换一个随机端口，本次是 52326）。写死的 19387 上没有服务，
  WebSocket 瞬间被拒 → 面板报「连接失败」/重连耗尽，而 Host 和远端 SSH 本身都健康。
- **修复**：改为读取桌面外壳发布的真实 Host origin
  （`window.__DSH_TRANSPORT__.streamBaseUrl`，与外壳自己的流用同一个值），再拼
  `/ssh-terminal`；http 升级为 ws、https 升级为 wss。取不到该 origin 时才回落到
  旧的 19387，`window.__DSH_SSH_SHELL_WS_HOST__` 覆盖仍然有效。
- WebSocket 出错时的提示补上**实际尝试的地址**，下次端口再变能一眼看出打到了哪。
- 测试：客户端断言 110 → 114，新增「桌面用真实随机端口」「https → wss」
  「非法 transport 值不采信」「无 transport 才回落 19387」四条。
- 改完必须重启桌面 App（或重载窗口）才会加载新的前端 bundle。

## [0.6.0] — 2026-10-12

合并两条并行开发线：竖条描边状态 + 依赖与安装声明修正。

> 说明：本地曾有一批改动也标为 `0.5.0` 但从未推送，与远端已发布的 `0.5.0`
> （单入口 + 有界重连）内容不同。两条线合并后内容有实质新增，故升为 `0.6.0`，
> 已发布的 `0.5.0` / `0.4.2` / `0.4.1` 条目保持原样不改写。

- **一眼看出连接状态**：右侧「终端」竖条的**描边本身就是状态指示**，不用打开面板：
  灰 = 未连接、琥珀（发光呼吸）= 连接中／重连中、绿 = 已连接、红 = 连接断开。
  竖条贴着屏幕右缘，因此只有上/左/下三边有描边，右边留空（逐边声明，
  避免 `border` 简写落在 `borderRight` 之后又把右边线带回来）。
- 呼吸效果只动 `box-shadow`，不动 `opacity`——动 opacity 会把「终端」两个字
  一起变淡，每周期掉两次可读性。已在真实 Chrome 采样验证：
  发光在 3px↔14px 之间变化，文字透明度恒为 1。
- 连接状态由面板镜像到共享 store（`getStatus` / `setStatus`），
  快照是字符串原语，满足 `useSyncExternalStore` 的稳定性要求；
  竖条悬停提示也会显示当前状态。
- 新增 `__terminalPanelBody` / `__panelSetStatus` 测试导出，让测试能驱动面板真实的
  React 状态链路，而不是绕过组件直接改 store。
- **依赖声明修正**：`node-pty` / `ws` 移入 `dependencies`（本插件自己要用，随插件安装），
  `@deepseek-ai/dsh-tools` 移入 `peerDependencies`（由 DSH 宿主提供）。
  此前三者都只在 `devDependencies` 里，按插件安装后运行时解析不到。
- `cordis.patch.yml`：`name` 由本机相对路径改为裸包名 `dsh-ssh-shell`，
  否则别人装上去后加载器解析不到模块；同时删除 `confirmByDefault` /
  `requireSshpass` 两个配置项——它们在文档和 patch 里声明，但代码从未读取
  （全文搜索 0 处引用）。确认是安全边界，刻意不提供关闭开关。
- README 安装说明改写：补上官方装法 `dsh plugin add github:framecy/dsh-ssh-shell`，
  并说明本地软链接方式必须写相对路径（包名仅在安装后才可解析）。
- 测试：客户端断言 53 → 110（三套合计 119 → 176），新增描边状态色
  （五状态 × 四边）、无独立状态圆点、呼吸只动 `box-shadow`、悬停提示等断言；
  并清理测试里只写不读的死脚手架。
- **放宽 `@deepseek-ai/dsh-tools` 的 peer 范围**：原声明逐版本枚举到 `^0.1.7-rc.1`，
  不含当前桌面版运行时实际使用的 `0.2.0-rc.2`。DSH 的插件管理器会据此**拒绝安装并回滚**
  （`incompatible-version`），所以插件在桌面版上根本装不进去。改为
  `>=0.0.1-rc.1 <0.3.0`。放宽有实测依据：插件只用到 `defineTool` 一个 API，
  已在该 API 存在的 `0.1.7-rc.2` / `0.2.0-rc.2` / `0.2.1-alpha.1` 三个版本上
  验证签名一致（均为单参数），并在桌面版运行时里真实加载 `apply` 成功。

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
