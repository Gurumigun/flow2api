"""Keep SSE connections alive while a generation await produces no events."""
import asyncio
import anyio


async def with_sse_heartbeat(source, interval: float = 15.0):
    iterator = source.__aiter__()
    events = asyncio.Queue(maxsize=1)

    async def produce():
        # Keep context variables and async context managers in the same task
        # for the entire generation, including its cleanup on disconnect.
        try:
            async for chunk in iterator:
                await events.put(('chunk', chunk))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await events.put(('error', error))
        else:
            await events.put(('done', None))
        finally:
            await iterator.aclose()

    producer = asyncio.create_task(produce())
    pending = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(events.get())
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield ': keep-alive\n\n'
                continue
            kind, value = pending.result()
            pending = None
            if kind == 'done':
                return
            if kind == 'error':
                raise value
            yield value
    finally:
        # Starlette cancels its AnyIO scope on disconnect. Finish cleanup even
        # inside that scope, so pending browser requests cannot remain orphaned.
        with anyio.CancelScope(shield=True):
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
