import asyncio
import unittest
from contextvars import ContextVar
import anyio
from src.api.streaming import with_sse_heartbeat


class HeartbeatTests(unittest.IsolatedAsyncioTestCase):
    async def test_generation_context_stays_in_one_task_across_events_and_close(self):
        context = ContextVar('generation_reference', default=None)
        async def generate():
            token = context.set('approved-photo')
            try:
                yield 'first'
                self.assertEqual(context.get(), 'approved-photo')
                yield 'second'
            finally:
                context.reset(token)
        self.assertEqual([chunk async for chunk in with_sse_heartbeat(generate())], ['first', 'second'])
        self.assertIsNone(context.get())

    async def test_slow_generation_is_not_cancelled_or_restarted_by_heartbeats(self):
        calls = 0
        ready = asyncio.Event()
        async def generate():
            nonlocal calls
            calls += 1
            yield 'data: first\n\n'
            await ready.wait()
            yield 'data: complete\n\n'
        stream = with_sse_heartbeat(generate(), interval=.001)
        self.assertEqual(await anext(stream), 'data: first\n\n')
        self.assertEqual(await anext(stream), ': keep-alive\n\n')
        self.assertEqual(await anext(stream), ': keep-alive\n\n')
        ready.set()
        self.assertEqual(await anext(stream), 'data: complete\n\n')
        with self.assertRaises(StopAsyncIteration):
            await anext(stream)
        self.assertEqual(calls, 1)

    async def test_disconnect_cancels_the_pending_generation_and_awaits_cleanup(self):
        cleaned = asyncio.Event()
        async def generate():
            try:
                await asyncio.Event().wait()
                yield 'never'
            finally:
                await asyncio.sleep(.001)
                cleaned.set()
        stream = with_sse_heartbeat(generate(), interval=.001)
        self.assertEqual(await anext(stream), ': keep-alive\n\n')
        with anyio.CancelScope() as scope:
            scope.cancel()
            await stream.aclose()
        self.assertTrue(cleaned.is_set())

    async def test_upstream_exception_is_preserved(self):
        async def generate():
            yield 'data: first\n\n'
            raise ValueError('generation failed')
        stream = with_sse_heartbeat(generate(), interval=.001)
        self.assertEqual(await anext(stream), 'data: first\n\n')
        with self.assertRaisesRegex(ValueError, 'generation failed'):
            await anext(stream)
