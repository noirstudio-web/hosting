'use strict';
/*
 * Dominio propio mediante un túnel con nombre de Cloudflare.
 * Requiere un dominio gestionado en una cuenta de Cloudflare (gratuita).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { spawn, execFile } = require('child_process');

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const TUNNEL_NAME = 'noir-studio';

module.exports = function registerDomain(ctx) {
  const { route, HttpError, sendJson, readJson, activity, log } = ctx;
  const CF = path.join(ctx.BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const CF_HOME = path.join(os.homedir(), '.cloudflared');
  const CERT = path.join(CF_HOME, 'cert.pem');

  let login = null; // { proc, url }
  let tunnel = null; // proceso del túnel con nombre
  let state = { status: 'off', error: null, since: null };
  let restarts = 0;
  let stopping = false;

  const cfg = () => ctx.getConfig();
  const credFile = () => (cfg().tunnelId ? path.join(CF_HOME, `${cfg().tunnelId}.json`) : null);

  function run(args, timeout = 60000) {
    return new Promise((resolve) => {
      execFile(CF, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout}\n${stderr}`.trim() });
      });
    });
  }

  const lastLine = (text) => text.split('\n').map((l) => l.replace(/^\S+\s+(ERR|INF|WRN)\s+/, '').trim()).filter(Boolean).pop() || 'Error desconocido';

  function status() {
    return {
      cloudflared: fs.existsSync(CF),
      authorized: fs.existsSync(CERT),
      loginPending: Boolean(login),
      loginUrl: login?.url || null,
      domain: cfg().domain || null,
      tunnelId: cfg().tunnelId || null,
      credentials: Boolean(credFile() && fs.existsSync(credFile())),
      tunnel: state,
      quickUrl: process.env.NOIR_PUBLIC_URL || null,
      fixedUrl: process.env.NOIR_FIXED_URL || null,
      localUrl: `http://localhost:${cfg().port}`,
    };
  }

  function startTunnel() {
    stopTunnel();
    if (!cfg().domain || !credFile() || !fs.existsSync(credFile()) || !fs.existsSync(CF)) return false;
    stopping = false;
    state = { status: 'connecting', error: null, since: Date.now() };
    const proc = spawn(CF, ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${cfg().port}`, cfg().tunnelId], { windowsHide: true });
    tunnel = proc;
    let tail = '';
    const onData = (d) => {
      const text = d.toString();
      tail = (tail + text).slice(-4000);
      if (/Registered tunnel connection/i.test(text) && state.status !== 'online') {
        state = { status: 'online', error: null, since: Date.now() };
        restarts = 0;
        log(`\x1b[32m●\x1b[0m Dominio en línea: https://${cfg().domain}`);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => {
      if (tunnel !== proc) return;
      tunnel = null;
      if (stopping) { state = { status: 'off', error: null, since: Date.now() }; return; }
      state = { status: 'error', error: lastLine(tail), since: Date.now() };
      log(`\x1b[31m●\x1b[0m El túnel del dominio se detuvo: ${state.error}`);
      if (restarts++ < 5) setTimeout(() => { if (!tunnel && cfg().domain) startTunnel(); }, 10000 * restarts);
    });
    return true;
  }

  function stopTunnel() {
    if (!tunnel) return;
    stopping = true;
    try { tunnel.kill(); } catch { /* ya terminado */ }
    tunnel = null;
    state = { status: 'off', error: null, since: Date.now() };
  }

  ctx.domainUrl = () => (state.status === 'online' && cfg().domain ? `https://${cfg().domain}` : null);
  ctx.onListen = () => { if (cfg().domain) startTunnel(); };
  process.on('exit', () => {
    try { tunnel?.kill(); } catch { /* nada */ }
    try { login?.proc.kill(); } catch { /* nada */ }
  });

  route('GET', '/api/domain', 'admin', ({ res }) => sendJson(res, 200, status()));

  // Paso 1: autorizar este equipo en la cuenta de Cloudflare.
  route('POST', '/api/domain/login', 'admin', async ({ res, user, ip }) => {
    if (!fs.existsSync(CF)) throw new HttpError(400, 'Falta cloudflared. Inicia el hosting una vez con INICIAR.bat para descargarlo.');
    if (fs.existsSync(CERT)) return sendJson(res, 200, { ok: true, already: true });
    if (login?.url) return sendJson(res, 200, { ok: true, url: login.url });
    const proc = spawn(CF, ['tunnel', 'login'], { windowsHide: true });
    login = { proc, url: null };
    const url = await new Promise((resolve) => {
      let buf = '';
      const timer = setTimeout(() => resolve(null), 20000);
      const onData = (d) => {
        buf += d.toString();
        const m = buf.match(/https:\/\/dash\.cloudflare\.com\/argotunnel\S+/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', () => { clearTimeout(timer); resolve(null); });
    });
    proc.on('exit', () => { if (login?.proc === proc) login = null; });
    if (!url) {
      try { proc.kill(); } catch { /* nada */ }
      login = null;
      throw new HttpError(502, 'Cloudflare no respondió. Revisa la conexión a internet e inténtalo de nuevo.');
    }
    login.url = url;
    activity(user, 'domain_login', 'Autorización de Cloudflare iniciada', ip);
    sendJson(res, 200, { ok: true, url });
  });

  route('POST', '/api/domain/login/cancel', 'admin', ({ res }) => {
    try { login?.proc.kill(); } catch { /* nada */ }
    login = null;
    sendJson(res, 200, { ok: true });
  });

  // Paso 2: crear el túnel y apuntar el dominio a este equipo.
  route('POST', '/api/domain/setup', 'admin', async ({ req, res, user, ip }) => {
    const { hostname } = await readJson(req);
    const host = String(hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!HOST_RE.test(host)) throw new HttpError(400, 'Escribe un dominio válido, por ejemplo archivos.tudominio.com');
    if (!fs.existsSync(CERT)) throw new HttpError(400, 'Primero autoriza este equipo en Cloudflare (paso 1)');

    const list = await run(['tunnel', 'list', '--output', 'json', '--name', TUNNEL_NAME]);
    let id = null;
    try { id = JSON.parse(list.out.slice(list.out.indexOf('['))).find((t) => t.name === TUNNEL_NAME && !t.deleted_at)?.id || null; } catch { /* sin túneles */ }
    if (!id) {
      const created = await run(['tunnel', 'create', TUNNEL_NAME]);
      id = created.out.match(/with id ([0-9a-f-]{36})/i)?.[1] || null;
      if (!created.ok || !id) throw new HttpError(502, `No se pudo crear el túnel: ${lastLine(created.out)}`);
    }
    if (!fs.existsSync(path.join(CF_HOME, `${id}.json`))) {
      throw new HttpError(409, `El túnel “${TUNNEL_NAME}” ya existe en tu cuenta pero su credencial no está en este equipo. Bórralo en Cloudflare (Zero Trust → Networks → Tunnels) e inténtalo de nuevo.`);
    }
    const routed = await run(['tunnel', 'route', 'dns', '--overwrite-dns', id, host]);
    if (!routed.ok) throw new HttpError(502, `No se pudo configurar el DNS: ${lastLine(routed.out)}. Comprueba que el dominio está en tu cuenta de Cloudflare.`);

    ctx.updateConfig({ domain: host, tunnelId: id });
    restarts = 0;
    startTunnel();
    activity(user, 'domain_set', host, ip);
    log(`Dominio configurado: https://${host}`);
    sendJson(res, 200, { ok: true, ...status() });
  });

  route('POST', '/api/domain/start', 'admin', ({ res }) => {
    restarts = 0;
    if (!startTunnel()) throw new HttpError(400, 'No hay un dominio configurado en este equipo');
    sendJson(res, 200, status());
  });

  route('POST', '/api/domain/stop', 'admin', ({ res }) => {
    stopTunnel();
    sendJson(res, 200, status());
  });

  route('DELETE', '/api/domain', 'admin', ({ res, user, ip }) => {
    const old = cfg().domain;
    stopTunnel();
    ctx.updateConfig({ domain: undefined, tunnelId: undefined });
    activity(user, 'domain_remove', old || '', ip);
    sendJson(res, 200, status());
  });

  // Comprueba DNS y que el dominio llega a este mismo servidor.
  route('POST', '/api/domain/verify', 'admin', async ({ res }) => {
    const host = cfg().domain;
    if (!host) throw new HttpError(400, 'No hay dominio configurado');
    const out = { host, dns: false, addresses: [], reachable: false, sameServer: false, error: null };
    try {
      const a = await dns.lookup(host, { all: true });
      out.addresses = a.map((x) => x.address);
      out.dns = out.addresses.length > 0;
    } catch (err) {
      out.error = `El dominio todavía no resuelve (${err.code || err.message}). Los cambios de DNS pueden tardar unos minutos.`;
    }
    if (out.dns) {
      try {
        const r = await fetch(`https://${host}/api/session`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
        const data = await r.json().catch(() => null);
        out.reachable = r.ok;
        out.sameServer = data?.instance === ctx.INSTANCE;
        if (!out.sameServer) out.error = out.reachable ? 'El dominio responde, pero no llega a este servidor.' : `El dominio respondió con error ${r.status}.`;
      } catch (err) {
        out.error = `No se pudo conectar con https://${host} (${err.cause?.code || err.name}).`;
      }
    }
    sendJson(res, 200, out);
  });
};
