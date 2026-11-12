import { syncPrivacyGuard } from './privacy-guard.js';

// A server restart invalidates LAN cookies, but localhost needs no cookie.
// WebSocket retries cannot renew a session: surface sign-in without discarding drafts.
const monitors = new WeakMap();

export function syncLanReconnect(api, banner, connected) {
  if (!banner) return;
  syncPrivacyGuard(banner, connected);
  const previous = monitors.get(banner);
  if (connected) {
    previous?.stop();
    return;
  }
  if (previous) return;
  const view = banner.ownerDocument.defaultView;
  const title = banner.querySelector('strong');
  const detail = banner.querySelector('small');
  const originalTitle = title.textContent;
  const originalDetail = detail.textContent;
  let timer;
  let stopped = false;
  let request;
  const monitor = {
    stop() {
      stopped = true;
      view.clearTimeout(timer);
      request?.abort();
      title.textContent = originalTitle;
      detail.textContent = originalDetail;
      monitors.delete(banner);
    },
  };
  monitors.set(banner, monitor);
  async function check() {
    if (stopped) return;
    if (!banner.isConnected) return monitor.stop();
    request = new AbortController();
    const timeout = view.setTimeout(() => request?.abort(), 5000);
    try {
      const response = await api.fetchApi('/promptstudio/prompt-studio/runtime-health', {
        cache: 'no-store', signal: request.signal,
      });
      if (response.status === 401) {
        const data = await response.json();
        if (!stopped && data?.error === 'Prompt Studio LAN authentication required' && !detail.querySelector('a')) {
          title.textContent = 'LAN sign-in expired';
          detail.textContent = 'Sign in in a new tab, then return here. Your session will reconnect automatically. ';
          const link = banner.ownerDocument.createElement('a');
          link.textContent = 'Sign in';
          link.href = `/promptstudio/lan/login?next=${encodeURIComponent(view.location.pathname + view.location.search)}`;
          link.target = '_blank';
          link.rel = 'noopener';
          link.dataset.promptstudioAllowDisconnected = 'true';
          link.dataset.psvstudioAllowDisconnected = 'true';
          detail.append(link);
        }
      }
    } catch (_) {
      // Offline, starting, or another authentication mechanism: keep waiting.
    } finally {
      view.clearTimeout(timeout);
      request = null;
      if (!stopped) timer = view.setTimeout(check, 3000);
    }
  }
  void check();
}
