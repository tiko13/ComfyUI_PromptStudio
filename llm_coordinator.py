"""Shared scheduling and logical cancellation, independent of provider transport."""

import asyncio
import ipaddress
import itertools
import threading
import time
from urllib.parse import urlsplit

try:
    from . import provider_transport
except ImportError:  # Standalone coordinator tests/tools.
    import provider_transport

MAX_LLM_OPERATIONS = 128


class LlmOverloadedError(RuntimeError):
    code = "llm_overloaded"
    retryable = True
    status = 503

    def __init__(self, message="LLM capacity is full; retry after an active job finishes"):
        super().__init__(message)


def endpoint_identity(data):
    provider = str(data.get("llm_provider") or "koboldcpp").strip().casefold()
    setting, default = {
        "koboldcpp": ("kobold_url", "http://localhost:5001"),
        "llamacpp": ("llamacpp_url", "http://localhost:8080"),
        "ollama": ("ollama_url", "http://localhost:11434"),
    }.get(provider, ("kobold_url", "http://localhost:5001"))
    value = str(data.get(setting) or default).strip()
    parsed = urlsplit(value if "://" in value else "http://" + value)
    host = (parsed.hostname or "").rstrip(".").casefold()
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    if loopback:
        host = "loopback"
    # Paths, model names and provider protocol do not create capacity on the
    # same server. Conservatively share its origin even behind path prefixes.
    return ("endpoint", parsed.scheme.casefold(), host,
            parsed.port or (443 if parsed.scheme.casefold() == "https" else 80))


class CancellationToken:
    def __init__(self, check=None):
        self._cancelled = threading.Event()
        self._check = check
        self._lock = threading.Lock()
        self._response = None
        self.deadline = time.monotonic() + provider_transport.MAX_TOTAL_SECONDS

    def cancelled(self):
        return self._cancelled.is_set() or bool(self._check and self._check())

    def check(self):
        if self.cancelled():
            raise asyncio.CancelledError("LLM operation was logically cancelled")
        if time.monotonic() >= self.deadline:
            raise provider_transport.ProviderDeadlineError("LLM operation total deadline exceeded")

    def response_hook(self, response):
        with self._lock:
            self._response = response
        if response is not None and self.cancelled():
            response.close()
            self.check()

    def signal(self):
        self._cancelled.set()

    def close_response(self):
        with self._lock:
            response = self._response
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


class LlmCoordinator:
    def __init__(self):
        self._condition = threading.Condition()
        self._sequence = itertools.count()
        self._pending = []
        self._active = {}
        self._capacities = {}
        self._local = threading.local()
        self._tokens = set()
        self._stopping = False
        self.native_prepare = None

    def cancel_all(self):
        """Stop admission and cancel node callers as well as route callers."""
        with self._condition:
            self._stopping = True
            tokens = tuple(self._tokens)
            for token in tokens:
                token.signal()
            self._condition.notify_all()
        for token in tokens:
            token.close_response()

    def configure_capacity(self, endpoint, capacity):
        if isinstance(capacity, bool) or not isinstance(capacity, int) or not 1 <= capacity <= 32:
            raise ValueError("LLM endpoint capacity must be an integer between 1 and 32")
        with self._condition:
            if self._active.get(endpoint) or any(endpoint in ticket[2] for ticket in self._pending):
                raise RuntimeError("LLM endpoint capacity can only change while idle")
            self._capacities[endpoint] = capacity

    def capacity(self, endpoint):
        with self._condition:
            return self._capacities.get(endpoint, 1)

    def current_token(self):
        context = getattr(self._local, "context", None)
        return context[1] if context else None

    def wait_idle(self):
        """Wait for synchronous callers too, including callers outside asyncio."""
        with self._condition:
            while self._pending or any(self._active.values()):
                self._condition.wait(0.05)

    def run(self, resources, operation, *, priority=0, token=None):
        resources = frozenset(resources)
        context = getattr(self._local, "context", None)
        if context is not None:
            if not resources.issubset(context[0]):
                raise RuntimeError("Nested LLM stages must use the operation's original resource")
            context[1].check()
            return operation()
        token = token or CancellationToken()
        with self._condition:
            if self._stopping:
                raise LlmOverloadedError("LLM service is shutting down")
            if len(self._pending) + sum(self._active.values()) >= MAX_LLM_OPERATIONS:
                raise LlmOverloadedError()
            ticket = (priority, next(self._sequence), resources)
            self._pending.append(ticket)
            self._tokens.add(token)
            try:
                while True:
                    token.check()
                    available = all(self._active.get(key, 0) < self._capacities.get(key, 1)
                                    for key in resources)
                    earlier = any(other[:2] < ticket[:2] and other[2] & resources
                                  for other in self._pending)
                    if available and not earlier:
                        for key in resources:
                            self._active[key] = self._active.get(key, 0) + 1
                        break
                    self._condition.wait(0.05)
            except BaseException:
                self._tokens.discard(token)
                raise
            finally:
                self._pending.remove(ticket)
                self._condition.notify_all()
        self._local.context = (resources, token)
        try:
            token.check()
            try:
                with provider_transport.operation_scope(token.deadline, token.cancelled):
                    result = operation()
            except Exception:
                token.check()
                raise
            token.check()
            return result
        finally:
            self._local.context = None
            token.response_hook(None)
            with self._condition:
                self._tokens.discard(token)
                for key in resources:
                    self._active[key] -= 1
                self._condition.notify_all()


SHARED_COORDINATOR = LlmCoordinator()
