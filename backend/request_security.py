"""Extension-local browser origin and actual request-byte boundaries.

This does not authenticate ComfyUI. Native clients without browser headers keep
the host's existing access policy. Forwarded headers never grant trust.
"""
from urllib.parse import urlsplit


def _origin(value):
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Invalid HTTP origin")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Credentials are not an origin")
    return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)


def browser_origin_allowed(request):
    """Check browser evidence even for loopback; allow headerless API clients."""
    headers = request.headers
    supplied = headers.get("Origin") or headers.get("Referer")
    if supplied:
        try:
            return _origin(supplied) == _origin(f"{request.scheme}://{request.host}")
        except (ValueError, TypeError):
            return False
    return headers.get("Sec-Fetch-Site", "none") in {"none", "same-origin"}


def create_boundary_middleware(limits, *, default_limit=1024 * 1024):
    """Bound a cloned aiohttp request before route catch-all error handlers.

    A clone retains routing context. read() enforces client_max_size on actual
    streamed bytes and caches the bounded body for the route's json()/post().
    Multipart uploads retain their route's streamed per-file bounds.
    """
    from aiohttp import web

    @web.middleware
    async def boundary(request, handler):
        if not request.path.startswith(("/promptstudio/", "/promptstudio-video/")):
            return await handler(request)
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return await handler(request)
        if not browser_origin_allowed(request):
            return web.json_response({"error": "Cross-origin Studio mutations are not allowed", "code": "origin_denied"}, status=403)
        if request.content_type == "multipart/form-data" and request.path == "/promptstudio/prompt-studio/import-image":
            return await handler(request)
        resource = getattr(getattr(request.match_info, "route", None), "resource", None)
        pattern = getattr(resource, "canonical", request.path)
        limit = limits.get(request.path, limits.get(pattern, default_limit))
        # A host authentication middleware may already have cached the body.
        # aiohttp cannot clone a consumed request; still enforce our byte limit.
        if request.content.at_eof():
            body = await request.read()
            if len(body) > limit:
                return web.json_response({"error": f"Request exceeds {limit} bytes", "code": "request_too_large"}, status=413)
            return await handler(request)
        bounded = request.clone(client_max_size=limit)
        try:
            await bounded.read()
        except web.HTTPRequestEntityTooLarge:
            return web.json_response({"error": f"Request exceeds {limit} bytes", "code": "request_too_large"}, status=413)
        return await handler(bounded)

    return boundary


def install_boundary(application, limits):
    """Install once; a companion may extend the same limits during startup."""
    existing = getattr(application, "_promptstudio_boundary_limits", None)
    if existing is not None:
        existing.update(limits)
        return
    existing = dict(limits)
    application.middlewares.insert(0, create_boundary_middleware(existing))
    application._promptstudio_boundary_limits = existing
