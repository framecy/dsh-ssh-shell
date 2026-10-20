---
name: ssh-shell
description: Use the GUI terminal panel's live SSH session from the conversation — check whether the user already connected, type into that PTY, read its output, or connect a new host yourself. Triggers on "连上了但你看不到", "会话无法识别", "面板里的终端", "在面板里执行", "远端服务器" when the user connected via the right-edge 终端 tab rather than asking you to connect.
whenToUse: Use whenever the user is talking about a remote server they connected through this plugin's terminal panel (right-edge 终端 tab), or asks you to run something on a host that may already be connected. Also use before ever telling the user "there is no session".
---

<!-- dsh-ssh-shell:managed — 本文件由插件在启动时维护，手改会在下次更新被覆盖；
     想自定义请在 ~/.dsh/skills/ 下另建一个技能。 -->

# ssh-shell

这个插件给对话提供三件事，**它们共享同一个进程级会话表**：

| 工具 | 用在哪 | 确认 |
|---|---|---|
| `ssh_remote` | 你自己连的会话（`connect` / `exec` / `close` / `status`） | 每条 `exec` 都要用户确认 |
| `ssh_terminal_send` | 用户在**右侧「终端」竖条面板**里连上的那个 PTY | 不确认（用户已在场） |
| `ssh_terminal_read` | 读那个 PTY 最近的输出 | 不确认 |

## 铁律：先查，再说"没有会话"

用户说「连不上 / 看不到 / 会话无法识别」时，**第一件事是 `ssh_remote action=status`**，
不要凭上下文猜，也不要说"你需要先连接"。

`status` 同时列出两类会话：

- 你自己 `connect` 的（无 `source` 字段）
- 用户从 GUI 面板连上的（`source: "gui-panel"`，`hasTerminal: true`）

`source: "gui-panel"` 的那条**已经认证过了**（ControlMaster 常驻），
**绝对不要再问密码**，直接 `ssh_terminal_send` / `ssh_terminal_read`。

`status` 返回 `no active ssh session` 才是真的没有。

## 操作面板会话

```
ssh_terminal_read  {}                  # 先看现在停在哪（提示符、上一条命令）
ssh_terminal_send  { data: "ls -la\r" }  # \r = 回车
ssh_terminal_read  { clear: true }     # 读增量（读完清空缓冲区）
```

- `target` 可省：只有一个终端时自动选中；多个终端时传 `"user@host -p 22"`。
- 转义：`\r` 回车、`\x03` Ctrl+C、`\x1b[A` 上箭头、`\t` Tab 补全。
- 缓冲区保留最近 300 KB 的原始输出，`ssh_terminal_read` 会剥掉 ANSI 控制符再给你。
- 不要用 `ssh_terminal_send` 发交互式全屏程序（vim / top）的长会话，读回来的文本会被刷屏；
  需要这类操作时让用户自己在面板里做，或改用 `ssh_remote exec` 跑一次性命令。

## 什么时候用 exec 而不是 send

| 场景 | 用哪个 |
|---|---|
| 用户已经开好面板，让你「看一下」「跑一下」 | `ssh_terminal_send` + `ssh_terminal_read` |
| 会话是你自己连的，要拿干净的 stdout / 退出码 | `ssh_remote exec` |
| 长时间流式输出（日志、构建、部署） | `ssh_remote exec` + `run_in_background: true` |
| 需要写进文件、要精确退出码 | `ssh_remote exec` |

`ssh_remote exec` 的审批通道在**面板会话场景经常是关掉的**（用户在看着终端），
这时 `exec` 会被拒绝——不要反复重试，改走 `ssh_terminal_send`。

## 自己连接

用户给你 `ssh root@1.2.3.4 -p 22` + 密码时：

1. `ssh_remote action=connect`（`target` + `password`，**不确认**）
2. 之后每条 `ssh_remote action=exec` 都先把确切命令写进回答里，让用户确认

密码只用于这一次 `connect`，不落盘、不写日志。

## 排查

| 现象 | 真正原因 | 怎么办 |
|---|---|---|
| `status` 说 0 条，但面板显示已连接 | 面板 pty 已随页面关闭/过期（pty 归属 target，不归属标签页） | 让用户在面板点「重连」，或 `ssh_terminal_read` 确认报错 |
| `no active terminal` | 该 target 没有活着的 pty | 用户必须在面板里连一次，或你自己 `connect` |
| `session has expired (ControlMaster socket gone)` | master 被远端掐断 / sshd 重启 | 重新 `connect`，密码要再输一次 |
| `ssh_terminal_read` 输出是空的 | 缓冲区被上一次 `clear: true` 清过 | 让用户在面板里敲一下回车，再读 |
