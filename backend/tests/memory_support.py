"""Live memory of the test process, for the tests of what an upload costs and what a refused one leaves
behind (Phase 12, B12-19).

`tracemalloc` counts what Python allocated and has not freed. The cyclic garbage collector is switched off
for the measurement: what is only freed when the collector runs is exactly what these tests look for (an
exception that sits in a reference cycle keeps the frames it passed through, and their locals, until
then; a server between two collections holds all of it).
"""

import gc
import tracemalloc
from collections.abc import Iterator
from contextlib import contextmanager

MIB = 1024 * 1024


class MemoryMeter:
    """What happened to the traced memory since the block began."""

    def __init__(self) -> None:
        self._start = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()

    def grown(self) -> int:
        """Bytes allocated since the start that are still alive."""
        return tracemalloc.get_traced_memory()[0] - self._start

    def peak(self) -> int:
        """The most that was alive at once since the start, above what was alive at the start."""
        return tracemalloc.get_traced_memory()[1] - self._start


@contextmanager
def measured_memory() -> Iterator[MemoryMeter]:
    """Traces allocations for the block, with the cyclic garbage collector off (it runs once before,
    so that garbage from earlier tests is not counted, and is switched on again afterwards)."""
    gc.collect()
    collecting = gc.isenabled()
    tracing = tracemalloc.is_tracing()
    gc.disable()
    if not tracing:
        tracemalloc.start()
    try:
        yield MemoryMeter()
    finally:
        if not tracing:
            tracemalloc.stop()
        if collecting:
            gc.enable()
