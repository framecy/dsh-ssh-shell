# Changelog

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.7.4] — 2026-10-20

修掉真正的运行时崩溃：**`TypeError: ctx.logger(...) is not a function`，
它让宿主把整个插件条目判为 "did not activate"**（面板没路由、对话里没工具、技能不写）。

- **根因**：插件把宿主的日志服务当成了 `ctx.logger(level)(message)` 用。
  宿主（cordis `LoggerService`）的真实形状是 **`ctx.logger(name)` 返回一个具名 logger 对象**，
  方法在对象上：`.warn()/.info()/.error()/.debug()/.verbose()`。
  于是 `ctx.logger("warn")(...)` 变成「拿 Logger 对象当函数调」，直接抛 TypeError。
- **为什么整条插件挂掉**：这个抛错发生在 `apply()` 内部的 `installSkill()` 里。
  它先被 `installSkill` 自己的 `catch` 捕获，可 catch 里又用同样的坏形状记日志，
  于是第二次抛出、逃出 `apply()`，宿主按「条目未激活」处理，后面注册工具与路由全部不执行。
- **修复**：新增 `log(ctx, level, message)`，优先走真实形状
  （`ctx.logger(name)[level](msg)`），兼容旧的 `ctx.logger(level)(msg)`，
  整段 `try/catch` 兜底 —— **日志出错绝不允许拖垮插件**。五处调用点全部改用它。
- **测试为什么没拦住**：三处测试假件把 logger 写成了 `(level) => (message) => …`，
  等于把错误契约固化进了测试。现已改为宿主真实形状 `(name) => ({ warn, info, error })`。
  复现与验证：用真实形状的假 ctx 跑 `apply()`，0.7.3 报出与宿主完全一致的那条 TypeError；
  0.7.4 正常返回 `["ssh_remote","ssh_terminal_send","ssh_terminal_read"]` 与 `/ssh-terminal` 路由，
  并记录一条 info 日志。

## [0.7.3] — 2026-10-20

让插件不再依赖宿主注入才能加载：去掉对 `@deepseek-ai/dsh-tools` 的裸导入，
改在文件内保留一个等价的一行实现。**运行时行为不变**。

- **改了什么**：`lib/index.js` 原本 `import { defineTool } from "@deepseek-ai/dsh-tools"`，
  该包只导出 `(definition) => definition` 这一个恒等函数。现在文件内自带同名实现，
  三处调用点一字未改。
- **为什么值得改**：去掉这条裸导入后，插件在只装了 `ws` + `node-pty` 的目录里
  也能直接 `import` 并 `apply()`，不再需要宿主那套模块拦截层在场。
  这让自动化测试和脱离宿主的排障都变简单。
  已验证：故意让 `@deepseek-ai/dsh-tools` 不可解析时 `npm test` 三套全绿；
  在干净目录里导入得到 `name=ssh-shell`、`inject` 三项齐全、`apply` 为函数，
  且 `apply()` 用假 ctx 跑出 `["ssh_remote","ssh_terminal_send","ssh_terminal_read"]`
  与 `/ssh-terminal` 路由。
- **更正一条此前的误判**：本次开发过程中一度认为「0.7.0 → 0.7.2 三版都因为这条
  裸导入在 ESM 链接阶段崩掉」，**这个说法是错的**，已从文档撤回。
  宿主的模块加载器会读插件 `package.json` 的 `peerDependencies`（`readPeerNames`），
  为这些裸模块名建立 interception 路由，指向宿主自带的那份 —— 所以插件里
  `import "@deepseek-ai/dsh-tools"` 在宿主内是**能解析的**，0.7.1 在桌面版里
  也确实正常注册了三个工具。0.7.0 的失败仍是 0.7.1 记录的那条：工具重名让
  `apply()` 中途抛错，测试可复现。
- `peerDependencies` 声明保留，仅表达版本兼容意图。

## [0.7.2] — 2026-10-20

## [0.7.2] — 2026-10-20

发版工程改动，不影响运行时行为。

- `@deepseek-ai/dsh-tools` 不再写进 `devDependencies`，只保留 `peerDependencies`。
- 新增 `scripts/link-host-deps.mjs`：从 DSH 宿主软链一份 `dsh-tools` 供测试使用，
  `npm test` 自动调用（`pretest`），并可 `--host` 指定宿主目录。
  这条软链只作用于本地测试，不进 profile 的依赖树。
- README 补充测试说明与上述约束。

## [0.7.1] — 2026-10-20

修掉 0.7.0 在桌面版上**整个插件装不上**的问题：面板能连、后端正常，但对话里没有 `ssh_remote` 工具。

- **根因**：本插件注册了 `terminal_send` / `terminal_read`，而 DSH 自带的
  `@deepseek-ai/dsh-tool-terminal` 已经占用了这两个名字（它还占 `terminal_open` /
  `terminal_signal` / `terminal_close` / `terminal_list`）。`ctx.tools.register()`
  遇到重名会直接抛错（`tool "terminal_send" is already registered`），
  而这次抛错发生在 `apply()` 中间——`ssh_remote` 已经注册成功，
  但 `apply()` 中断后宿主把**整个插件条目**判为「did not activate」，
  于是三个工具一个都不出现在对话里。
  桌面版崩溃日志里的 `dsh-ssh-shell: import failed` 就是这条。
  已用模拟宿主复现：内置工具存在时 `apply()` 抛错，成功注册的只剩 `ssh_remote`。
- **修复**：两个面板工具改名为 `ssh_terminal_send` / `ssh_terminal_read`，
  与本插件的 `ssh_remote` 一起构成无冲突的 `ssh_` 前缀族。
- **加固**：新增 `registerToolSafely()`，把每个 `ctx.tools.register()` 包起来。
  遇到 `already registered` 只记一条 warn 并跳过**那一个**工具，其余照常加载；
  其他错误仍然照常抛出，不吞错。今后任何一处重名都不会再拖垮整个插件。
- 技能 `SKILL.md`、README、工具描述里的名字同步更新，并写明「内置 terminal_* 操作的是
  DSH 自己的终端，不是本插件的 SSH PTY」，避免模型调错工具。
- 测试：terminal 38 → 53，新增「三个工具名都不与内置族冲突」
  「全部重名时 apply() 不抛错、逐个 warn、其余仍加载」「无关注册错误仍然抛出」等断言。

## [0.7.0] — 2026-10-20

修掉用户反馈最痛的那个问题：**面板里连上了远端服务器，对话里却识别不到这个会话**。

- **根因**：会话表是模块级常量（`const sessions = new Map()` /
  `const terminalRegistry = new Map()`）。DSH 会在同一个进程里加载本插件两次——
  宿主自己一份，插件管理器为验证更新再加载已安装副本——两个模块实例各有自己的模块作用域，
  于是各自持有一份**互不相通的空 Map**。浏览器面板把 pty 写进赢了 `/ssh-terminal` 路由的那一份，
  而模型用的工具读的是另一份：`ssh_remote action=status` 报 0 条，
  `terminal_read` 报 `no active terminal`，用户却正对着一个活着的终端。
  这不是"面板没连上"，是两边根本不是同一张表。
- **修复**：会话表改挂在 `globalThis[Symbol.for("dsh-ssh-shell.shared")]`。
  `Symbol.for` 是跨 realm 注册表，同一进程里任意份数的模块实例（含热重载）都落到同一个对象上。
  `lastTerminalKey` 一并移入共享对象。
- **`status` 现在能看见面板会话**：除模型自己 `connect` 的之外，还列出面板连上的，
  标 `source: "gui-panel"`，并带上 `cwd` / `alive` / `hasTerminal`。
  零会话时不再只回一个 `0 active ssh session(s)`，而是明说「没有会话，
  可以去面板连，或调用 action=connect」。
- **`exec` / `close` 接受面板会话**：目标有面板 pty 但 `sessions` 里没有时，
  直接接管那条已认证的会话（不再要求重新输密码），而不是回 `call action=connect first`。
- **新增自带技能 `skills/ssh-shell/SKILL.md`**：启动时自动装到
  `$DSH_HOME/skills/ssh-shell/SKILL.md`，装插件即带技能，不用手工复制。
  技能写明铁律——**说"没有会话"之前先查 `ssh_remote action=status`**，
  并区分面板会话（`terminal_send` / `terminal_read`，不逐条确认）与自连会话（`exec`，逐条确认）。
  内容相同的副本不会重写，避免每次启动都惊动 skills 的文件监听。
  新增配置 `installSkill`（默认 `true`），设 `false` 可自行管理技能。
- **`package.json`**：`files` 补上 `skills`，否则发到 npm / 从 GitHub 安装时技能文件不随包走。
- 修正 `lib/index.js` 顶部注释里那句「paired with a companion SKILL.md」——
  以前只是句承诺，仓库里根本没有那个文件，现在是真的有了。
- 测试：core 47 → 68，terminal 19 → 38（三套合计 176 → 220），新增
  「跨模块实例共享同一张会话表」「status 列出 gui-panel 会话」「terminal_read/send 无 target 也能命中面板终端」
  「零会话时给出可操作的说明」「技能路径/内容/幂等安装/安装失败只告警」等断言。
  测试调 `apply()` 一律传 `installSkill: false`，不写开发机真实的 `~/.dsh/skills`。

## [0.6.2] — 2026-10-20

修复在桌面端「更新到 0.6.1 失败、并被自动回滚」的问题。

- **根因**：`apply()` 每次都无条件 `ctx.webServer.registerUpgrade()` 注册
  `/ssh-terminal`。该路由是进程级的，同一进程里第二次 `apply()`（宿主已加载本插件，
  插件管理器又加载已安装副本做更新后的激活验证）会抛
  `webserver: duplicate upgrade route`，宿主因此把该条目记为
  「1 entry did not activate」，市场判定更新后的组合不可用并回滚。
  pnpm 每一步其实都成功过——失败在加载验证，不在安装。
- **修复**：注册失败且原因是「duplicate upgrade route」时降级为一条 warn 日志并复用
  已注册的那条路由（每条连接本就自带 `WebSocketServer`，pty 注册表是模块级的，
  第二条路由只是同一批会话的第二个入口）。其他原因仍然照常抛出，不吞错。
- 测试：terminal 断言 19 → 23，新增「重复路由不使 apply() 失败」「重复路由只记一次
  warn」「其他 registerUpgrade 错误仍然冒出」。

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
