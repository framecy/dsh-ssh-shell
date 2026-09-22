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

把整个目录放进 DSH 插件目录：

```
~/.dsh/profiles/web/plugins/dsh-ssh-shell/
```

然后重启 DSH Web（插件在进程启动时加载）：

```bash
kill <dsh-web-pid>
cd ~/.dsh/profiles && node node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 --host 127.0.0.1
```

浏览器刷新页面（前端 `client.js` 是页面加载时取的）。

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
| `controlDir` | `""` → `$TMPDIR` 下按 profile 分目录 | ControlMaster socket 存放位置 |
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

`/tmp/sshplug-test/` 下有三套自测，用假的 `ssh` / `sshpass` / `node-pty` + 真 WebSocket 跑完整协议（本机没有 sshd）：

| 脚本 | 覆盖 |
|---|---|
| `test.mjs` | 连接 / 输入回显 / pty 崩溃自愈 / 双客户端扇出 / master 死亡判定 / 救火上限 / 免密重连 / 不重复建 pty / 显式断开 / 工具层报错 |
| `client_test.mjs` | 表单校验 / 连接帧 / 键盘快捷键 / Ctrl+L / 多行粘贴 / 退出自重连 / 断网退避 / 缺密码不重试风暴 / 手动断开 / 凭据回填 |
| `keepalive_test.mjs` | 看门狗 t+75s 断死 socket、pty 存活、免密 re-attach、pty 不重复创建 |

SSH 保活选项已用 `ssh -G` 验证被 OpenSSH 接受。

## 版本

- `0.4.0` —— 浮动面板自由调节：标题栏拖动移动、四边四角拖动缩放（最小 340×240、钳位在可视区域内）、尺寸与位置按标签页持久化、缩放后同步 PTY 行列数
- `0.3.0` —— pty 按 target 持久化、SSH 双保活、WS 看门狗、pty 原地重建、前端自动重连与凭据回填、修正 `connect()` 过期闭包与凭据 memo 失效
- `0.2.0` —— 初版 WebSocket 终端面板

## License

私有仓库，未附开源许可证。
