#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["aiohttp>=3.12,<4"]
# ///
"""Loopback-only relay for multiple existing Zellij web servers."""
import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import ClientError, ClientSession, ClientTimeout, CookieJar, Fingerprint, WSMsgType, WSServerHandshakeError, web
from control import CONTROL_SESSION_PREFIX, escape, cleanup_controls

STATIC = Path(__file__).parent / "static"


class Host:
    def __init__(self, config):
        self.config = config
        self.lock = asyncio.Lock()
        self.client = None
        self.logged_in = False

    async def start(self):
        pin = self.config.get("tls_fingerprint")
        self.client = ClientSession(
            cookie_jar=CookieJar(unsafe=True),
            timeout=ClientTimeout(total=20),
        )
        self.ssl = Fingerprint(bytes.fromhex(pin)) if pin else True

    async def login(self):
        async with self.lock:
            if self.logged_in:
                return
            token = Path(self.config["token_file"]).expanduser().read_text().strip()
            async with self.client.post(
                self.config["url"] + "/command/login",
                json={"auth_token": token, "remember_me": False}, ssl=self.ssl,
            ) as response:
                if response.status != 200:
                    raise web.HTTPBadGateway(text="Zellij login failed; check the host token file.")
                await response.read()
            self.logged_in = True

    async def request(self, method, path, **kwargs):
        await self.login()
        response = await self.client.request(method, self.config["url"] + path, ssl=self.ssl, **kwargs)
        if response.status == 401:
            response.release()
            self.logged_in = False
            await self.login()
            response = await self.client.request(method, self.config["url"] + path, ssl=self.ssl, **kwargs)
        return response

    async def ws_connect(self, path, **kwargs):
        await self.login()
        try:
            return await self.client.ws_connect(self.config["url"] + path, ssl=self.ssl, **kwargs)
        except WSServerHandshakeError as error:
            if error.status != 401:
                raise
            self.logged_in = False
            await self.login()
            return await self.client.ws_connect(self.config["url"] + path, ssl=self.ssl, **kwargs)


def trusted(request):
    # Prevent another website from using this authenticated local relay.
    allowed_hosts = {f"127.0.0.1:{request.app['port']}", f"localhost:{request.app['port']}",
                     "zellij.localhost", "zellij.localhost:443"}
    allowed_origins = {f"http://127.0.0.1:{request.app['port']}", f"http://localhost:{request.app['port']}",
                       "https://zellij.localhost", "https://zellij.localhost:443"}
    if request.headers.get("Host") not in allowed_hosts:
        raise web.HTTPForbidden(text="Invalid host")
    origin = request.headers.get("Origin")
    if origin and origin not in allowed_origins:
        raise web.HTTPForbidden(text="Invalid origin")
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise web.HTTPForbidden(text="Cross-site access denied")


@web.middleware
async def guard(request, handler):
    trusted(request)
    try:
        response = await handler(request)
    except (OSError, asyncio.TimeoutError, ClientError) as error:
        return web.Response(status=502, text=f"Host unavailable ({type(error).__name__})")
    if not isinstance(response, web.WebSocketResponse):
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


async def hosts(request):
    async def describe(host):
        result = {"id": host.config["id"], "name": host.config["name"]}
        try:
            async with await host.request("GET", "/session-list") as response:
                if response.status != 200:
                    raise ValueError("Cannot list sessions")
                result["sessions"] = [s for s in (await response.json())["sessions"]
                                      if not s["name"].startswith(CONTROL_SESSION_PREFIX)]
        except Exception as error:
            result["error"] = error.text if isinstance(error, web.HTTPException) else f"Unavailable ({type(error).__name__})"
        return result
    return web.json_response(await asyncio.gather(*(describe(h) for h in request.app["hosts"].values())))


async def link_config(request):
    config = {
        key: {"origin": host.config["url"],
              "local": urlparse(host.config["url"]).hostname in {"localhost", "127.0.0.1", "::1"},
              "artifacts": host.config.get("artifact_urls", {})}
        for key, host in request.app["hosts"].items()
    }
    script = "window.__switchboardLinkHosts=" + json.dumps(config).replace("<", "\\u003c") + ";"
    return web.Response(text=script, content_type="application/javascript")


async def artifact_proxy(request):
    config = request.app["config"]
    if request.headers.get("Host") not in {config["hostname"], "127.0.0.1:8091"}:
        raise web.HTTPForbidden()
    # Separate listener/origin and cookie jar: artifact code cannot access the
    # authenticated terminal relay, and upstream login cookies never reach it.
    target = config["target"].rstrip("/") + request.rel_url.raw_path_qs
    response = None
    try:
        async with request.app["client"].request(request.method, target, allow_redirects=False) as upstream:
            headers = {"Content-Type": upstream.headers.get("Content-Type", "application/octet-stream"),
                       "Content-Security-Policy": "frame-ancestors https://zellij.localhost http://127.0.0.1:8090 http://localhost:8090",
                       "X-Content-Type-Options": "nosniff"}
            # Preserve relative redirects within this artifact's own origin.
            if upstream.headers.get("Location"):
                headers["Location"] = upstream.headers["Location"].replace(config["target"].rstrip("/"), "", 1)
            response = web.StreamResponse(status=upstream.status, headers=headers)
            await response.prepare(request)
            async for chunk in upstream.content.iter_chunked(65536):
                await response.write(chunk)
            return response
    except (OSError, asyncio.TimeoutError, ClientError):
        if response is not None and response.prepared:
            # Abort a truncated stream; writing a new 502 after the 200 headers
            # corrupts the response and can look like a successful download.
            raise
        raise web.HTTPBadGateway(text="Artifact server is unavailable; check its LAN address or tunnel.") from None


async def proxy(request):
    host = request.app["hosts"].get(request.match_info["host"])
    if host is None:
        raise web.HTTPNotFound()
    path = "/" + request.match_info["path"]
    if request.query_string:
        path += "?" + request.query_string
    if request.headers.get("Upgrade", "").lower() == "websocket":
        upstream = await host.ws_connect(path, max_msg_size=16*1024*1024)
        downstream = web.WebSocketResponse(max_msg_size=16*1024*1024)
        await downstream.prepare(request)

        async def pump(source, destination):
            async for message in source:
                if message.type == WSMsgType.TEXT:
                    await destination.send_str(message.data)
                elif message.type == WSMsgType.BINARY:
                    await destination.send_bytes(message.data)
                elif message.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                    break
        tasks = [asyncio.create_task(pump(upstream, downstream)), asyncio.create_task(pump(downstream, upstream))]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await upstream.close()
            await downstream.close()
        return downstream
    # Browser authentication is replaced by the relay's host-specific cookie jar.
    if request.match_info["path"] == "command/login":
        raise web.HTTPForbidden(text="Use the local token file")
    body = await request.read()
    headers = {"Content-Type": request.headers.get("Content-Type", "application/octet-stream")}
    async with await host.request(request.method, path, data=body, headers=headers) as response:
        data = await response.read()
        content_type = response.headers.get("Content-Type", "application/octet-stream")
        if "text/html" in content_type and response.status == 200:
            # Run the bridge before Zellij constructs its WebSockets. Assets and terminal
            # rendering remain the installed host's own version, including mobile controls.
            data = data.replace(b"<head>", b'<head><script src="/link-config.js"></script><script src="/links.js"></script><script src="/clipboard.js"></script><script src="/chrome.js"></script><script src="/bridge.js"></script>', 1)
        return web.Response(status=response.status, body=data, headers={"Content-Type": content_type})


async def static(request):
    name = request.match_info.get("file", "index.html")
    if name not in {"index.html", "app.js", "style.css", "bridge.js", "titles.js", "chrome.js", "links.js", "clipboard.js"}:
        raise web.HTTPNotFound()
    return web.FileResponse(STATIC / name)


async def lifecycle(app):
    for host in app["hosts"].values():
        await host.start()
    artifact_runner = None
    artifact_client = None
    if app.get("artifact_proxy"):
        artifact_client = ClientSession(timeout=ClientTimeout(total=30))
        artifact_app = web.Application()
        artifact_app["config"] = app["artifact_proxy"]
        artifact_app["client"] = artifact_client
        artifact_app.router.add_get("/{path:.*}", artifact_proxy)
        artifact_runner = web.AppRunner(artifact_app)
        await artifact_runner.setup()
        await web.TCPSite(artifact_runner, "127.0.0.1", 8091).start()
    yield
    if artifact_runner:
        await artifact_runner.cleanup()
        await artifact_client.close()
    await cleanup_controls(app)
    for host in app["hosts"].values():
        await host.client.close()


def create_app(config, port=8090):
    app = web.Application(middlewares=[guard])
    app["port"] = port
    app["hosts"] = {h["id"]: Host(h) for h in config["hosts"]}
    app["artifact_proxy"] = config.get("artifact_proxy")
    app.cleanup_ctx.append(lifecycle)
    app.router.add_get("/api/hosts", hosts)
    app.router.add_post("/api/hosts/{host}/escape", escape)
    app.router.add_get("/link-config.js", link_config)
    app.router.add_route("*", "/hosts/{host}/{path:.*}", proxy)
    app.router.add_get("/", static)
    app.router.add_get("/{file}", static)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path.home()/".config/zellij/switchboard-hosts.json")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()
    web.run_app(create_app(json.loads(args.config.read_text()), args.port), host="127.0.0.1", port=args.port)
