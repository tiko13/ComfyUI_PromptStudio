"""Stubbed route imports must not contaminate subsequent real HTTP clients."""
import sys
import tempfile
import unittest
from unittest import mock

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from backend.generation_reservation import install_admission
from test_regressions import load_modules
from types import SimpleNamespace


class RuntimeStubIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_stubbed_routes_then_real_http_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            _, routes = load_modules(directory)
            self.assertEqual(routes.web.json_response({'stub': True}), ({'stub': True}, 200))
            self.assertIs(sys.modules['aiohttp'], aiohttp)
            app = web.Application()
            install_admission(SimpleNamespace(app=app), None)

            async def health(request):
                return web.json_response({'healthy': True})

            app.router.add_get('/health', health)
            async with TestClient(TestServer(app)) as client:
                response = await client.get('/health')
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), {'healthy': True})

    async def test_failed_route_import_restores_http_module(self):
        for present in (True, False):
            with self.subTest(present=present), mock.patch.dict(sys.modules):
                if not present:
                    sys.modules.pop('aiohttp', None)
                with tempfile.TemporaryDirectory() as directory, \
                        mock.patch('test_regressions.importlib.util.spec_from_file_location',
                                   side_effect=RuntimeError('synthetic import failure')):
                    with self.assertRaisesRegex(RuntimeError, 'synthetic import failure'):
                        load_modules(directory)
                if present:
                    self.assertIs(sys.modules['aiohttp'], aiohttp)
                else:
                    self.assertNotIn('aiohttp', sys.modules)
