// dsh-ssh-shell client bundle (browser half).
//
// Registers two slots:
//   1. conversation.session.header.actions — a "终端" toggle button beside the
//      header action row (next to the 对话/轨迹 tabs region).
//   2. shell.overlay — a right-side floating panel hosting an interactive SSH
//      terminal bridged over WebSocket to the host's /ssh-terminal route.
//
// The terminal is a real PTY (host runs node-pty + ssh -tt on the persistent
// ControlMaster), so raw mode / Ctrl+C / arrows / full-screen programs work.
// The browser side renders output in a scrollback <pre> with a lightweight ANSI
// scrubber (no xterm dependency) and sends keystrokes back over the socket.
//
// Session lifetime: the panel never drops the socket just because it is hidden,
// and it reconnects on its own when the network or the remote shell blips.
// Credentials are kept in sessionStorage (this tab only) so a reconnect never
// forces a re-type.

window.__ModuleLoader__.load({
  id: "dsh-ssh-shell",
  factory: (require) => {
    var React = require("react");
    var createElement = React.createElement;
    var Fragment = React.Fragment;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useSyncExternalStore = React.useSyncExternalStore;

    // ---- shared open/close state between the header button and the panel ----
    //
    // `visible` controls only whether the panel is shown or hidden. Hiding
    // must NEVER close the WebSocket — the pty is owned by the host and lives
    // on while the panel is folded away. The panel stays mounted when hidden
    // (via display:none) so the socket and any in-flight state persist.
    function createTerminalStore() {
      var visible = false;
      var width = 520;
      var listeners = new Set();
      return {
        getVisible: function () { return visible; },
        getWidth: function () { return width; },
        setVisible: function (v) { if (visible !== v) { visible = v; listeners.forEach(function (fn) { fn(); }); } },
        toggle: function () { visible = !visible; listeners.forEach(function (fn) { fn(); }); },
        setWidth: function (w) { width = Math.max(320, Math.min(1200, w)); listeners.forEach(function (fn) { fn(); }); },
        subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
      };
    }
    var terminalStore = createTerminalStore();

    // ---- credentials remembered for this tab (survives a page refresh) ----
    var CREDS_KEY = "dsh-ssh-shell.creds";
    function loadCreds() {
      try {
        var raw = window.sessionStorage.getItem(CREDS_KEY);
        if (!raw) return { target: "", password: "" };
        var o = JSON.parse(raw);
        return { target: o.target || "", password: o.password || "" };
      } catch (e) { return { target: "", password: "" }; }
    }
    function saveCreds(target, password) {
      try { window.sessionStorage.setItem(CREDS_KEY, JSON.stringify({ target: target, password: password })); } catch (e) {}
      _savedCreds = null;   // invalidate the memo: a later read must see the new creds
    }
    function clearCreds() {
      try { window.sessionStorage.removeItem(CREDS_KEY); } catch (e) {}
      _savedCreds = null;
    }

    // Memo of the last sessionStorage read. Never write this directly without
    // invalidating it in saveCreds/clearCreds, or the memo would serve stale
    // credentials forever (e.g. an empty form right after a successful connect).
    var _savedCreds = null;
    function getSavedCreds() {
      if (_savedCreds === null) _savedCreds = loadCreds();
      return _savedCreds;
    }

    // ---- lightweight ANSI scrubber (keeps text readable without xterm) ----
    function scrubAnsi(s) {
      return String(s)
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")   // OSC sequences
        .replace(/\x1b[=>]/g, "")                         // keypad mode
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")           // CSI sequences
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")     // remaining control chars (keep \t \n \r)
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    }

    function wsUrl() {
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      return proto + location.host + "/ssh-terminal";
    }

    // ---- header toggle button ----
    function ToggleButton() {
      return createElement(
        "button",
        {
          type: "button",
          onClick: function () { terminalStore.toggle(); },
          title: "SSH 终端（右侧面板）",
          style: {
            background: "var(--ds-color-accent, #4a7cff)",
            color: "#fff",
            border: "none",
            borderRadius: "6px",
            padding: "5px 12px",
            cursor: "pointer",
            fontSize: "12px",
            lineHeight: "1.4",
            fontWeight: 600,
            whiteSpace: "nowrap",
          },
        },
        "终端"
      );
    }

    // ---- terminal panel body ----
    function TerminalPanelBody() {
      // credentials pre-filled from sessionStorage (a refresh no longer costs
      // the whole form)
      var statusState = useState("idle");
      var status = statusState[0];
      var setStatus = statusState[1];
      var targetState = useState(function () { return getSavedCreds().target; });
      var target = targetState[0];
      var setTarget = targetState[1];
      var passwordState = useState(function () { return getSavedCreds().password; });
      var password = passwordState[0];
      var setPassword = passwordState[1];
      var outputState = useState("");
      var output = outputState[0];
      var setOutput = outputState[1];
      var inputValueState = useState("");
      var inputValue = inputValueState[0];
      var setInputValue = inputValueState[1];
      var errorMessageState = useState("");
      var errorMessage = errorMessageState[0];
      var setErrorMessage = errorMessageState[1];

      // ---- refs mirrored from state (reconnect timers close over these) ----
      var wsRef = useRef(null);
      var outputRef = useRef(null);
      var inputRef = useRef(null);
      var panelRef = useRef(null);
      var targetRef = useRef(target);
      var passwordRef = useRef(password);
      var statusRef = useRef(status);
      var autoReconnectRef = useRef(false);
      var reconnectTimer = useRef(null);
      var reconnectAttemptRef = useRef(0);
      var exitRetryRef = useRef(0);
      var reconnectInfoState = useState(null);
      var reconnectInfo = reconnectInfoState[0];
      var setReconnectInfo = reconnectInfoState[1];

      targetRef.current = target;
      passwordRef.current = password;
      statusRef.current = status;

      var RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
      function scheduleReconnect() {
        clearTimeout(reconnectTimer.current);
        var attempt = reconnectAttemptRef.current;
        var delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
        setStatus("reconnecting");
        setReconnectInfo({ attempt: attempt + 1, delay: delay });
        reconnectTimer.current = setTimeout(function () {
          reconnectAttemptRef.current = attempt + 1;
          openSocket();
        }, delay);
      }

      function append(text) {
        setOutput(function (prev) {
          var next = prev + text;
          return next.length > 200000 ? next.slice(next.length - 200000) : next;
        });
      }

      function measureSize() {
        var el = panelRef.current;
        var w = el ? (el.clientWidth || 600) : 600;
        var h = el ? (el.clientHeight || 420) : 420;
        var cols = Math.max(24, Math.floor((w - 44) / 7.6));
        var rows = Math.max(8, Math.floor((h - 148) / 18.4));
        return { cols: Math.min(cols, 320), rows: Math.min(rows, 80) };
      }

      function sendRaw(text) {
        var ws = wsRef.current;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "input", data: text }));
        }
      }

      function sendResize() {
        var ws = wsRef.current;
        if (ws && ws.readyState === 1 && statusRef.current === "connected") {
          var s = measureSize();
          ws.send(JSON.stringify({ type: "resize", cols: s.cols, rows: s.rows }));
        }
      }

      // Type the buffered text into the PTY first, then the special key, so
      // the remote shell (bash readline) sees the current line — that is what
      // makes Tab-complete, Ctrl+C and history arrows behave correctly.
      function flushInput(extra) {
        var text = inputValueState[0];
        if (text !== "") { sendRaw(text); setInputValue(""); }
        if (extra !== null && extra !== undefined) sendRaw(extra);
      }

      function openSocket() {
        var ws = wsRef.current;
        if (ws) { try { ws.close(); } catch (e) {} wsRef.current = null; }
        if (!targetRef.current.trim()) { setStatus("idle"); return; }
        setStatus(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");
        var socket = new WebSocket(wsUrl());
        wsRef.current = socket;
        socket.onopen = function () {
          var s = measureSize();
          socket.send(JSON.stringify({
            type: "connect", target: targetRef.current.trim(), password: passwordRef.current,
            cols: s.cols, rows: s.rows,
          }));
        };
        socket.onmessage = function (ev) {
          var msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.type === "output") {
            append(scrubAnsi(msg.data));
          } else if (msg.type === "status") {
            if (msg.state === "connected" || msg.state === "attached") {
              reconnectAttemptRef.current = 0;
              exitRetryRef.current = 0;
              setStatus("connected");
              setErrorMessage("");
              setReconnectInfo(null);
              append("\n=== " + (msg.state === "attached" ? "已接回" : "已连接") + " " + (msg.message || "") + " ===\n\n");
              setTimeout(function () { if (inputRef.current) inputRef.current.focus(); }, 0);
            } else if (msg.state === "recovered") {
              append("\n[自动恢复] " + (msg.message || "") + "\n");
            } else if (msg.state === "closed") {
              autoReconnectRef.current = false;
              setStatus("idle");
              append("\n=== 已关闭 SSH 会话 " + (msg.message || "") + " ===\n");
            } else if (msg.state === "error") {
              var text = msg.message || "连接失败";
              setErrorMessage(text);
              append("\n[连接失败] " + text + "\n");
              // A missing password is a dead end — needs a human. Anything
              // else (host unreachable, etc.) keeps retrying.
              if (/密码|password/i.test(text)) {
                autoReconnectRef.current = false;
                clearTimeout(reconnectTimer.current);
                setStatus("error");
              } else {
                setStatus("reconnecting");
                scheduleReconnect();
              }
            }
          } else if (msg.type === "exit") {
            var code = msg.exitCode;
            var signal = msg.signal ? ", signal " + msg.signal : "";
            append("\n=== 远端会话中断 (exit " + code + signal + ") ===\n");
            if (autoReconnectRef.current && exitRetryRef.current < 3) {
              exitRetryRef.current += 1;
              setStatus("reconnecting");
              setReconnectInfo({ attempt: exitRetryRef.current, delay: 800 });
              clearTimeout(reconnectTimer.current);
              reconnectTimer.current = setTimeout(function () {
                var live = wsRef.current;
                if (live && live.readyState === 1) {
                  var s2 = measureSize();
                  live.send(JSON.stringify({
                    type: "connect", target: targetRef.current.trim(), password: passwordRef.current,
                    cols: s2.cols, rows: s2.rows,
                  }));
                } else {
                  openSocket();
                }
              }, 800);
            } else {
              autoReconnectRef.current = false;
              clearTimeout(reconnectTimer.current);
              setStatus("idle");
            }
          }
        };
        socket.onclose = function () {
          wsRef.current = null;
          if (!autoReconnectRef.current) { setStatus("idle"); return; }
          scheduleReconnect();
        };
        socket.onerror = function () {
          setErrorMessage("WebSocket 连接错误");
        };
      }

      // User-initiated connect (button click or Enter in the form).
      // Reads the refs, not the state variables: an event handler can run with
      // a render behind the current state, and a stale read here made the form
      // look broken right after typing.
      function connect() {
        clearTimeout(reconnectTimer.current);
        setReconnectInfo(null);
        var t = targetRef.current.trim();
        var pw = passwordRef.current;
        if (!t) { setStatus("error"); setErrorMessage("[请输入目标, 如 root@1.2.3.4 -p 22]"); return; }
        if (!pw) { setStatus("error"); setErrorMessage("[请输入密码]"); return; }
        reconnectAttemptRef.current = 0;
        exitRetryRef.current = 0;
        autoReconnectRef.current = true;
        saveCreds(t, pw);
        openSocket();
      }

      // User-initiated disconnect: ends the remote shell for real.
      function disconnect() {
        autoReconnectRef.current = false;
        clearTimeout(reconnectTimer.current);
        var ws = wsRef.current;
        if (ws) {
          try { ws.send(JSON.stringify({ type: "close" })); } catch (e) {}
          try { ws.close(); } catch (e) {}
          wsRef.current = null;
        }
        setStatus("idle");
        setErrorMessage("");
        setReconnectInfo(null);
        append("\n=== 已手动断开 ===\n");
      }

      function reconnectNow() {
        reconnectAttemptRef.current = 0;
        exitRetryRef.current = 0;
        autoReconnectRef.current = true;
        setErrorMessage("");
        openSocket();
      }

      function onInputKeyDown(ev) {
        var key = ev.key;
        var ctrl = ev.ctrlKey || ev.metaKey;
        if (ctrl) {
          // Ctrl+V must stay a paste; Ctrl+Shift+V (browser paste) too.
          if (key === "v" || key === "V") return;
          var lower = key.toLowerCase();
          // Ctrl+L only redraws the screen; the remote line buffer is untouched,
          // so keep what the user has typed in the input.
          if (lower === "l") { sendRaw("\x0c"); ev.preventDefault(); return; }
          // Ctrl+C / Ctrl+D do change the remote line, so push the typed text
          // first and drop the local copy (the terminal is now authoritative).
          var map = { c: "\x03", d: "\x04" };
          if (map[lower]) { flushInput(map[lower]); ev.preventDefault(); return; }
        }
        if (key === "Tab") { flushInput("\t"); ev.preventDefault(); return; }
        if (key === "ArrowUp") { flushInput("\x1b[A"); ev.preventDefault(); return; }
        if (key === "ArrowDown") { flushInput("\x1b[B"); ev.preventDefault(); return; }
        if (key === "Enter" && !(ev.nativeEvent && ev.nativeEvent.isComposing)) {
          flushInput("\r");
          ev.preventDefault();
          return;
        }
      }

      // Multi-line paste runs each line on its own.
      function onInputPaste(ev) {
        var txt = ev.clipboardData && ev.clipboardData.getData("text");
        if (!txt) return;
        if (txt.indexOf("\n") !== -1) {
          ev.preventDefault();
          var lines = txt.split("\n");
          for (var i = 0; i < lines.length; i++) {
            if (lines[i] !== "") { sendRaw(lines[i] + "\r"); }
          }
        }
      }

      var connected = status === "connected";
      var connecting = status === "connecting" || status === "reconnecting";
      var errored = status === "error";

      var panelWidth = terminalStore.getWidth();
      var panelVisible = useSyncExternalStore(terminalStore.subscribe, terminalStore.getVisible, terminalStore.getVisible);

      // --- resize handle (drag the panel's left edge) ---
      var isResizing = useRef(false);
      var resizeStart = useRef({ x: 0, w: 0 });
      var onResizeHandleDown = function (ev) {
        ev.preventDefault();
        isResizing.current = true;
        resizeStart.current = { x: ev.clientX, w: terminalStore.getWidth() };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        var onMove = function (me) {
          if (!isResizing.current) return;
          var delta = resizeStart.current.x - me.clientX; // dragging left => wider
          terminalStore.setWidth(resizeStart.current.w + delta);
        };
        var onUp = function () {
          if (!isResizing.current) return;
          isResizing.current = false;
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          sendResize();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      };

      // Resize the PTY when the panel is revealed again or the browser window
      // changes size.
      useEffect(function () {
        if (panelVisible && connected) sendResize();
      }, [panelVisible]);

      useEffect(function () {
        function onWinResize() { sendResize(); }
        window.addEventListener("resize", onWinResize);
        return function () { window.removeEventListener("resize", onWinResize); };
      }, []);

      useEffect(function () {
        if (panelVisible && connected && inputRef.current) inputRef.current.focus();
      }, [panelVisible]);

      useEffect(function () {
        if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }, [output]);

      // header row
      var dotColor = connected ? "#30d158" : (connecting ? "#ffb340" : (errored ? "#e5534b" : "#8e8e93"));
      var dotLabel = connected ? "已连接" : (status === "connecting" ? "连接中" : (status === "reconnecting" ? "重连中" : (errored ? "出错" : "未连接")));
      var header = createElement("div", {
        style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "6px 10px", borderBottom: "1px solid var(--ds-color-border, rgba(128,128,128,0.25))", background: "var(--ds-color-surface, rgba(0,0,0,0.25))" },
      },
        createElement("div", { style: { display: "flex", alignItems: "center", gap: "7px", minWidth: "0", flex: 1 } },
          createElement("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: dotColor, flexShrink: "0", display: "inline-block", boxShadow: connecting ? "0 0 6px " + dotColor : "none" } }),
          createElement("span", { style: { fontWeight: 600, fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            "SSH 终端" + (connected && target ? " · " + target : " · " + dotLabel)),
          connecting ? createElement("span", { style: { width: "9px", height: "9px", borderRadius: "50%", border: "2px solid " + dotColor, borderTopColor: "transparent", animation: "dsh-ssh-spin 0.8s linear infinite", display: "inline-block", flexShrink: "0" } }) : null
        ),
        createElement("div", { style: { display: "flex", gap: "6px", flexShrink: "0" } },
          connected ? createElement("button", { type: "button", onClick: disconnect, title: "关闭 SSH 会话（会结束远端 shell，但保留 ControlMaster）", style: btnStyle() }, "断开") : null,
          !connected ? createElement("button", { type: "button", onClick: reconnectNow, title: "用上次的目标与密码重新连接", style: btnStyle() }, "重连") : null,
          createElement("button", { type: "button", onClick: function () { terminalStore.setVisible(false); }, title: "最小化面板（SSH 会话保持）", style: btnStyle() }, "最小化")
        )
      );

      // connection form (when not connected)
      var form = null;
      if (!connected) {
        form = createElement("div", { style: { padding: "10px", display: "flex", flexDirection: "column", gap: "8px" } },
          createElement("input", {
            type: "text",
            placeholder: "root@1.2.3.4 -p 22",
            value: target,
            onChange: function (ev) { setTarget(ev.target.value); },
            onKeyDown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); connect(); } },
            style: inputStyle(),
          }),
          createElement("input", {
            type: "password",
            placeholder: "密码",
            value: password,
            onChange: function (ev) { setPassword(ev.target.value); },
            onKeyDown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); connect(); } },
            style: inputStyle(),
          }),
          createElement("button", {
            type: "button",
            onClick: connect,
            disabled: connecting,
            style: Object.assign(btnStyle(), { background: "var(--ds-color-accent, #4a7cff)", color: "#fff", border: "none", padding: "7px 12px" }),
          }, status === "connecting" ? "连接中…" : (status === "reconnecting" ? "重连中…" : "连接")),
          reconnectInfo ? createElement("div", { style: { color: "#ffb340", fontSize: "12px", lineHeight: "1.5" } },
            "连接中断，正在自动重连（第 " + reconnectInfo.attempt + " 次，" + Math.round(reconnectInfo.delay / 1000) + " 秒后重试）") : null,
          errored ? createElement("div", { style: { color: "#e5534b", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: "1.5", maxHeight: "120px", overflow: "auto", background: "rgba(229,83,75,0.08)", border: "1px solid rgba(229,83,75,0.3)", borderRadius: "6px", padding: "8px" } }, errorMessage || "连接失败") : null,
          createElement("div", { style: { color: "rgba(142,142,147,0.9)", fontSize: "11px", lineHeight: "1.5" } },
            "凭据仅保存在当前标签页（sessionStorage），关闭标签页即清除。会话自动保活与重连。")
        );
      }

      // terminal output + input (when connected)
      var term = null;
      if (connected) {
        term = createElement(Fragment, null,
          createElement("pre", {
            ref: outputRef,
            style: { flex: 1, margin: 0, padding: "8px 10px", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12.5px", lineHeight: "1.45", color: "var(--ds-color-text, #e6e6e6)" },
          }, output),
          createElement("div", { style: { display: "flex", gap: "6px", padding: "8px 10px", borderTop: "1px solid var(--ds-color-border, rgba(128,128,128,0.25))" } },
            createElement("input", {
              ref: inputRef,
              type: "text",
              value: inputValue,
              placeholder: "输入指令, 回车执行…（Ctrl+C 中断, ↑↓ 历史）",
              onChange: function (ev) { setInputValue(ev.target.value); },
              onKeyDown: onInputKeyDown,
              onPaste: onInputPaste,
              autoFocus: true,
              style: Object.assign(inputStyle(), { flex: 1 }),
            }),
            createElement("button", { type: "button", onClick: function () { flushInput("\r"); }, style: btnStyle() }, "发送")
          )
        );
      }

      return createElement("div", {
        ref: panelRef,
        style: {
          position: "fixed",
          top: "56px",
          right: "12px",
          bottom: "12px",
          width: Math.min(panelWidth, window.innerWidth - 24) + "px",
          display: panelVisible ? "flex" : "none",
          flexDirection: "column",
          background: "var(--ds-color-background, #17181c)",
          color: "var(--ds-color-text, #e6e6e6)",
          border: "1px solid var(--ds-color-border, rgba(128,128,128,0.3))",
          borderRadius: "10px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
          zIndex: 1000,
          overflow: "hidden",
        },
      },
        createElement("style", null, "@keyframes dsh-ssh-spin{to{transform:rotate(360deg)}}"),
        // Resize handle on the panel's left edge.
        createElement("div", {
          role: "separator",
          "aria-orientation": "vertical",
          onPointerDown: onResizeHandleDown,
          title: "拖动调整宽度",
          style: {
            position: "absolute",
            left: "-4px",
            top: 0,
            bottom: 0,
            width: "8px",
            cursor: "col-resize",
            background: "transparent",
            touchAction: "none",
          }
        }),
        header, form, term);
    }

    // TerminalPanelBody is always kept mounted once opened, so the WebSocket
    // lives on while the panel is folded. The panel body itself toggles its
    // `display` between "flex" and "none" based on `terminalStore.visible`,
    // so hiding never unmounts the component — the pty on the host stays up.
    var everOpenedTerminal = false;
    function TerminalPanel() {
      var visible = useSyncExternalStore(terminalStore.subscribe, terminalStore.getVisible, terminalStore.getVisible);
      if (visible) everOpenedTerminal = true;
      if (!everOpenedTerminal) return null;
      return createElement(TerminalPanelBody);
    }

    // Always-visible floating entry (works even without a session/header):
    // a slim tab on the right viewport edge that toggles the same panel store.
    function TerminalOverlay() {
      var visible = useSyncExternalStore(terminalStore.subscribe, terminalStore.getVisible, terminalStore.getVisible);
      return createElement(
        Fragment,
        null,
        createElement(
          "button",
          {
            type: "button",
            onClick: function () { terminalStore.toggle(); },
            title: "SSH 终端",
            "aria-label": "SSH 终端",
            style: {
              position: "fixed",
              right: "0",
              top: "50%",
              transform: "translateY(-50%)",
              zIndex: 999,
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              background: visible ? "var(--ds-color-accent, #4a7cff)" : "var(--ds-color-surface, rgba(255,255,255,0.08))",
              color: visible ? "#fff" : "var(--ds-color-text, inherit)",
              border: "1px solid var(--ds-color-border, rgba(128,128,128,0.4))",
              borderRight: "none",
              borderRadius: "8px 0 0 8px",
              padding: "10px 6px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "1px",
              boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
              opacity: 0.92,
            },
          },
          "终端"
        ),
        TerminalPanel()
      );
    }

    function btnStyle() {
      return {
        background: "var(--ds-color-surface, rgba(255,255,255,0.06))",
        border: "1px solid var(--ds-color-border, rgba(128,128,128,0.35))",
        color: "var(--ds-color-text, inherit)",
        borderRadius: "6px",
        padding: "4px 10px",
        cursor: "pointer",
        fontSize: "12px",
        lineHeight: "1.4",
      };
    }
    function inputStyle() {
      return {
        background: "var(--ds-color-surface, rgba(255,255,255,0.05))",
        border: "1px solid var(--ds-color-border, rgba(128,128,128,0.35))",
        color: "var(--ds-color-text, inherit)",
        borderRadius: "6px",
        padding: "6px 8px",
        fontSize: "13px",
        outline: "none",
      };
    }

    // ---- plugin body ----
    var inject = ["slots"];

    function apply(ctx) {
      // header toggle (session scope; inject waits for the header declaration)
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "ssh-terminal-toggle",
          order: 50,
          label: "SSH 终端",
        }, ToggleButton);
      });
      // right-side floating entry + panel (root scope, always mounted).
      // NOTE (dsh >= 0.1.2): client entries load concurrently, so a direct
      // register() races the layout plugin's shell.overlay declaration and
      // throws 'slot "shell.overlay" is not declared'. Wait via inject like
      // the header slot above and other plugins (e.g. better-sidebar) do.
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "ssh-terminal-panel",
          order: 50,
        }, TerminalOverlay);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__terminalStore = terminalStore;
    return module.exports;
  }
});
