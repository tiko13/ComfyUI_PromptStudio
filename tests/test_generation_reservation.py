"""Synthetic HTTP and scheduler regression tests; run in the Prompt Studio suite."""
import asyncio
from types import SimpleNamespace
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from backend.generation_reservation import GenerationReservation, install_admission
from backend.llm_coordinator import CancellationToken, LlmCoordinator


class GenerationReservationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.coordinator = LlmCoordinator()
        self.queue = []
        self.now = 0
        self.released = 0
        def release():
            self.released += 1
        self.reservation = GenerationReservation(self.coordinator, CancellationToken,
            lambda: list(self.queue), release, clock=lambda: self.now, ttl=10)
        app = web.Application()
        self.admission = install_admission(SimpleNamespace(app=app), self.reservation)
        self.arrivals = []
        async def prompt(request):
            self.arrivals.append(await request.json())
            return web.json_response({'accepted': True})
        app.router.add_post('/prompt', prompt)
        app.router.add_post('/api/prompt', prompt)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        self.queue.clear()
        self.coordinator.cancel_all()
        await asyncio.wait_for(asyncio.to_thread(self.coordinator.wait_idle), 3)
        await self.client.close()

    async def until(self, predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(.01)
        await asyncio.wait_for(poll(), 3)

    async def begin(self):
        async with self.admission:
            result = self.reservation.start('a'*32)
        await self.until(lambda: self.reservation.status()['active'])
        return result['token']

    async def test_owner_passes_and_other_tabs_and_llm_wait_across_cells(self):
        token = await self.begin()
        self.assertEqual(self.reservation.status()['label'], 'Generating in LoRA studio')
        blocked = [asyncio.create_task(self.client.post(path, json={'source': path}))
                   for path in ('/prompt', '/api/prompt')]
        llm = asyncio.create_task(asyncio.to_thread(self.coordinator.run, [('shared-gpu',)], lambda: 'LLM ran'))
        for cell in range(2):
            response = await self.client.post('/prompt', json={'cell': cell}, headers={'X-LoRA-Studio-Reservation': token})
            self.assertEqual(response.status, 200)
            await asyncio.sleep(.12)  # Empty ComfyUI queue between comparison images.
            self.assertTrue(all(not task.done() for task in blocked))
            self.assertFalse(llm.done())
        self.assertEqual(self.released, 1)
        self.reservation.pulse(token, finish=True)
        responses = await asyncio.wait_for(asyncio.gather(*blocked), 3)
        self.assertTrue(all(response.status == 200 for response in responses))
        self.assertEqual(await asyncio.wait_for(llm, 3), 'LLM ran')
        self.assertEqual(len(self.arrivals), 4)
        self.assertFalse(self.reservation.status()['reserved'])

    async def test_expiry_waits_for_owned_image_then_releases_without_heartbeat(self):
        token = await self.begin()
        self.queue.append([0, 'synthetic', {}, {'lora_studio': {'comparison': 'a'*32}}])
        self.now = 11
        await asyncio.sleep(.15)
        self.assertTrue(self.reservation.status()['reserved'])
        denied = await self.client.post('/prompt', json={}, headers={'X-LoRA-Studio-Reservation': token})
        self.assertEqual(denied.status, 409)
        with self.assertRaises(ValueError):
            self.reservation.pulse(token)
        self.queue.clear()
        await self.until(lambda: not self.reservation.status()['reserved'])

    async def test_existing_work_drains_before_shared_lane_is_reserved(self):
        self.queue.append([0, 'existing', {}, {}])
        token = self.reservation.start('a'*32)['token']
        self.assertFalse(self.reservation.status()['active'])
        # A native LLM node in the existing workflow must not deadlock.
        result = await asyncio.wait_for(asyncio.to_thread(self.coordinator.run, [('shared-gpu',)], lambda: 'existing'), 1)
        self.assertEqual(result, 'existing')
        self.queue.clear()
        await self.until(lambda: self.reservation.status()['active'])
        self.reservation.pulse(token, finish=True)
        await self.until(lambda: not self.reservation.status()['reserved'])

    async def test_heartbeat_extends_lease_and_wrong_owner_cannot_end_it(self):
        token = await self.begin()
        self.now = 9
        self.reservation.pulse(token)
        self.now = 11
        await asyncio.sleep(.15)
        self.assertTrue(self.reservation.authorized(token))
        with self.assertRaises(ValueError):
            self.reservation.pulse('wrong', finish=True)
        with self.assertRaises(ValueError):
            self.reservation.start('b'*32)
        self.reservation.pulse(token, finish=True)
        await self.until(lambda: not self.reservation.status()['reserved'])

    async def test_waiting_reservation_can_be_cancelled_without_interrupting_existing_work(self):
        self.queue.append([0, 'existing', {}, {}])
        token = self.reservation.start('a'*32)['token']
        self.reservation.pulse(token, finish=True)
        await self.until(lambda: not self.reservation.status()['reserved'])
        self.assertEqual(self.queue[0][1], 'existing')
        self.assertEqual(self.released, 0)

    async def test_scheduler_shutdown_releases_lease(self):
        await self.begin()
        self.coordinator.cancel_all()
        await self.until(lambda: not self.reservation.status()['reserved'])

    async def test_expiry_during_validation_keeps_lane_until_submission_settles(self):
        token = await self.begin()
        with self.reservation.submission(token):
            self.now = 11
            await asyncio.sleep(.15)
            self.assertTrue(self.reservation.status()['reserved'])
            self.assertFalse(self.reservation.authorized(token))
        await self.until(lambda: not self.reservation.status()['reserved'])


if __name__ == '__main__':
    unittest.main()
