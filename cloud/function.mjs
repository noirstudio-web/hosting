// Noir Studio en la nube (Neon Functions).
// Arranca el servidor de siempre (server.js en modo nube) en 127.0.0.1 y le pasa cada petición.
import noir from '../server.js';

const ready = noir.start();

export default {
  async fetch(request) {
    const port = await ready;
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // IP real del visitante: la última de la lista es la que añade Neon (las anteriores las puede inventar el cliente).
    const xff = headers.get('x-forwarded-for');
    if (xff) headers.set('x-forwarded-for', xff.split(',').pop().trim());
    headers.delete('host');
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: 'half',
      redirect: 'manual',
    });
  },
};
