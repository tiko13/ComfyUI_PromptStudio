"""Programmatic access to the same Manager restart used by System status."""
import asyncio
import ipaddress
import uuid

from .request_security import browser_origin_allowed


MANAGER_RESTART_PATHS = ("/v2/manager/reboot", "/manager/reboot")


class RestartController:
    def __init__(self, idle_check):
        self.idle_check = idle_check
        self.boot_id = uuid.uuid4().hex
        self.pending = False

    async def __call__(self, request):
        # Import lazily so importing routes does not create an HTTP client.
        from aiohttp import ClientError, ClientSession, ClientTimeout, web

        def reply(http_status, **payload):
            return web.json_response({"boot_id": self.boot_id, **payload}, status=http_status)

        try:
            local = ipaddress.ip_address(request.remote or "").is_loopback
        except ValueError:
            local = False
        if not local or not browser_origin_allowed(request):
            return reply(403, code="restart_denied", error="Restart is available only to same-origin or native clients on this computer.")
        try:
            if await request.json() != {}:
                raise ValueError("Send an empty JSON object; forced restarts are not supported.")
        except (ValueError, UnicodeError) as exc:
            return reply(400, code="invalid_request", error=str(exc))
        if self.pending:
            return reply(409, code="restart_pending", error="A restart was already requested. Check runtime-health before retrying.")
        try:
            busy = self.idle_check()
        except Exception:
            return reply(503, code="restart_status_unavailable", error="Could not verify that ComfyUI and both studios are idle.")
        if any(busy.values()):
            return reply(409, code="restart_busy", error="Wait for the generation queue, Studio jobs and runtime updates to finish.", busy=busy)

        # Use the accepted socket, never a caller-provided URL or Host, as the
        # destination. An HTTP request preserves Manager middleware/auth checks.
        socket_address = request.transport.get_extra_info("sockname") if request.transport else None
        if not socket_address:
            return reply(503, code="restart_unavailable", error="The local ComfyUI listener could not be determined.")
        host, port = socket_address[:2]
        host = f"[{host}]" if ":" in host else host
        base_url = f"{request.scheme}://{host}:{port}"
        headers = {name: request.headers[name] for name in
                   ("Authorization", "Cookie", "Host", "Origin", "Referer", "Sec-Fetch-Site")
                   if name in request.headers}
        self.pending = True
        try:
            async with ClientSession(timeout=ClientTimeout(total=15), trust_env=False) as session:
                for endpoint in MANAGER_RESTART_PATHS:
                    async with session.post(base_url + endpoint, json={}, headers=headers, allow_redirects=False) as response:
                        if response.status in {404, 405}:
                            continue
                        if 200 <= response.status < 300:
                            return reply(202, status="restart_requested", manager_endpoint=endpoint)
                        self.pending = False
                        return reply(502, code="manager_restart_failed", manager_status=response.status,
                                     error="ComfyUI Manager rejected the restart. Diagnose Manager before retrying.")
            self.pending = False
            return reply(503, code="manager_restart_unavailable", error="ComfyUI Manager's restart API is unavailable.")
        except (ClientError, asyncio.TimeoutError, OSError):
            # Manager may stop the server before its response reaches us. Never
            # fall back or resend after an ambiguous outcome.
            return reply(202, status="restart_unconfirmed",
                         error="The Manager connection closed or timed out. Check runtime-health for a new boot_id before taking further action.")
