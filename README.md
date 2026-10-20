# dsh-ssh-shell

DSH 插件：用密码直连远程主机的 SSH 终端。一个自然语言工具（`connect` / `exec` / `close` / `status`）+ 浏览器右侧浮动终端面板，底层是 OpenSSH ControlMaster 常驻会话 + `sshpass` + `node-pty` 起的真实 PTY，经 WebSocket 桥到浏览器。

**核心目标：不再频繁断连，断了能自己回来。**

## 能力

- **SSH 工具**（对话里用）：`ssh_remote` 一次建立连接，之后每次远程命令都先向用户确认；`ssh_terminal_send` / `ssh_terminal_read` 直接操作面板里那个活的终端，不逐条确认。
- **浏览器终端面板**：右侧浮动面板，真实 PTY —— 原始终端模式、方向键、全屏程序、Ctrl+C / Ctrl+D / Tab 补全都正常。
- **一眼看出连接状态**：入口竖条自己的描边就是状态指示 —— 灰=未连接、琥珀（呼吸）=连接中/重连中、绿=已连接、红=连接断开，不用打开面板。
- **断连自愈**：
  - `ControlMaster` + `ControlPersist=yes` —— master 常驻，不闲置回收；
  - SSH 双保活：`ServerAliveInterval=30` + `TCPKeepAlive=yes`，抗 NAT / 防火墙 / sshd 掐断静默连接；
  - WebSocket 空闲看门狗：25s 一次 ping，60s 无响应即断开这个客户端（**不动 pty**）；
  - pty 意外退出而 master 还活着时原地重建，订阅者自动迁移（最多 3 次）；
  - 前端自动重连：**最多 3 次，每次间隔 10 秒**；可手动「停止重连」，用尽后自动停下并说明原因。凭据存当前标签页。
- **面板隐藏不断线**：折叠面板只切 `display:none`，socket 和 pty 都活着，展开即续。

## 安装

前置条件：已经装好 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)，并且有一个能跑的 profile（下面以 `web` 为例）。

**方式一：从 GitHub 安装（推荐）**

```bash
dsh plugin --profile web add github:framecy/dsh-ssh-shell
```

装完重启该 profile。仓库根目录的 `cordis.patch.yml` 会被自动应用，不需要手工编辑配置。

**方式二：本地开发（软链接）**

改代码即生效，适合调试：

```bash
git clone https://github.com/framecy/dsh-ssh-shell.git
ln -s "$PWD/dsh-ssh-shell" ~/.dsh/profiles/web/plugins/dsh-ssh-shell
```

然后在 profile 的 `cordis.patch.yml` 里手工挂上这一行。**这种本地路径方式必须写相对路径，不能写包名**（包名只在 `dsh plugin add` 装好之后才解析得到）：

```yaml
- insert:
    - id: ssh-shell
      name: './plugins/dsh-ssh-shell/lib/index.js'
```

**重启 DSH**

插件只在进程启动时加载，改完必须重启：

```bash
# 停掉当前的 dsh 进程（Ctrl+C，或 kill 掉对应 pid），然后重新启动
dsh web
```

重启后浏览器刷新页面（前端 `client.js` 是页面加载时取的）。

> 装好后，右侧边缘会出现「终端」竖条（**唯一入口**，点它即可打开面板，不占会话头部空间）。

> **工具名为什么带 `ssh_` 前缀**：DSH 自带的终端插件已经占用了
> `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` /
> `terminal_close` / `terminal_list` 这六个名字。`ctx.tools.register()` 遇到重名会**抛错**，
> 而抛错发生在 `apply()` 里会让宿主把整个插件判为「未激活」——表现就是
> **面板能连、后端完全正常，但对话里没有 `ssh_remote` 工具**。
> 所以本插件的工具统一加前缀：`ssh_remote` / `ssh_terminal_send` / `ssh_terminal_read`。
> 内置那套终端工具操作的是 DSH 自己的终端，不是本插件的 SSH PTY，别混用。

插件启动时还会把自带的技能装到 `$DSH_HOME/skills/ssh-shell/SKILL.md`（默认 `~/.dsh/skills/`）。
**装插件就自动带上技能，不需要手工复制**。技能告诉 agent：面板连上的会话和它自己连的会话是同一批，
先查 `ssh_remote action=status` 再说话。不想让它管技能就在配置里设 `installSkill: false`。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `ssh` | OpenSSH 客户端，提供 ControlMaster |
| `sshpass` | 非交互密码认证。`brew install sshpass`（需要 keepalive tap）或 `brew install esolv/sshpass/sshpass` |
| `node-pty` | 后端起 PTY 用；作为本插件的依赖自动安装，无需手工处理 |

缺 `sshpass` 时连接会直接失败并给出明确报错。

## 配置

`cordis.patch.yml` 提供这些配置项（由插件自身的 bundle patch 声明，profile 级 `cordis.patch.yml` 可按 id 覆盖）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `controlDir` | `""` → `~/.dsh/ssh-shell` | ControlMaster socket 存放位置 |
| `timeoutMs` | `30000` | 单条命令默认超时 |
| `controlPersistSeconds` | `""` → `yes` | 留空 = master 常驻直到自己死；填秒数 = 闲置这么久后回收 |
| `installSkill` | `true` | 启动时把自带技能装到 `$DSH_HOME/skills/ssh-shell/` |

远程命令**始终**逐条向用户确认（走 DSH 的 approval 通道），没有关闭它的开关——这是刻意的：确认是安全边界，不该被一个配置项悄悄关掉。

> **桌面版（DeepSeek Harness.app）**：桌面版把页面加载在自有协议 `dsh-app://app/` 下，
> 该 origin 下 `location.host` 是 `"app"`、无法用作 WebSocket 主机名。插件改为读取
> 桌面外壳发布的真实 Host origin（`window.__DSH_TRANSPORT__.streamBaseUrl`）再拼
> `/ssh-terminal`——桌面版每次启动用 `--port 0` 随机端口，写死端口会在下次启动就失效。
> 只有当该 origin 取不到时才回落到旧的固定端口 `127.0.0.1:19387`；仍可用
> `window.__DSH_SSH_SHELL_WS_HOST__ = "127.0.0.1:<port>"` 手工覆盖。

## 用法

**对话里（工具）**

> `ssh root@1.2.3.4 -p 22`，密码 `xxx`，连上后看一下 `/var/log` 里最近的报错

第一次连接不确认；之后每条远程命令都会把确切命令写出来让你确认。长时间任务传 `run_in_background: true`，用 `job_output` 增量读。

**面板（GUI）**

点右侧边缘的「终端」竖条（**唯一的入口**）。填 `root@1.2.3.4 -p 22` + 密码，连接。

- 面板是个浮动窗口：**拖标题栏移动位置**，**拖四条边或四个角调整大小**（最小 340×240，不会超出可视区域，也拖不到屏幕外）；
- 尺寸和位置记在当前标签页，刷新后还在；窗口变小时面板会被拉回可视区域内；
- 拖动结束即把新的行列数同步给远端 PTY，全屏程序（vim / top / htop）跟着变；
- 竖条**自身的描边**就是连接状态指示（竖条贴着屏幕右缘，所以只有上/左/下三边有描边，右边留空）：
  灰色 = 未连接，琥珀色（发光呼吸）= 连接中／重连中，绿色（淡淡发光）= 已连接，红色（淡淡发光）= 连接断开；
  鼠标悬停在竖条上也能看到文字说明；
- 最小化面板**不会**断开 SSH；
- 断线会自动重连，**最多 3 次、每次间隔 10 秒**，进度写在面板上；
- 重连过程中可随时点标题栏的「停止重连」取消；3 次用尽后会自动停下并说明原因，
  不会无限重试，需要时点「重连」再试；
- 只有「断开」按钮和 master 真的死了才会结束会话。

**凭据只存在当前标签页**（`sessionStorage`），关掉标签页即清除，不会写到磁盘。

**面板连上的会话，对话里也看得见**

这是本插件最容易踩的坑：面板和对话工具过去可能各自持有一份会话表，于是面板里明明连着、
agent 却回「没有会话」。现在两者**共用同一份进程级会话表**，并且：

- `ssh_remote action=status` 会同时列出面板连上的会话，标 `source: "gui-panel"`；
- 面板会话已经认证过，**不会再问密码**，直接 `ssh_terminal_send` / `ssh_terminal_read` 操作；
- 对面板会话跑 `ssh_remote exec` 会直接接管那条会话，不需要重新 connect。

agent 在说「没有会话」之前必须先查 `status`——这条约定写在插件自带的
`skills/ssh-shell/SKILL.md` 里，装插件时自动生效。

## 工具速查

三个工具，别和内置的 `terminal_*` 混用（那套操作 DSH 自己的终端）：

| 工具 | 干什么 | 要确认吗 |
|---|---|---|
| `ssh_remote` | `connect` / `exec` / `close` / `status`。自己连会话、跑一次性命令 | `exec` 每条都确认 |
| `ssh_terminal_send` | 往**面板里那个活终端**敲键盘（`data: "ls\r"`） | 不确认 |
| `ssh_terminal_read` | 读那个终端最近的输出（可 `clear: true` 读增量） | 不确认 |

常用写法：

```
ssh_remote          { action: "status" }                          # 先看有什么会话
ssh_remote          { action: "connect", target: "root@1.2.3.4 -p 22", password: "..." }
ssh_remote          { action: "exec", target: "root@1.2.3.4", command: "df -h" }
ssh_remote          { action: "exec", command: "tail -f /var/log/nginx/error.log", run_in_background: true }
ssh_terminal_read   {}                                            # 面板终端当前停在哪
ssh_terminal_send   { data: "systemctl status nginx\r" }          # 回车 = \r
ssh_terminal_read   { clear: true }                               # 读增量
```

转义：`\r` 回车、`\x03` Ctrl+C、`\x1b[A` 上箭头、`\t` Tab 补全。

## 设计取舍

pty 归属于 **target**（`user@host:port`），不归属任何单个 WebSocket。理由：

- 面板折叠、页面刷新、切 tab、网络抖动都不该杀掉远端 shell；
- 只有显式 `type:"close"` 或 master 死亡才真正结束；
- master 活着时浏览器**永远不需要重新输密码**。

会话表挂在 `globalThis`（`Symbol.for("dsh-ssh-shell.shared")`）上，而不是模块常量。
因为 DSH 可能在同一进程里加载本插件两次（宿主自己一份 + 插件管理器为验证更新加载已安装副本），
模块常量会让两份各自持有一个空 Map——这正是「面板连上了但会话无法识别」的根因。

## 测试

```bash
npm install       # 首次：装 ws / node-pty（npm 会因 peer 报 ERESOLVE，加 --legacy-peer-deps）
npm test          # 自动链接宿主的 @deepseek-ai/dsh-tools 后跑三套测试
```

> **为什么 `@deepseek-ai/dsh-tools` 不进 `devDependencies`**：它是 DSH 宿主自带的内部包，
> 只能由宿主提供，插件侧只声明 `peerDependencies`。0.7.0 把它写进了 `devDependencies`，
> 导致插件在 ESM 链接阶段 `MODULE_NOT_FOUND`、`apply()` 根本没执行 —— 面板没路由、对话里没工具
> （0.7.1 修的则是同一现象的另一条根因：工具重名让 `apply()` 中途抛错）。
> 所以测试改为用 `scripts/link-host-deps.mjs` 从宿主软链一份，`npm test` 会自动调用它。
> 这条软链只影响本地跑测试，与安装到 profile 里的运行时无关。
> 宿主不在默认位置时：`npm run link-host-deps -- --host /path/to/dsh`。

不需要真实 sshd、不需要网络。测试用假的 `ssh` / `sshpass` / `node-pty` 替换进程边界，
让插件的真实逻辑（目标解析、脚本拼装、工作目录探测、pty 生命周期、WebSocket 扇出、
几何钳位）照常运行。

| 文件 | 覆盖 | 断言数 |
|---|---|---|
| `tests/core_test.mjs` | target 解析、shell 引号转义、cwd 探针封帧与提取、ANSI 清洗、ControlPersist 取值、socket 路径长度约束、跨实例共享状态、技能安装 | 68 |
| `tests/terminal_test.mjs` | 路由注册、未连接时的输入容错、连接失败回报、pty 扇出与重挂载、订阅者隔离、面板会话对 `status` / `ssh_terminal_read` / `ssh_terminal_send` 可见、工具重名不拖垮插件 | 53 |
| `tests/client_test.mjs` | 前端可加载性（CJS shim 回归）、单槽位注册、store 订阅契约、连接状态镜像与描边状态色、WebSocket 地址解析、有界重连策略、几何钳位与持久化 | 114 |

SSH 保活选项已用 `ssh -G` 验证被 OpenSSH 接受。

### 依赖是怎么声明的

| 包 | 声明位置 | 原因 |
|---|---|---|
| `node-pty`、`ws` | `dependencies` | 本插件自己要用的库，安装时随插件一起装 |
| `@deepseek-ai/dsh-tools` | `peerDependencies` | 由 DSH 宿主提供，插件不重复打包一份 |

装好插件后**运行时不需要手动 `npm install`**——依赖由安装器处理，`@deepseek-ai/dsh-tools` 则由 DSH 自己的安装树提供。`npm install` 只在你想**跑测试**时才需要。

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。当前 `0.7.2`。

## License

[Apache-2.0](./LICENSE) © 2026 framecy
