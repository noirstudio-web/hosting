'use strict';
/*
 * Noir Studio · Conexión desde GitHub Pages.
 * La web se carga desde GitHub y el servidor está en la nube (Neon): siempre en la misma dirección,
 * sin depender de ningún PC encendido.
 */
(() => {
  const CLOUD = 'https://br-morning-bread-b7pxv911-noir.compute.c-13.us-east-1.aws.neon.tech';
  const PAGES = location.origin + location.pathname.replace(/[^/]*$/, '');
  window.NOIR_PAGES = PAGES;

  async function online(url) {
    try {
      // La primera visita tras un rato sin uso despierta el servidor: puede tardar unos segundos.
      const r = await fetch(`${url}/api/session`, { cache: 'no-store', signal: AbortSignal.timeout(25000) });
      return r.ok && typeof (await r.json()).studio === 'string';
    } catch {
      return false;
    }
  }

  async function find() {
    const manual = new URLSearchParams(location.search).get('api'); // para pruebas: ?api=https://…
    for (const url of [...new Set([manual, CLOUD].filter(Boolean))]) {
      if (await online(url)) return url.replace(/\/+$/, '');
    }
    return null;
  }

  // Pantalla mientras se conecta (usa los estilos de la web).
  let screen = null;
  function show(state) {
    if (!screen) {
      screen = document.createElement('section');
      screen.className = 'login';
      screen.innerHTML = '<div class="login-card"><div class="brand-mark lg">N</div><h1 class="login-title">Noir Studio</h1>'
        + '<p class="login-sub">Servidor privado de archivos</p><p class="connect-status"></p><p class="field-hint connect-hint"></p></div>';
      document.body.append(screen);
    }
    screen.querySelector('.connect-status').textContent = state === 'off' ? '● Sin conexión con el servidor' : 'Conectando con el servidor…';
    screen.querySelector('.connect-status').classList.toggle('off', state === 'off');
    screen.querySelector('.connect-hint').textContent = state === 'off' ? 'Revisa tu conexión a internet. Esta página se conectará sola en cuanto pueda.' : '';
  }

  window.NOIR_READY = (async () => {
    show('connecting');
    for (;;) {
      const url = await find();
      if (url) {
        window.NOIR_API = url;
        screen?.remove();
        screen = null;
        return;
      }
      show('off');
      await new Promise((r) => setTimeout(r, 10000));
    }
  })();

  window.NOIR_RECONNECT = async () => {
    const url = await find();
    if (url) window.NOIR_API = url;
  };
})();
