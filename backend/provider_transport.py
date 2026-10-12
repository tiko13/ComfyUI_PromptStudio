"""Bounded synchronous HTTP transport shared by node and route execution.

No event loop is created here. Metadata has a total deadline; inference has
an activity-renewed deadline. Both cover headers/body and support cancellation.
"""
import contextlib
import http.client
import math
import queue
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_LINE_BYTES = 256 * 1024
MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_TOTAL_SECONDS = 3600
CONNECT_TIMEOUT_SECONDS = 10
_local = threading.local()
_dns_slots = threading.BoundedSemaphore(4)


class ProviderDeadlineError(RuntimeError):
    code = "provider_deadline"
    retryable = True
    status = 504


class ProviderLimitError(RuntimeError):
    code = "provider_response_too_large"
    retryable = False


class ProviderBusyError(RuntimeError):
    code = "provider_transport_busy"
    retryable = True
    status = 503


def _create_connection(address, timeout, source_address, deadline, cancellation_check):
    """Bound OS name resolution without allowing abandoned resolver growth."""
    if not _dns_slots.acquire(blocking=False):
        raise ProviderBusyError("Provider DNS capacity is full; retry shortly")
    result = queue.Queue(maxsize=1)
    def resolve():
        try:
            result.put((socket.getaddrinfo(*address, 0, socket.SOCK_STREAM), None))
        except Exception as exc:
            result.put((None, exc))
        finally:
            _dns_slots.release()
    threading.Thread(target=resolve, daemon=True, name="promptstudio-provider-dns").start()
    connect_deadline = time.monotonic() + min(_remaining(deadline), timeout)
    while True:
        if cancellation_check and cancellation_check():
            raise RuntimeError("Provider request was cancelled")
        if time.monotonic() >= connect_deadline:
            raise ProviderDeadlineError("Provider connection deadline exceeded")
        try:
            addresses, error = result.get(timeout=max(.001, min(.05, _remaining(connect_deadline))))
            break
        except queue.Empty:
            continue
    if error:
        raise error
    last_error = OSError("Provider address did not resolve")
    for family, kind, protocol, _canonname, target in addresses:
        remaining = _remaining(connect_deadline)
        if remaining <= 0:
            raise ProviderDeadlineError("Provider connection deadline exceeded")
        if cancellation_check and cancellation_check():
            raise RuntimeError("Provider request was cancelled")
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(remaining)
            if source_address:
                sock.bind(source_address)
            sock.connect(target)
            sock.settimeout(max(.001, min(timeout, _remaining(deadline))))
            return sock
        except OSError as exc:
            last_error = exc
            sock.close()
    raise last_error


@contextlib.contextmanager
def operation_scope(deadline, cancellation_check, on_activity=None):
    previous = getattr(_local, "operation", None)
    _local.operation = (deadline, cancellation_check, on_activity)
    try:
        yield
    finally:
        _local.operation = previous


def _remaining(deadline):
    return (deadline() if callable(deadline) else deadline) - time.monotonic()


def _deadline_error(deadline):
    return ProviderDeadlineError("Provider inactivity deadline exceeded: no generation progress or confirmed processing"
                                 if isinstance(deadline, _ActivityDeadline) else "Provider total deadline exceeded")


class _ActivityDeadline:
    """Inference expires after inactivity, including time waiting for headers.

    Only provider-confirmed work or decoded generation output renews it. An
    open connection or our own running-job flag is not evidence of activity.
    """
    def __init__(self, seconds, parent=None, activity_check=None, on_activity=None):
        self.seconds = seconds
        self.expires = time.monotonic() + seconds
        self.parent = parent
        self.on_activity = on_activity
        self.closed = threading.Event()
        if activity_check is not None:
            def monitor():
                while not self.closed.wait(min(5, seconds / 3)) and _remaining(self) > 0:
                    try:
                        if activity_check() is True and not self.closed.is_set():
                            self.touch()
                    except Exception:
                        pass  # Unreachable/unknown status never renews the wait.
            threading.Thread(target=monitor, daemon=True, name="promptstudio-provider-activity").start()

    def __call__(self):
        parent = self.parent() if callable(self.parent) else self.parent
        return min(self.expires, parent) if parent is not None else self.expires

    def touch(self):
        if self.closed.is_set() or _remaining(self) <= 0:
            return
        if self.on_activity:
            self.on_activity()
        self.expires = time.monotonic() + self.seconds

    def close(self):
        self.closed.set()


class ValidatedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, validator):
        self.validator = validator

    def http_error_302(self, request, fp, code, msg, headers):
        # urllib's default redirect handler drains the old body with read().
        # It is not needed for a new connection and must not bypass our cap.
        class DiscardBody:
            def read(self):
                return b""

            def close(self):
                fp.close()
        try:
            return super().http_error_302(request, DiscardBody(), code, msg, headers)
        finally:
            fp.close()

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        destination = urllib.parse.urljoin(request.full_url, newurl)
        old = urllib.parse.urlsplit(request.full_url)
        new = urllib.parse.urlsplit(destination)
        self.validator(destination)
        if old.scheme == "https" and new.scheme != "https":
            raise ValueError("Provider redirect cannot downgrade HTTPS")
        redirected = super().redirect_request(request, fp, code, msg, headers, destination)
        if redirected is not None and (old.scheme, old.hostname, old.port) != (new.scheme, new.hostname, new.port):
            for name in tuple(redirected.headers):
                if name.lower() in {"authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"}:
                    redirected.remove_header(name)
        return redirected


def _open(request, timeout, validator, deadline, cancellation_check):
    def connection_type(base):
        class Connection(base):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self._create_connection = lambda address, timeout, source_address: _create_connection(
                    address, timeout, source_address, deadline, cancellation_check,
                )

            def connect(self):
                super().connect()
                self.sock = _PollingSocket(self.sock, deadline, cancellation_check)
        return Connection

    class HTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(connection_type(http.client.HTTPConnection), req)

    class HTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(connection_type(http.client.HTTPSConnection), req, context=self._context)

    return urllib.request.build_opener(
        HTTPHandler(), HTTPSHandler(), ValidatedRedirectHandler(validator),
    ).open(request, timeout=timeout)


class _PollingSocket:
    """Retry short socket waits underneath SocketIO, before it marks timeout.

    Windows shutdown does not wake an existing select-backed timeout wait.
    Polling here keeps that wait bounded without timing out a thinking model.
    The original socket still owns makefile reference counting and TLS.
    """
    def __init__(self, sock, deadline, cancellation_check=None):
        self._socket = sock
        self.deadline = deadline
        self.cancellation_check = cancellation_check
        self.interrupted = threading.Event()

    def __getattr__(self, name):
        return getattr(self._socket, name)

    def recv_into(self, *args):
        previous = self._socket.gettimeout()
        try:
            while True:
                if _remaining(self.deadline) <= 0:
                    raise _deadline_error(self.deadline)
                if self.interrupted.is_set() or (self.cancellation_check and self.cancellation_check()):
                    raise RuntimeError("Provider request was cancelled")
                self._socket.settimeout(min(.1, max(.001, _remaining(self.deadline))))
                try:
                    return self._socket.recv_into(*args)
                except socket.timeout:
                    continue
        finally:
            try:
                self._socket.settimeout(previous)
            except OSError:
                pass

    def makefile(self, *args, **kwargs):
        stream = self._socket.makefile(*args, **kwargs)
        raw = getattr(stream, "raw", stream)
        raw._sock = self
        return stream


class BoundedResponse:
    def __init__(self, response, deadline, cancellation_check=None, max_bytes=MAX_RESPONSE_BYTES):
        self.response = response
        self.deadline = deadline
        self.cancellation_check = cancellation_check
        self.max_bytes = max_bytes
        self.total = 0
        self._closed = threading.Event()
        self._interrupted = None
        raw = getattr(getattr(response, "fp", None), "raw", None)
        sock = getattr(raw, "_sock", None)
        if sock is not None:
            raw._sock = _PollingSocket(sock, deadline, cancellation_check)
        self._watcher = threading.Thread(target=self._watch, daemon=True, name="promptstudio-provider-deadline")
        self._watcher.start()

    def _watch(self):
        while not self._closed.wait(min(.05, max(.001, _remaining(self.deadline)))):
            if _remaining(self.deadline) <= 0:
                self._interrupted = _deadline_error(self.deadline)
                self.close()
                return
            if self.cancellation_check and self.cancellation_check():
                self._interrupted = RuntimeError("Provider request was cancelled")
                self.close()
                return

    def _check(self):
        if self._interrupted:
            raise self._interrupted
        if _remaining(self.deadline) <= 0:
            raise _deadline_error(self.deadline)
        if self.cancellation_check and self.cancellation_check():
            raise RuntimeError("Provider request was cancelled")

    def _read(self, size):
        self._check()
        try:
            chunk = getattr(self.response, "read1", self.response.read)(size)
        except OSError as exc:
            self._check()
            raise RuntimeError(f"Provider response connection failed: {exc}") from exc
        except Exception:
            self._check()
            raise
        self._check()
        self.total += len(chunk)
        if self.total > self.max_bytes:
            raise ProviderLimitError(f"Provider response exceeds {self.max_bytes} bytes")
        return chunk

    def note_activity(self):
        if isinstance(self.deadline, _ActivityDeadline):
            self.deadline.touch()

    def read(self, size=None):
        target = self.max_bytes + 1 if size is None else min(size, self.max_bytes + 1)
        chunks = []
        remaining = target
        while remaining:
            chunk = self._read(min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def __iter__(self):
        pending = b""
        while True:
            chunk = self._read(4096)
            if not chunk:
                if pending:
                    yield pending
                return
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if len(line) > MAX_LINE_BYTES:
                    raise ProviderLimitError("Provider stream line exceeds its byte limit")
                yield line + b"\n"
            if len(pending) > MAX_LINE_BYTES:
                raise ProviderLimitError("Provider stream line exceeds its byte limit")

    def close(self):
        if self._closed.is_set():
            return
        self._closed.set()
        if isinstance(self.deadline, _ActivityDeadline):
            self.deadline.close()
        # HTTPResponse.close alone may block on a buffered read's lock. Shut
        # down its socket first so the reader exits and ownership can settle.
        raw = getattr(getattr(self.response, "fp", None), "raw", None)
        sock = getattr(raw, "_sock", None)
        if sock is not None:
            if isinstance(sock, _PollingSocket):
                sock.interrupted.set()
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        try:
            self.response.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def open_response(request, timeout, validator, *, inference=False, activity_check=None):
    seconds = float(timeout)
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("Provider timeout must be a positive finite number")
    if request.data is not None and len(request.data) > MAX_REQUEST_BYTES:
        raise ProviderLimitError("Provider request exceeds its byte limit")
    seconds = min(seconds, MAX_TOTAL_SECONDS)
    deadline = time.monotonic() + seconds
    operation = getattr(_local, "operation", None)
    check = None
    if operation:
        deadline = min(deadline, time.monotonic() + _remaining(operation[0]))
        check = operation[1]
    if check and check():
        raise RuntimeError("Provider request was cancelled")
    remaining = _remaining(deadline)
    if remaining <= 0:
        raise ProviderDeadlineError("Provider total deadline exceeded")
    validator(request.full_url)
    if inference:
        deadline = _ActivityDeadline(seconds, operation[0] if operation else None,
                                     activity_check, operation[2] if operation else None)
    try:
        response = _open(request, min(remaining, CONNECT_TIMEOUT_SECONDS), validator, deadline, check)
    except urllib.error.HTTPError as exc:
        # Error responses are provider-controlled too. Never read an unbounded
        # error page, and always close its stream.
        if isinstance(deadline, _ActivityDeadline):
            deadline.close()
        with BoundedResponse(exc, time.monotonic() + min(seconds, CONNECT_TIMEOUT_SECONDS), check, max_bytes=16 * 1024) as error:
            detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Provider request failed with HTTP {exc.code}: {detail}") from exc
    except BaseException:
        if isinstance(deadline, _ActivityDeadline):
            deadline.close()
        if _remaining(deadline) <= 0:
            raise _deadline_error(deadline) from None
        raise
    # Restore the remaining total budget after the bounded connect/header phase.
    sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
    if sock is not None:
        sock.settimeout(max(.001, _remaining(deadline)))
    return BoundedResponse(response, deadline, check)
