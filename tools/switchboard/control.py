"""Pane-targeted Escape, bypassing stock 0.45.1's web input parser.

Remote Windows commands run only in a private, newly created helper shell.
Host owns upstream authentication and TLS policy. No command is retried after
being sent: a lost acknowledgement must not cause a duplicate Escape.
"""
import asyncio
import base64
import json
from pathlib import Path
import re
import shutil
import uuid
from urllib.parse import quote, urlencode, urlsplit

from aiohttp import ClientError, WSMsgType, web

CONTROL_SESSION_PREFIX = "__switchboard_control_"
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*?(?:\x07|\x1b\\)")


def validate_target(session, pane_id):
    # Strings are passed as argv locally and quoted PowerShell literals remotely.
    if (not isinstance(session, str) or not session.strip() or len(session) > 200
            or session in {".", ".."} or session.startswith(CONTROL_SESSION_PREFIX)
            or any(ord(c) < 32 or ord(c) == 127 or c in "/\\" for c in session)):
        raise web.HTTPBadRequest(text="Invalid Escape session")
    if type(pane_id) is not int or not 0 <= pane_id <= 0xFFFFFFFF:
        raise web.HTTPBadRequest(text="Invalid terminal pane ID")


def _ps_literal(value):
    return "'" + value.replace("'", "''") + "'"


def _powershell(script):
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return "powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand " + encoded


class EscapeControl:
    def __init__(self, host):
        self.host = host
        self.lock = asyncio.Lock()
        local = urlsplit(host.config["url"]).hostname in {"127.0.0.1", "localhost", "::1"}
        self.transport = host.config.get("escape_transport", "local" if local else "windows")
        self.binary = str(Path(host.config.get("zellij_binary") or shutil.which("zellij")
                               or Path.home() / ".cargo/bin/zellij").expanduser())
        self.helper = None
        self.terminal = self.control = None
        self.tasks = []
        self.state = None
        self.changed = asyncio.Event()
        self.output = ""
        self.pending = None
        self.closed = False

    async def send_escape(self, session, pane_id):
        validate_target(session, pane_id)
        async with self.lock:
            if self.closed:
                raise web.HTTPServiceUnavailable(text="Escape control is shutting down")
            # Authenticate even the local CLI path and reject missing sessions.
            async with await self.host.request("GET", "/session-list") as response:
                if response.status != 200:
                    raise web.HTTPBadGateway(text="Cannot validate Escape session")
                sessions = (await response.json())["sessions"]
            if not any(s["name"] == session and s.get("web_clients_allowed") for s in sessions):
                raise web.HTTPNotFound(text="Escape session is unavailable")
            if self.transport == "local":
                await self._local(session, pane_id)
            elif self.transport == "windows":
                try:
                    if (not self.terminal or self.terminal.closed or not self.control
                            or self.control.closed or any(task.done() for task in self.tasks)):
                        await self._discard()
                        await self._open()
                    target = f"& zellij -s {_ps_literal(session)} action "
                    await self._command(
                        "$panes = " + target + "list-panes --json; "
                        "if ($LASTEXITCODE -ne 0) { throw 'Cannot list target panes' }; "
                        "$panes = ($panes -join [Environment]::NewLine) | ConvertFrom-Json; "
                        f"$found = @($panes | Where-Object {{ $_.id -eq {pane_id} "
                        "-and -not $_.is_plugin -and -not $_.exited -and -not $_.is_held }); "
                        "if ($found.Count -ne 1) { $code = 4 } else { "
                        + target + f"write -p {pane_id} 27; "
                        "$code = $LASTEXITCODE; if ($null -eq $code) { $code = 1 } }"
                    )
                except BaseException:
                    await self._discard()
                    raise
            else:
                raise web.HTTPNotImplemented(text="Unsupported Escape transport; use local or windows")

    async def _local(self, session, pane_id):
        output = await self._run_local(session, "list-panes", "--json")
        try:
            panes = json.loads(output)
        except (ValueError, UnicodeDecodeError):
            raise web.HTTPBadGateway(text="Cannot validate Escape terminal pane") from None
        if not any(p.get("id") == pane_id and p.get("is_plugin") is False
                   and not p.get("exited") and not p.get("is_held") for p in panes):
            raise web.HTTPConflict(text="Escape terminal pane is no longer available")
        await self._run_local(session, "write", "-p", str(pane_id), "27")

    async def _run_local(self, session, *action):
        process = await asyncio.create_subprocess_exec(
            self.binary, "-s", session,
            "action", *action,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 5)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise web.HTTPBadGateway(text=f"Escape CLI failed (exit {process.returncode})")
        return output

    async def _open(self):
        self.helper = CONTROL_SESSION_PREFIX + uuid.uuid4().hex
        query = urlencode({"session": self.helper, "welcome": "false"})
        async with await self.host.request("POST", "/session?" + query) as response:
            if response.status != 200:
                raise web.HTTPBadGateway(text="Cannot create Escape helper")
            boot = await response.json()
        if boot.get("is_read_only") or boot.get("session_name") != self.helper:
            raise web.HTTPBadGateway(text="Escape helper requires a writable private session")
        client = urlencode({"web_client_id": boot["web_client_id"]})
        self.state = None
        self.terminal = await self.host.ws_connect(
            "/ws/terminal/" + quote(self.helper, safe="") + "?" + client + "&rows=30&cols=160"
        )
        self.tasks.append(asyncio.create_task(self._read_terminal()))
        self.control = await self.host.ws_connect("/ws/control?" + client)
        self.tasks.append(asyncio.create_task(self._read_control()))
        async with asyncio.timeout(10):
            while not self.state:
                self.changed.clear()
                if self.terminal.closed or self.control.closed:
                    raise web.HTTPBadGateway(text="Escape helper disconnected")
                await self.changed.wait()
        self._check_helper()
        # Confirm this dedicated shell can execute PowerShell before any write.
        await self._command("& zellij --version; $code = $LASTEXITCODE; if ($null -eq $code) { $code = 1 }")

    def _check_helper(self):
        pane = (self.state or {}).get("active_pane") or {}
        if (not self.helper or not self.helper.startswith(CONTROL_SESSION_PREFIX)
                or (self.state or {}).get("session_name") != self.helper
                or not pane or pane.get("is_plugin") is not False):
            raise web.HTTPBadGateway(text="Escape helper is not focused on its private terminal")

    async def _read_control(self):
        try:
            async for message in self.control:
                if message.type == WSMsgType.TEXT:
                    data = json.loads(message.data)
                    if data.get("type") == "MobileState":
                        self.state = data["payload"]
                        self.changed.set()
        finally:
            self.changed.set()
            if self.pending and not self.pending[1].done():
                self.pending[1].set_exception(web.HTTPBadGateway(text="Escape helper control disconnected"))

    async def _read_terminal(self):
        try:
            async for message in self.terminal:
                if message.type in {WSMsgType.TEXT, WSMsgType.BINARY}:
                    chunk = message.data if isinstance(message.data, str) else message.data.decode("utf-8", "ignore")
                    self.output = (self.output + chunk)[-65536:]
                    if self.pending:
                        marker, future = self.pending
                        match = re.search(re.escape(marker) + r":(-?\d+):END", _ANSI.sub("", self.output))
                        if match and not future.done():
                            future.set_result(int(match[1]))
        finally:
            self.changed.set()
            if self.pending and not self.pending[1].done():
                self.pending[1].set_exception(web.HTTPBadGateway(text="Escape helper disconnected; delivery is uncertain"))

    async def _command(self, script):
        self._check_helper()
        marker = "__SB_" + uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.output = ""
        self.pending = (marker, future)
        # The marker occurs only in decoded output, never the echoed command.
        script = ("$ErrorActionPreference = 'Stop'; $code = 1; try { " + script
                  + " } catch { $code = 1 }; [Console]::WriteLine('" + marker + ":' + $code + ':END')")
        try:
            await self._send_shell(script)
            try:
                code = await asyncio.wait_for(future, 15)
            except asyncio.TimeoutError:
                raise web.HTTPGatewayTimeout(text="Escape helper did not acknowledge; delivery is uncertain") from None
            if code == 4:
                raise web.HTTPConflict(text="Escape terminal pane is no longer available")
            if code != 0:
                raise web.HTTPBadGateway(text=f"Remote Escape CLI failed (exit {code})")
        finally:
            self.pending = None
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    async def _send_shell(self, script):
        # A non-Char key in a multi-event frame uses the entire frame as raw
        # bytes in stock 0.45.1. Keep Enter separate to avoid repeating the
        # command and corrupting its Base64 argument.
        await self.terminal.send_bytes(_powershell(script).encode("ascii"))
        await self.terminal.send_bytes(b"\r")

    async def _discard(self):
        helper, terminal = self.helper, self.terminal
        # Kill only this instance's reserved session, and only while its state
        # still proves this socket belongs to that private shell.
        if terminal and not terminal.closed and helper:
            try:
                self._check_helper()
                script = f"& zellij kill-session {_ps_literal(helper)}"
                await self._send_shell(script)
                # Keep the socket alive until the shell consumes the cleanup.
                async with asyncio.timeout(3):
                    while not terminal.closed:
                        self.changed.clear()
                        await self.changed.wait()
            except (web.HTTPException, ClientError, asyncio.TimeoutError):
                pass
        for socket in (self.control, terminal):
            if socket:
                await socket.close()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []
        self.helper = self.terminal = self.control = self.state = None

    async def close(self):
        async with self.lock:
            self.closed = True
            await self._discard()


async def escape(request):
    host = request.app["hosts"].get(request.match_info["host"])
    if host is None:
        raise web.HTTPNotFound()
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Escape requires JSON session and pane_id") from None
    if not isinstance(payload, dict) or set(payload) != {"session", "pane_id"}:
        raise web.HTTPBadRequest(text="Escape requires only session and pane_id")
    validate_target(payload["session"], payload["pane_id"])
    if not hasattr(host, "escape_control"):
        host.escape_control = EscapeControl(host)
    await host.escape_control.send_escape(payload["session"], payload["pane_id"])
    return web.json_response({"ok": True})


async def cleanup_controls(app):
    await asyncio.gather(*(host.escape_control.close() for host in app["hosts"].values()
                           if hasattr(host, "escape_control")))
