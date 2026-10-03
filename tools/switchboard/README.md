# Zellij Switchboard prototype

One browser tab bar across existing Zellij web servers. Reuses each host's stock
terminal client, including its input handling and mobile controls. No remote
Zellij changes are required.

Run on the Mac:

```sh
uv run --script tools/switchboard/server.py
```

Open https://zellij.localhost (Portless), or http://127.0.0.1:8090. Use **Machines** to assign work/home groups.
On macOS, keep the relay running independently of a terminal or chat turn:

```sh
python3 tools/switchboard/install_service.py
```

This installs `dev.zellij.switchboard` as a user LaunchAgent and starts the Mac
Zellij web server in native daemon mode if needed. Each other machine also needs
its own `zellij web` server running. Logs are in
`~/Library/Logs/zellij-switchboard.log`.
**Alt+Left / Alt+Right**, or **Alt+H / Alt+L**, move to the previous/next visible tab across machines, wrapping
at either end. They work from inside the terminal and follow the current group
filter. These shortcuts are intercepted before reaching native Zellij.
Drag tabs to rearrange them, or use **Alt+Shift+Left / Alt+Shift+Right** (also H/L) to move the
selected tab left/right. The order is saved in this browser, including across
work/home filters. Ready tabs remain ahead of ordinary tabs.
Tab labels and the browser window title follow live Codex/Claude pane titles,
including `/rename` updates. Agent spinner prefixes are stripped from labels.
Use **+ New tab** to open a shell in a chosen machine/session. The new tab is
selected automatically.
Shell directory titles retain explicitly named Zellij tabs. If an agent disables
terminal title updates, Switchboard cannot obtain the chat name through this
protocol; the agent must emit it as a terminal title.
The host list lives in `~/.config/zellij/switchboard-hosts.json`; each host has
an ID, name, URL, and token file path. HTTPS hosts can specify a SHA-256 DER
certificate fingerprint using `tls_fingerprint`.

Example `~/.config/zellij/switchboard-hosts.json` (replace the remote URL and
create the token files locally):

```json
{
  "hosts": [
    {
      "id": "mac",
      "name": "Mac",
      "url": "http://127.0.0.1:8082",
      "token_file": "~/.config/zellij/mac-token"
    },
    {
      "id": "windows",
      "name": "Windows",
      "url": "https://192.0.2.2:8082",
      "token_file": "~/.config/zellij/windows-token"
    }
  ]
}
```

Self-signed HTTPS requires the host's `tls_fingerprint` as 64 hexadecimal
characters. Keep tokens and machine-specific configuration outside this checkout.
The named URLs require an existing Portless proxy with aliases `zellij` pointing
to port 8090 and `zellij-gallery` to port 8091; otherwise use the loopback URL.

Tokens and upstream cookies stay in the local relay. The relay binds only to
loopback and rejects cross-site requests. This prototype is for access on the
Mac, not yet phone access or deployment to a network interface.

**Mark ready** stars a tab and moves it left; selecting it clears the local mark.
Native tab names beginning with `*` are also highlighted and sorted first.
Automatic agent completion/approval signals are not yet connected: stock
0.45.1 web metadata does not include bell status. Marks and machine groups are
stored in this browser's local storage.
The header and browser title show the total number of marked tabs across all
machines, including tabs outside the selected group.

The native tab row is hidden in the desktop combined view; **Native tabs** shows
it again. This is client-side viewport clipping of an identified Zellij header,
not a remote layout change. Fullscreen views without that header and the stock
mobile interface are not clipped. The native status bar is also hidden. Bottom clipping does not resize the
terminal, preventing a redraw feedback loop. Routine connection status stays
in the notification tooltip; errors remain visible.
All live sessions are
attached so their tab metadata can be collected. Background frames keep their
viewport size; attaching clients can still affect Zellij's layout sizing.
Disconnected clients reconnect using Zellij's own behavior.

Shift-click opens terminal links as a preview within Switchboard. **Back to
terminal** restores the terminal, and **Open in browser tab** handles sites that
block embedding. Loopback links on remote hosts use that machine’s LAN address
or its configured `artifact_urls` mapping. This requires a reachable artifact
server or tunnel; rewriting a URL cannot reach a remote loopback-only server.

The Windows gallery on port 8765 uses the separate HTTPS origin
`https://zellij-gallery.localhost`, proxied through an anonymous HTTP listener
on 127.0.0.1:8091. It streams GET/HEAD responses from the configured
`artifact_proxy.target`. Its cookie jar and origin are separate from the
authenticated terminal relay. This supports the current gallery; WebSocket
artifacts or multiple artifact servers need a proper host tunnel when required.
Portless aliases `zellij -> 8090` and `zellij-gallery -> 8091` persist; exact
`.local` would require changing the existing proxy/DNS setup. The prototype
remains local to this Mac.

**Copy**, Cmd+C, and Ctrl+Shift+C copy a local terminal selection to the viewing
browser. Hold Option while dragging on Mac or Shift on Windows/Linux to select.
Ctrl+C without a local selection still interrupts the terminal process. Remote
OSC52 copies use this browser’s clipboard; denied permissions show a manual
copy panel instead of silently failing.

Bare Escape in stock web 0.45.1 drops its byte during parser finalization. The
relay bypasses it with a validated, pane-targeted `zellij action write ... 27`.
Mac uses the local CLI; Windows uses one private helper shell, hidden from the
shared tab list. Requests are serialized and uncertain delivery is never
automatically retried. Input waits for focus acknowledgement when switching
remote panes; Back to terminal preserves the focused pane. Dialogs and plugin
focus retain their native behavior.

Run the small checks with:

```sh
node --test tools/switchboard/*.test.cjs
uv run --with aiohttp python tools/switchboard/control.test.py
```
