"""Exercise real HTTP headers across sign-in and extensionless navigation."""
import sys
import tempfile
import unittest
from unittest import mock

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer

from backend.request_security import create_boundary_middleware
from test_regressions import load_modules


class LanNavigationTests(unittest.IsolatedAsyncioTestCase):
    async def test_login_redirect_and_both_studios_remain_html(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(sys.modules):
            _, routes = load_modules(directory)
            with mock.patch.object(routes, "web", web), \
                    mock.patch.object(routes, "LAN_PASSWORD", "test-only-lan-password"), \
                    mock.patch.object(routes, "_is_loopback_client", return_value=False), \
                    mock.patch.object(routes, "_is_lan_client", return_value=True):
                app = web.Application(middlewares=[
                    create_boundary_middleware({routes.LAN_LOGIN_PATH: 4096}),
                    web.middleware(routes._lan_access_middleware),
                ])
                app.router.add_get("/{studio_alias:(?i:promptstudio)}", routes.prompt_studio_alias)
                app.router.add_get("/{studio_alias:(?i:promptstudio)}/", routes.prompt_studio_alias_redirect)
                async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as client:
                    origin = str(client.make_url("/")).rstrip("/")
                    for target in ("/PromptStudio", "/PromptStudio?mode=video", "/promptstudio", "/Promptstudio/", "/PROMPTSTUDIO?mode=video"):
                        with self.subTest(target=target):
                            client.session.cookie_jar.clear()
                            response = await client.get(target, headers={"Accept": "text/html"}, allow_redirects=False)
                            self.assertEqual(response.status, 303)
                            self.assertEqual(response.content_type, "text/html")
                            login = await client.get(response.headers["Location"])
                            self.assertEqual(login.status, 200)
                            self.assertEqual(login.headers["Referrer-Policy"], "same-origin")
                            signed_in = await client.post(routes.LAN_LOGIN_PATH, data={
                                "password": "test-only-lan-password", "next": target,
                            }, headers={"Origin": origin}, allow_redirects=False)
                            self.assertEqual(signed_in.status, 303)
                            self.assertEqual(signed_in.content_type, "text/html")
                            canonical_target = "/PromptStudio?mode=video" if "mode=video" in target else "/PromptStudio"
                            self.assertEqual(signed_in.headers["Location"], canonical_target)
                            self.assertIn(routes.LAN_SESSION_COOKIE, signed_in.cookies)
                            page = await client.get(target)
                            self.assertEqual(page.status, 200)
                            self.assertEqual(page.url.path, "/PromptStudio")
                            self.assertEqual(page.url.query.get("mode"), "video" if "mode=video" in target else None)
                            self.assertEqual(page.content_type, "text/html")
                            self.assertEqual(page.headers["Content-Disposition"], "inline")
                            self.assertIn("<title>Prompt Studio</title>", await page.text())
                            canonical = await client.get("/PromptStudio/?mode=video", allow_redirects=False)
                            self.assertEqual(canonical.status, 308)
                            self.assertEqual(canonical.content_type, "text/html")
                            self.assertEqual(canonical.headers["Location"], "/PromptStudio?mode=video")
