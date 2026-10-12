"""Read-only local activity and privacy-safe diagnostic export routes."""
import asyncio
import json

from .job_observability import shared_job_ledger


def register_job_routes(server):
    from aiohttp import web

    async def activity(_request):
        payload = await asyncio.to_thread(lambda: shared_job_ledger().snapshot())
        return web.json_response(payload)

    async def diagnostics(_request):
        payload = await asyncio.to_thread(lambda: shared_job_ledger().diagnostic_export())
        return web.Response(body=json.dumps(payload, separators=(",", ":")).encode(),
                            content_type="application/json", headers={
                                "Content-Disposition": 'attachment; filename="promptstudio-diagnostics.json"',
                                "Cache-Control": "no-store",
                            })

    server.routes.get("/promptstudio/jobs")(activity)
    server.routes.get("/promptstudio/jobs/diagnostics")(diagnostics)
