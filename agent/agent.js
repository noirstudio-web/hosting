'use strict';
/*
 * Noir Studio · Almacenamiento
 * App para el otro PC: presta su disco al hosting. Se vincula sola, abre un túnel seguro
 * y arranca con Windows. Sin dependencias (se empaqueta como NoirAlmacenamiento.exe).
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { FsStore, STORE_OPS } = require('../lib/fsstore'); // @bundle

const VERSION = '1.0.0';
const PORT = Number(process.env.NOIR_AGENT_PORT) || 8430;
const APP_DIR = process.env.NOIR_AGENT_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'NoirAlmacenamiento');
const CONFIG = path.join(APP_DIR, 'agent.json');
const CF = path.join(APP_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const TASK = 'Noir Almacenamiento';
const IS_EXE = !/^node(\.exe)?$/i.test(path.basename(process.execPath));
const ANNOUNCE_MS = 60 * 1000;

// ───────────────────────── Consola ─────────────────────────

const gold = (s) => `\x1b[38;5;180m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function log(msg) {
  const t = new Date().toLocaleTimeString('es', { hour12: false });
  console.log(`${dim(t)} ${msg}`);
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function waitEnter(msg = 'Pulsa Enter para cerrar') {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve();
    process.stdout.write(`\n  ${msg}`);
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function fatal(msg) {
  console.log(`\n  ${red('■')} ${msg}`);
  await waitEnter();
  process.exit(1);
}

// ───────────────────────── Configuración ─────────────────────────

function readTrailer() {
  // El panel añade al final del .exe: [json][uint32 longitud][NOIRCFG1]
  const file = process.env.NOIR_AGENT_TRAILER || (IS_EXE ? process.execPath : null);
  if (!file) return null;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(12);
    fs.readSync(fd, tail, 0, 12, size - 12);
    if (tail.subarray(4).toString() !== 'NOIRCFG1') { fs.closeSync(fd); return null; }
    const len = tail.readUInt32LE(0);
    const json = Buffer.alloc(len);
    fs.readSync(fd, json, 0, len, size - 12 - len);
    fs.closeSync(fd);
    return JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  }
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

function powershell(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? '' : out));
  });
}

// Elige el disco fijo con más espacio libre.
async function chooseRoot() {
  if (process.env.NOIR_AGENT_ROOT) return process.env.NOIR_AGENT_ROOT;
  const profileRoot = path.join(os.homedir(), 'Noir Studio Almacenamiento');
  if (process.platform !== 'win32') return profileRoot;
  let disks = [];
  try {
    const out = await powershell("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FreeSpace | ConvertTo-Json -Compress");
    disks = [].concat(JSON.parse(out || '[]')).filter((d) => d && d.DeviceID);
  } catch { /* sin datos */ }
  disks.sort((a, b) => Number(b.FreeSpace) - Number(a.FreeSpace));
  const systemDrive = (process.env.SystemDrive || 'C:').toUpperCase();
  for (const d of disks) {
    if (d.DeviceID.toUpperCase() === systemDrive) return profileRoot;
    const candidate = `${d.DeviceID}\\Noir Studio Almacenamiento`;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch { /* sin permiso: siguiente */ }
  }
  return profileRoot;
}

function lanUrls() {
  const out = [];
  if (process.env.NOIR_AGENT_NO_LAN) return out;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

// ───────────────────────── Inicio automático ─────────────────────────

async function ensureAutostart() {
  if (!IS_EXE || process.env.NOIR_AGENT_NO_AUTOSTART || process.platform !== 'win32') return null;
  const installed = path.join(APP_DIR, 'NoirAlmacenamiento.exe');
  try {
    if (path.resolve(process.execPath).toLowerCase() !== installed.toLowerCase()) {
      fs.mkdirSync(APP_DIR, { recursive: true });
      fs.copyFileSync(process.execPath, installed);
    }
  } catch { /* si está en uso, se mantiene la copia anterior */ }
  return new Promise((resolve) => {
    execFile('schtasks.exe', ['/Create', '/TN', TASK, '/TR', `"${installed}"`, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'], { windowsHide: true }, (err) => resolve(!err));
  });
}

// ───────────────────────── Servidor de almacenamiento ─────────────────────────

let store;
let cfg;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Solicitud demasiado grande')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-noir-key'] || ''));
  const expected = Buffer.from(String(cfg.secret || ''));
  return expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const LOGGED_OPS = { rename: 'Renombrado', copy: 'Copiado', trash: 'A la papelera', restore: 'Restaurado', purge: 'Eliminado definitivamente' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/ping') return sendJson(res, 200, { noir: 'agent', id: cfg.id || null, version: VERSION });
    if (!authorized(req)) return sendJson(res, 401, { error: 'No autorizado' });

    if (req.method === 'POST' && url.pathname === '/op') {
      const { op, args } = JSON.parse((await readBody(req)) || '{}');
      if (!STORE_OPS.includes(op)) return sendJson(res, 400, { error: 'Operación no permitida' });
      const result = await store[op](...(Array.isArray(args) ? args : []));
      if (LOGGED_OPS[op]) log(`${LOGGED_OPS[op]}: ${args?.[0] ?? ''}`);
      if (op === 'finishPart') log(`${green('↑')} Guardado: ${[args[1], result].filter(Boolean).join('/')}`);
      return sendJson(res, 200, { result: result === undefined ? null : result });
    }

    if (req.method === 'GET' && url.pathname === '/read') {
      const rel = url.searchParams.get('path');
      const start = Number(url.searchParams.get('start')) || 0;
      const end = Number(url.searchParams.get('end'));
      const stream = await store.openRead(rel, start, Number.isFinite(end) ? end : undefined);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      return stream.pipe(res);
    }

    if (req.method === 'PUT' && url.pathname === '/part') {
      const size = await store.appendPart(
        url.searchParams.get('id'),
        Number(url.searchParams.get('offset')),
        req,
        Number(url.searchParams.get('max')) || 64 * 1024 * 1024,
        Number(url.searchParams.get('total')),
      );
      return sendJson(res, 200, { size });
    }

    sendJson(res, 404, { error: 'No encontrado' });
  } catch (err) {
    if (err.status === 409) req.resume();
    if (!err.status) log(red(`Error: ${err.message}`));
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Error interno del PC de almacenamiento', extra: err.extra });
    else res.destroy();
  }
});
server.requestTimeout = 0;

// ───────────────────────── Túnel seguro ─────────────────────────

let tunnelUrl = null;
let tunnelProc = null;

async function ensureCloudflared() {
  if (fs.existsSync(CF)) return true;
  log('Descargando el túnel seguro (solo la primera vez)…');
  try {
    const r = await fetch(CF_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.mkdirSync(APP_DIR, { recursive: true });
    await fsp.writeFile(`${CF}.tmp`, Buffer.from(await r.arrayBuffer()));
    await fsp.rename(`${CF}.tmp`, CF);
    return true;
  } catch (err) {
    log(yellow(`No se pudo descargar cloudflared (${err.message}). Solo funcionará en la red local.`));
    return false;
  }
}

function startTunnel(onUrl) {
  if (process.env.NOIR_AGENT_NO_TUNNEL) return;
  const proc = spawn(CF, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { windowsHide: true });
  tunnelProc = proc;
  let buf = '';
  const onData = (d) => {
    buf = (buf + d.toString()).slice(-8000);
    const m = buf.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== tunnelUrl) {
      tunnelUrl = m[0];
      log(`${green('●')} Túnel seguro abierto`);
      onUrl();
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', () => {
    if (tunnelProc !== proc) return;
    tunnelUrl = null;
    log(yellow('El túnel se cerró. Reintentando en 10 s…'));
    setTimeout(() => startTunnel(onUrl), 10000);
  });
}

process.on('exit', () => { try { tunnelProc?.kill(); } catch { /* nada */ } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// ───────────────────────── Conexión con el hosting ─────────────────────────

let lastDiscovery = 0;

async function testHosting(base) {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/session`, { signal: AbortSignal.timeout(base.startsWith('http://') ? 3000 : 12000) });
    const j = await r.json();
    return typeof j?.studio === 'string';
  } catch {
    return false;
  }
}

async function discoverHosting(trailer) {
  const candidates = [];
  const add = (u) => { if (u && !candidates.includes(u)) candidates.push(u.replace(/\/+$/, '')); };
  add(cfg.hosting);
  for (const u of trailer?.lan || cfg.lan || []) add(u);
  add(trailer?.hosting);
  const repo = trailer?.repo || cfg.repo;
  if (repo && Date.now() - lastDiscovery > 2 * 60 * 1000) {
    lastDiscovery = Date.now();
    for (const src of [`https://api.github.com/repos/${repo}/contents/docs/url.json?ref=main`, `https://raw.githubusercontent.com/${repo}/main/docs/url.json`]) {
      try {
        const r = await fetch(`${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`, { headers: { Accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        if (j?.url) { add(j.url); break; }
      } catch { /* siguiente */ }
    }
  }
  for (const base of candidates) if (await testHosting(base)) return base;
  return null;
}

async function post(base, pathname, body) {
  const r = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'noir' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

// ───────────────────────── Programa ─────────────────────────

async function main() {
  process.title = 'Noir Studio · Almacenamiento';
  const trailer = readTrailer();
  cfg = loadConfig();
  if (trailer?.repo) cfg.repo = trailer.repo;
  if (trailer?.lan) cfg.lan = trailer.lan;

  console.log('');
  console.log(`  ${gold('■')} ${bold('NOIR STUDIO')}  ${dim(`· Almacenamiento · v${VERSION}`)}`);
  console.log(`  ${dim('─'.repeat(60))}`);

  if (!cfg.id && !trailer?.pair) {
    return fatal('Esta app no está vinculada. Descárgala desde el panel del hosting: Almacenamiento → Descargar app.');
  }

  if (!cfg.root) cfg.root = await chooseRoot();
  store = new FsStore({ root: path.join(cfg.root, 'archivos'), trashDir: path.join(cfg.root, '.papelera'), tmpDir: path.join(cfg.root, '.temp') });
  saveConfig(cfg);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', resolve);
  }).catch(async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\n  ${yellow('■')} La app ya está abierta en este PC (puerto ${PORT}).`);
      await new Promise((r) => setTimeout(r, 6000));
      process.exit(0);
    }
    return fatal(`No se pudo iniciar: ${err.message}`);
  });

  const disk = async () => store.disk();
  const info = await disk();
  console.log(`  ${dim('Este PC         ')} ${os.hostname()}`);
  console.log(`  ${dim('Carpeta         ')} ${path.join(cfg.root, 'archivos')}`);
  if (info) console.log(`  ${dim('Espacio libre   ')} ${fmtBytes(info.free)} de ${fmtBytes(info.total)}`);
  const auto = await ensureAutostart();
  if (auto !== null) console.log(`  ${dim('Inicio con Windows ')} ${auto ? green('activado') : yellow('no se pudo activar')}`);
  console.log(`  ${dim('─'.repeat(60))}`);
  console.log(`  ${dim('Deja esta ventana abierta (puedes minimizarla).')}`);
  console.log('');

  let base = null;
  let unlinked = false;

  const connect = async () => {
    base = await discoverHosting(trailer);
    if (!base) { log(yellow('No se encuentra el hosting. ¿Está encendido el otro PC? Reintentando…')); return false; }
    if (!cfg.id) {
      try {
        const r = await post(base, '/api/agent/pair', { pair: trailer.pair, name: os.hostname(), hostname: os.hostname(), root: path.join(cfg.root, 'archivos'), disk: await disk(), version: VERSION });
        cfg.id = r.id;
        cfg.secret = r.secret;
        cfg.hosting = base;
        saveConfig(cfg);
        log(`${green('✓')} Vinculado con ${bold(r.studio || 'el hosting')}${r.active ? ' · este PC ya es su almacenamiento' : ''}`);
      } catch (err) {
        await fatal(`No se pudo vincular: ${err.message}`);
      }
    }
    return true;
  };

  const announce = async () => {
    if (unlinked) return;
    if (!base && !(await connect())) return;
    const urls = [...(tunnelUrl ? [tunnelUrl] : []), ...lanUrls()];
    try {
      const r = await post(base, '/api/agent/announce', { id: cfg.id, secret: cfg.secret, urls, disk: await disk(), root: path.join(cfg.root, 'archivos'), version: VERSION, name: os.hostname() });
      if (cfg.hosting !== base) { cfg.hosting = base; saveConfig(cfg); }
      if (!announce.ok) log(`${green('●')} Conectado con ${bold(r.studio || 'el hosting')}${r.active ? ' · almacenamiento activo' : dim(' · (en espera: el hosting usa otro almacenamiento)')}`);
      announce.ok = true;
    } catch (err) {
      announce.ok = false;
      if (err.status === 401) {
        unlinked = true;
        log(red('Este PC fue desvinculado desde el panel. Descarga la app otra vez para volver a vincularlo.'));
        return;
      }
      log(yellow(`Sin conexión con el hosting (${err.message}). Reintentando…`));
      base = null;
    }
  };

  if (await ensureCloudflared()) startTunnel(() => announce());
  await announce();
  setInterval(announce, ANNOUNCE_MS);
}

main().catch((err) => fatal(err.stack || err.message));
