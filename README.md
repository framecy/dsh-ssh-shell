# dsh-ssh-shell

DSH 插件：用密码直连远程主机的 SSH 终端。一个自然语言工具（`connect` / `exec` / `close` / `status`）+ 浏览器右侧浮动终端面板，底层是 OpenSSH ControlMaster 常驻会话 + `sshpass` + `node-pty` 起的真实 PTY，经 WebSocket 桥到浏览器。

**核心目标：不再频繁断连，断了能自己回来。**

## 能力

- **SSH 工具**（对话里用）：`ssh_remote` 一次建立连接，之后每次远程命令都先向用户确认；`terminal_send` / `terminal_read` 直接操作面板里那个活的终端，不逐条确认。
- **浏览器终端面板**：右侧浮动面板，真实 PTY —— 原始终端模式、方向键、全屏程序、Ctrl+C / Ctrl+D / Tab 补全都正常。
- **断连自愈**：
  - `ControlMaster` + `ControlPersist=yes` —— master 常驻，不闲置回收；
  - SSH 双保活：`ServerAliveInterval=30` + `TCPKeepAlive=yes`，抗 NAT / 防火墙 / sshd 掐断静默连接；
  - WebSocket 空闲看门狗：25s 一次 ping，60s 无响应即断开这个客户端（**不动 pty**）；
  - pty 意外退出而 master 还活着时原地重建，订阅者自动迁移（最多 3 次）；
  - 前端指数退避自动重连（1/2/4/8/16/30 秒），凭据存当前标签页。
- **面板隐藏不断线**：折叠面板只切 `display:none`，socket 和 pty 都活着，展开即续。

## 安装

前置条件：已经装好 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)，并且有一个能跑的 profile（下面以 `web` 为例）。

**1. 把插件放进 profile 的 `plugins/` 目录**

目录本身可以是软链接，DSH 会顺着链接加载（开发时推荐，改代码即生效）：

```bash
git clone https://github.com/framecy/dsh-ssh-shell.git
ln -s "$PWD/dsh-ssh-shell" ~/.dsh/profiles/web/plugins/dsh-ssh-shell
```

**2. 在 profile 的 `cordis.patch.yml` 里挂上插件行**

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，加入：

```yaml
- insert:
    - id: ssh-shell
      name: './plugins/dsh-ssh-shell/lib/index.js'
```

**3. 重启 DSH**

插件只在进程启动时加载，改完必须重启：

```bash
# 停掉当前的 dsh 进程（Ctrl+C，或 kill 掉对应 pid），然后重新启动
dsh web
```

重启后浏览器刷新页面（前端 `client.js` 是页面加载时取的）。

> 装好后，右侧边缘会出现「终端」竖条，会话头部会出现 SSH 终端按钮。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `ssh` / `scp` | OpenSSH 客户端，提供 ControlMaster |
| `sshpass` | 非交互密码认证。`brew install sshpass`（需要 keepalive tap）或 `brew install esolv/sshpass/sshpass` |
| `node-pty` | 后端起 PTY 用，DSH 运行环境自带 |

缺 `sshpass` 会报硬错（可用 `requireSshpass: false` 降级为警告）。

## 配置

`cordis.patch.yml` 提供这些配置项（由插件自身的 bundle patch 声明，profile 级 `cordis.patch.yml` 可按 id 覆盖）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `controlDir` | `""` → `~/.dsh/ssh-shell` | ControlMaster socket 存放位置 |
| `timeoutMs` | `30000` | 单条命令默认超时 |
| `controlPersistSeconds` | `""` → `yes` | 留空 = master 常驻直到自己死；填秒数 = 闲置这么久后回收 |
| `confirmByDefault` | `true` | 远程命令是否默认逐条确认 |
| `requireSshpass` | `true` | 缺 `sshpass` 是否直接报错 |

## 用法

**对话里（工具）**

> `ssh root@1.2.3.4 -p 22`，密码 `xxx`，连上后看一下 `/var/log` 里最近的报错

第一次连接不确认；之后每条远程命令都会把确切命令写出来让你确认。长时间任务传 `run_in_background: true`，用 `job_output` 增量读。

**面板（GUI）**

点右侧边缘的「终端」竖条，或会话头部的 SSH 终端按钮。填 `root@1.2.3.4 -p 22` + 密码，连接。

- 面板是个浮动窗口：**拖标题栏移动位置**，**拖四条边或四个角调整大小**（最小 340×240，不会超出可视区域，也拖不到屏幕外）；
- 尺寸和位置记在当前标签页，刷新后还在；窗口变小时面板会被拉回可视区域内；
- 拖动结束即把新的行列数同步给远端 PTY，全屏程序（vim / top / htop）跟着变；
- 最小化面板**不会**断开 SSH；
- 断线会自动重连，进度写在状态栏；
- 只有「断开」按钮和 master 真的死了才会结束会话。

**凭据只存在当前标签页**（`sessionStorage`），关掉标签页即清除，不会写到磁盘。

## 设计取舍

pty 归属于 **target**（`user@host:port`），不归属任何单个 WebSocket。理由：

- 面板折叠、页面刷新、切 tab、网络抖动都不该杀掉远端 shell；
- 只有显式 `type:"close"` 或 master 死亡才真正结束；
- master 活着时浏览器**永远不需要重新输密码**。

## 测试

```bash
npm install       # 首次：装测试用的三个依赖
npm test          # 等价于 node tests/run_all.mjs
```

不需要真实 sshd、不需要网络。测试用假的 `ssh` / `sshpass` / `node-pty` 替换进程边界，
让插件的真实逻辑（目标解析、脚本拼装、工作目录探测、pty 生命周期、WebSocket 扇出、
几何钳位）照常运行。

| 文件 | 覆盖 | 断言数 |
|---|---|---|
| `tests/core_test.mjs` | target 解析、shell 引号转义、cwd 探针封帧与提取、ANSI 清洗、ControlPersist 取值、socket 路径长度约束 | 47 |
| `tests/terminal_test.mjs` | 路由注册、未连接时的输入容错、连接失败回报、pty 扇出与重挂载、订阅者隔离 | 19 |
| `tests/client_test.mjs` | 前端可加载性（CJS shim 回归）、槽位注册、store 订阅契约、几何钳位与持久化 | 39 |

SSH 保活选项已用 `ssh -G` 验证被 OpenSSH 接受。

> 运行时不需要 `npm install`：`@deepseek-ai/dsh-tools`、`ws`、`node-pty` 都由 DSH 安装自带，
> 插件由 DSH 加载器解析这些依赖。`devDependencies` 只是为了让 `npm test` 能独立跑起来。

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。当前 `0.4.1`。

## License

[Apache-2.0](./LICENSE) © 2026 framecy
