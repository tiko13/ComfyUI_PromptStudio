import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

spec = importlib.util.spec_from_file_location("studio_request_security_test", Path(__file__).resolve().parents[1] / "request_security.py")
security = importlib.util.module_from_spec(spec)
spec.loader.exec_module(security)


class OriginTests(unittest.TestCase):
    def test_browser_and_native_trust(self):
        for headers, allowed in [
            ({}, True), ({"Origin": "http://127.0.0.1:8188"}, True),
            ({"Origin": "http://evil.invalid"}, False), ({"Origin": "null"}, False),
            ({"Origin": "http://localhost:8188"}, False),
            ({"Sec-Fetch-Site": "cross-site"}, False),
            ({"Sec-Fetch-Site": "same-site"}, False),
            ({"Origin": "http://evil.invalid", "X-Forwarded-Host": "evil.invalid"}, False),
            ({"Referer": "http://127.0.0.1:8188/studio"}, True),
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(security.browser_origin_allowed(SimpleNamespace(
                    headers=headers, scheme="http", host="127.0.0.1:8188", remote="127.0.0.1")), allowed)


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = 0
        app = web.Application(middlewares=[security.create_boundary_middleware({"/promptstudio/test": 20})])
        async def handler(request):
            self.calls += 1
            return web.json_response({"body": (await request.read()).decode()})
        app.router.add_route("*", "/promptstudio/test", handler)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_unknown_length_limit_before_handler(self):
        async def chunks():
            yield b"a" * 10
            yield b"b" * 11
        response = await self.client.post("/promptstudio/test", data=chunks())
        self.assertEqual(response.status, 413)
        self.assertEqual(self.calls, 0)

    async def test_exact_limit_and_cached_json_body(self):
        response = await self.client.post("/promptstudio/test", data="a" * 20)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["body"], "a" * 20)

    async def test_multipart_header_does_not_bypass_json_route_limit(self):
        async def chunks():
            yield b"a" * 21
        response = await self.client.post("/promptstudio/test",data=chunks(),headers={"Content-Type":"multipart/form-data; boundary=fake"})
        self.assertEqual(response.status,413)
        self.assertEqual(self.calls,0)

    async def test_cross_origin_loopback_rejected_reads_unchanged(self):
        response = await self.client.post("/promptstudio/test", headers={"Origin":"http://evil.invalid"})
        self.assertEqual(response.status, 403)
        response = await self.client.get("/promptstudio/test", headers={"Origin":"http://evil.invalid"})
        self.assertEqual(response.status, 200)

    async def test_body_previously_cached_by_host_middleware(self):
        @web.middleware
        async def host_auth(request,handler):
            await request.read()
            return await handler(request)
        app=web.Application(middlewares=[host_auth,security.create_boundary_middleware({},default_limit=20)])
        async def echo(request): return web.Response(body=await request.read())
        app.router.add_post('/promptstudio/cached',echo)
        async with TestClient(TestServer(app)) as client:
            response=await client.post('/promptstudio/cached',data=b'valid')
            self.assertEqual(response.status,200)
            self.assertEqual(await response.read(),b'valid')
            response=await client.post('/promptstudio/cached',data=b'x'*21)
            self.assertEqual(response.status,413)

    async def test_same_origin_and_authenticated_lan_cookie(self):
        origin = str(self.client.make_url("/")).rstrip("/")
        response = await self.client.post("/promptstudio/test", headers={"Origin":origin, "Cookie":"session=host-owned"})
        self.assertEqual(response.status, 200)


if __name__ == "__main__":
    unittest.main()
