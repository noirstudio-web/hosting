'use strict';
/*
 * Noir Studio · Conexión desde GitHub Pages.
 * La web se carga desde GitHub; este script encuentra el servidor (PC de almacenamiento) antes de arrancar:
 *   1) dirección publicada por el servidor y firmada con su clave (solo se acepta con firma válida)
 *   2) url.json del repositorio (hosting de desarrollo)
 */
(() => {
  const PAGES = location.origin + location.pathname.replace(/[^/]*$/, '');
  const VALID = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
  window.NOIR_PAGES = PAGES;

  const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const remember = {
    get() { try { return localStorage.getItem('noir.api'); } catch { return null; } },
    set(v) { try { localStorage.setItem('noir.api', v); } catch { /* sin almacenamiento */ } },
  };

  async function relayUrl() {
    try {
      const cfg = await (await fetch(`relay.json?t=${Date.now()}`, { cache: 'no-store' })).json();
      const key = await crypto.subtle.importKey('jwk', cfg.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const text = await (await fetch(`https://ntfy.sh/${cfg.topic}/json?poll=1&since=24h`, { cache: 'no-store' })).text();
      let best = null;
      for (const line of text.split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.event !== 'message') continue;
          const m = JSON.parse(ev.message);
          if (!VALID.test(m.url) || Date.now() - m.ts > 48 * 3600 * 1000) continue;
          const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64url(m.sig), new TextEncoder().encode(`${m.url}\n${m.ts}`));
          if (ok && (!best || m.ts > best.ts)) best = m;
        } catch { /* mensaje no válido */ }
      }
      return best?.url || null;
    } catch {
      return null;
    }
  }

  async function urlJson() {
    try {
      const r = await fetch(`https://api.github.com/repos/noirstudio-web/hosting/contents/docs/url.json?ref=main&t=${Date.now()}`, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
      const j = await r.json();
      return j?.online && VALID.test(j.url) ? j.url : null;
    } catch {
      return null;
    }
  }

  async function online(url) {
    try {
      const r = await fetch(`${url}/api/session`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      return r.ok && typeof (await r.json()).studio === 'string';
    } catch {
      return false;
    }
  }

  async function find() {
    const manual = new URLSearchParams(location.search).get('api'); // para pruebas: ?api=https://…
    const [relay, json] = await Promise.all([relayUrl(), urlJson()]);
    const candidates = [...new Set([manual, relay, remember.get(), json].filter(Boolean))];
    for (const url of candidates) {
      if (await online(url)) return url.replace(/\/+$/, '');
    }
    return null;
  }

  // Pantalla mientras se busca el servidor (usa los estilos de la web).
  let screen = null;
  function show(state) {
    if (!screen) {
      screen = document.createElement('section');
      screen.className = 'login';
      screen.innerHTML = '<div class="login-card"><div class="brand-mark lg">N</div><h1 class="login-title">Noir Studio</h1>'
        + '<p class="login-sub">Servidor privado de archivos</p><p class="connect-status"></p><p class="field-hint connect-hint"></p></div>';
      document.body.append(screen);
    }
    screen.querySelector('.connect-status').textContent = state === 'off' ? '● El servidor está apagado' : 'Conectando con el servidor…';
    screen.querySelector('.connect-status').classList.toggle('off', state === 'off');
    screen.querySelector('.connect-hint').textContent = state === 'off' ? 'Enciende el PC de almacenamiento. Esta página se conectará sola en cuanto esté en línea.' : '';
  }

  window.NOIR_READY = (async () => {
    show('connecting');
    for (;;) {
      const url = await find();
      if (url) {
        window.NOIR_API = url;
        remember.set(url);
        screen?.remove();
        screen = null;
        return;
      }
      show('off');
      await new Promise((r) => setTimeout(r, 15000));
    }
  })();

  window.NOIR_RECONNECT = async () => {
    const url = await find();
    if (url) {
      window.NOIR_API = url;
      remember.set(url);
    }
  };
})();
