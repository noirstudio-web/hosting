'use strict';
/*
 * Noir Studio · Hosting privado de archivos
 * Servidor HTTP sin dependencias externas (Node.js >= 20).
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

let sea = null;
try { sea = require('node:sea'); } catch { /* Node sin soporte SEA */ }
const IS_SEA = Boolean(sea?.isSea?.()); // empaquetado como NoirStudioServidor.exe
const VERSION = require('./lib/version');
// En el servidor instalado, los datos viven en NOIR_HOME (p. ej. D:\NoirStudio).
const ROOT = process.env.NOIR_HOME ? path.resolve(process.env.NOIR_HOME) : __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const TMP_DIR = path.join(DATA_DIR, 'uploads');

const DEFAULTS = {
  studioName: 'Noir Studio',
  port: 8420,
  host: '0.0.0.0',
  storage: './storage',
  sessionHours: 12,
  trashDays: 30,
  maxChunkMB: 64,
  githubRepo: 'noirstudio-web/hosting',
};

const ROLES = { viewer: 1, editor: 2, admin: 3 };
const ROLE_ES = { viewer: 'Lector', editor: 'Editor', admin: 'Administrador' };
const COOKIE = 'noir_sid';
const MAX_JSON = 64 * 1024;
const ZIP_LIMIT = 0xffffffff - 64 * 1024 * 1024; // ZIP clásico (sin ZIP64)
const LIMIT_MAX_FAILS = 8;
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ACTIVITY = 1000;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// ───────────────────────── Configuración y base de datos ─────────────────────────

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function loadDb() {
  const empty = { users: [], shares: [], trash: [], activity: [], invites: [], projects: null };
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch {
    return empty;
  }
}

function writeDbNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_PATH);
}

let saveTimer = null;
function saveDb() {
  if (!saveTimer) saveTimer = setTimeout(writeDbNow, 250);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || DUMMY_HASH).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual) && Boolean(stored);
}

// ───────────────────────── Utilidades ─────────────────────────

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'srt', 'vtt']);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf', zip: 'application/zip',
};

const KIND_EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'raw'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff'],
  document: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'csv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  project: ['psd', 'ai', 'fig', 'sketch', 'xd', 'blend', 'fbx', 'obj', 'c4d', 'aep', 'prproj', 'flp', 'als', 'ptx', 'logicx'],
};
const KIND_OF = {};
for (const [k, list] of Object.entries(KIND_EXT)) for (const e of list) KIND_OF[e] = k;

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const extOf = (name) => path.extname(name).slice(1).toLowerCase();

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) {
        reject(new HttpError(413, 'Solicitud demasiado grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(data && typeof data === 'object' ? data : {});
      } catch {
        reject(new HttpError(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie corrupta */ }
    }
  }
  return out;
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function clientIp(req) {
  if (isLoopback(req)) {
    const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// Petición hecha en este mismo equipo (no a través del túnel).
const isLocalRequest = (req) => isLoopback(req) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && !req.headers['cf-ray'];

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
}

function validName(name) {
  const n = String(name || '').trim().replace(/[. ]+$/, '');
  if (!n || n.length > 200 || n === '.' || n === '..') return null;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n)) return null;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return null;
  return n;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
  if (pw.length > 256) throw new HttpError(400, 'La contraseña es demasiado larga');
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

let crc32 = zlib.crc32;
if (typeof crc32 !== 'function') {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  crc32 = (buf, prev = 0) => {
    let c = (prev ^ 0xffffffff) >>> 0;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
}

function writeChunk(res, buf) {
  if (res.destroyed) return Promise.reject(new Error('aborted'));
  if (res.write(buf)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      err ? reject(err) : resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('aborted'));
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

function log(...args) {
  const t = new Date().toLocaleTimeString('es', { hour12: false });
  console.log(`\x1b[90m${t}\x1b[0m`, ...args);
}

// ───────────────────────── Estado ─────────────────────────

let config = loadConfig();
const STORAGE = path.resolve(ROOT, config.storage);
const db = loadDb();
const sessions = new Map(); // token -> { userId, exp }
const limiter = new Map(); // ip -> { count, first }
const uploadLocks = new Set();
let usageCache = { at: 0, value: null };
let setupCode = null;

function resolveIn(base, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('\0')) throw new HttpError(400, 'Ruta inválida');
  const full = path.resolve(base, clean);
  if (full !== base && !full.startsWith(base + path.sep)) throw new HttpError(400, 'Ruta fuera de la carpeta permitida');
  return full;
}


const relOf = (full) => path.relative(STORAGE, full).split(path.sep).join('/');
const invalidateUsage = () => { usageCache.at = 0; };

function activity(user, action, detail = '', ip = '') {
  db.activity.push({ t: Date.now(), user: user?.username || null, action, detail, ip });
  if (db.activity.length > MAX_ACTIVITY) db.activity.splice(0, db.activity.length - MAX_ACTIVITY);
  saveDb();
}

// Límite de intentos (inicio de sesión, código de configuración, contraseñas de enlaces)
function checkLimit(ip) {
  const f = limiter.get(ip);
  if (f && f.count >= LIMIT_MAX_FAILS && Date.now() - f.first < LIMIT_WINDOW_MS) {
    const mins = Math.ceil((LIMIT_WINDOW_MS - (Date.now() - f.first)) / 60000);
    throw new HttpError(429, `Demasiados intentos. Inténtalo de nuevo en ${mins} min.`);
  }
}

async function failLimit(ip) {
  const f = limiter.get(ip);
  const entry = f && Date.now() - f.first < LIMIT_WINDOW_MS ? f : { count: 0, first: Date.now() };
  entry.count++;
  limiter.set(ip, entry);
  await new Promise((r) => setTimeout(r, 600));
  return entry.count;
}

// ───────────────────────── Sesiones y usuarios ─────────────────────────

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, lastLogin: u.lastLogin || null });
const findUser = (username) => db.users.find((u) => u.username.toLowerCase() === String(username || '').trim().toLowerCase());

function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, exp: Date.now() + config.sessionHours * 3600 * 1000 });
  return token;
}

function sessionToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  if (cookie) return cookie;
  try { return new URL(req.url, 'http://x').searchParams.get('access_token') || null; } catch { return null; }
}

function getUser(req) {
  const token = sessionToken(req);
  const s = token && sessions.get(token);
  if (!s || s.exp < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const user = db.users.find((u) => u.id === s.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  s.exp = Date.now() + config.sessionHours * 3600 * 1000;
  return user;
}

function dropSessions(userId, exceptToken) {
  for (const [t, s] of sessions) if (s.userId === userId && t !== exceptToken) sessions.delete(t);
}

function sessionCookie(req, token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

function newSetupCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  const raw = [...bytes].map((b) => chars[b % chars.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
  for (const [ip, f] of limiter) if (now - f.first > LIMIT_WINDOW_MS) limiter.delete(ip);
}, 60 * 1000).unref();

// ───────────────────────── Sistema de archivos ─────────────────────────
// Los archivos del hosting pasan siempre por store(): disco de este PC u otro PC (ver lib/storage.js).

const store = () => ctx.store();
const cleanRel = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const joinRel = (...parts) => parts.map(cleanRel).filter(Boolean).join('/');
const baseName = (rel) => rel.split('/').pop();
const parentRel = (rel) => rel.split('/').slice(0, -1).join('/');

function checkRel(rel) {
  const r = cleanRel(rel);
  if (r.includes('\0') || r.split('/').some((s) => s === '..')) throw new HttpError(400, 'Ruta inválida');
  return r;
}

async function storageUsage() {
  const s = store();
  if (usageCache.value && usageCache.key === s.key && Date.now() - usageCache.at < 60 * 1000) return usageCache.value;
  usageCache = { at: Date.now(), key: s.key, value: await s.usage() };
  return usageCache.value;
}

async function movePath(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY') throw new HttpError(409, `“${path.basename(from)}” está en uso por otro programa`);
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

// Mantiene los enlaces compartidos al renombrar o mover.
function rewriteSharePaths(oldRel, newRel) {
  let changed = false;
  for (const s of db.shares) {
    if (s.path === oldRel || s.path.startsWith(`${oldRel}/`)) {
      s.path = newRel + s.path.slice(oldRel.length);
      changed = true;
    }
  }
  if (changed) saveDb();
}

// Envía un archivo con soporte de rangos (vídeo, audio, descargas reanudables).
async function sendRanged(req, res, { name, size, mtime, open }, { download = false } = {}) {
  const ext = extOf(name);
  const isText = TEXT_EXT.has(ext);
  const inline = !download && (isText || Boolean(MIME[ext]));
  const headers = {
    'Content-Type': inline ? (isText ? 'text/plain; charset=utf-8' : MIME[ext]) : (MIME[ext] || 'application/octet-stream'),
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'Accept-Ranges': 'bytes',
    'Last-Modified': new Date(mtime).toUTCString(),
    'Cache-Control': 'private, max-age=0, must-revalidate',
  };
  // Aísla el contenido servido (evita que un SVG/HTML subido ejecute scripts en este origen).
  if (ext !== 'pdf') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  if (req.method === 'HEAD' || size === 0) {
    res.writeHead(status, { ...headers, 'Content-Length': 0 });
    return res.end();
  }
  const stream = await open(start, end);
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Archivo por ruta absoluta de este PC (código y bases de datos).
async function serveFile(req, res, full, opts) {
  let st;
  try { st = await fsp.stat(full); } catch { throw new HttpError(404, 'Archivo no encontrado'); }
  if (!st.isFile()) throw new HttpError(400, 'No es un archivo');
  await sendRanged(req, res, { name: path.basename(full), size: st.size, mtime: st.mtimeMs, open: async (s, e) => fs.createReadStream(full, { start: s, end: e }) }, opts);
}

// Archivo del almacenamiento del hosting.
async function serveStoreFile(req, res, rel, opts) {
  const s = store();
  const st = await s.stat(rel);
  if (!st) throw new HttpError(404, 'Archivo no encontrado');
  if (st.type !== 'file') throw new HttpError(400, 'No es un archivo');
  await sendRanged(req, res, { name: baseName(rel), size: st.size, mtime: st.mtime, open: (a, b) => s.openRead(rel, a, b) }, opts);
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Lista de entradas para un ZIP a partir de rutas del almacenamiento.
async function zipTargets(rels) {
  const s = store();
  const entries = [];
  const fileEntry = (rel, zipRel, st) => ({ rel: zipRel, isDir: false, size: st.size, mtime: new Date(st.mtime), open: () => s.openRead(rel, 0, Math.max(0, st.size - 1)) });
  for (const raw of rels) {
    const r = checkRel(raw);
    const st = await s.stat(r);
    if (!st) throw new HttpError(404, `No existe: /${r}`);
    const prefix = r ? baseName(r) : '';
    if (st.type === 'file') { entries.push(fileEntry(r, prefix, st)); continue; }
    if (r) entries.push({ rel: prefix, isDir: true, size: 0, mtime: new Date(st.mtime) });
    for (const e of await s.walk(r)) {
      const inner = r ? e.rel.slice(r.length + 1) : e.rel;
      const zipRel = prefix ? `${prefix}/${inner}` : inner;
      entries.push(e.type === 'dir' ? { rel: zipRel, isDir: true, size: 0, mtime: new Date(e.mtime) } : fileEntry(e.rel, zipRel, e));
    }
  }
  const total = entries.reduce((sum, e) => sum + e.size + 100 + Buffer.byteLength(e.rel) * 2, 0);
  if (total > ZIP_LIMIT || entries.length > 65000) {
    throw new HttpError(413, 'La selección supera 4 GB. Descarga los archivos grandes por separado.');
  }
  return entries;
}

// entries: { rel, isDir, size, mtime: Date, open?: () => Promise<Readable>, abs?: ruta local }
async function streamZip(res, entries, zipName) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', zipName),
    'Cache-Control': 'no-store',
  });
  let offset = 0;
  const w = async (buf) => { await writeChunk(res, buf); offset += buf.length; };
  const central = [];
  try {
    for (const e of entries) {
      const name = Buffer.from(e.isDir ? `${e.rel}/` : e.rel, 'utf8');
      const { time, date } = dosDateTime(e.mtime);
      const flags = e.isDir ? 0x0800 : 0x0808; // UTF-8 (+ descriptor de datos)
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(flags, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt16LE(name.length, 26);
      const headerOffset = offset;
      await w(header);
      await w(name);
      let crc = 0;
      let size = 0;
      if (!e.isDir) {
        const src = e.open ? (e.size ? await e.open() : []) : fs.createReadStream(e.abs);
        for await (const chunk of src) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          await w(chunk);
        }
        const dd = Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(crc >>> 0, 4);
        dd.writeUInt32LE(size, 8);
        dd.writeUInt32LE(size, 12);
        await w(dd);
      }
      central.push({ name, time, date, flags, crc: crc >>> 0, size, headerOffset, isDir: e.isDir });
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(c.flags, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.size, 20);
      h.writeUInt32LE(c.size, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.isDir ? 0x10 : 0, 38);
      h.writeUInt32LE(c.headerOffset, 42);
      await w(h);
      await w(c.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await w(end);
    res.end();
  } catch (err) {
    if (err.message !== 'aborted') log('Error generando ZIP:', err.message);
    res.destroy();
  }
}

// ───────────────────────── Rutas ─────────────────────────

const routes = [];
function route(method, pattern, role, handler) {
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, re, role, handler });
}

async function handleApi(req, res, url) {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && req.headers['x-requested-with'] !== 'noir') throw new HttpError(403, 'Solicitud no permitida');
  for (const r of routes) {
    if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const user = getUser(req);
    if (r.role) {
      if (!user) throw new HttpError(401, 'No autenticado');
      if (ROLES[user.role] < ROLES[r.role]) throw new HttpError(403, 'No tienes permiso para esta acción');
    }
    const params = {};
    for (const [k, v] of Object.entries(m.groups || {})) params[k] = decodeURIComponent(v);
    return r.handler({ req, res, url, params, user, ip: clientIp(req) });
  }
  throw new HttpError(404, 'Recurso no encontrado');
}

// ── Sesión, configuración inicial y acceso

route('GET', '/api/session', null, ({ req, res, user }) => {
  // CORS abierto solo aquí: permite al enlace fijo (GitHub Pages) comprobar que el servidor está en línea.
  // Sin cookies cruzadas, desde otro origen nunca devuelve datos de un usuario.
  sendJson(res, 200, {
    authenticated: Boolean(user),
    user: user ? publicUser(user) : null,
    studio: config.studioName,
    setupRequired: db.users.length === 0,
    setupNeedsCode: db.users.length === 0 && !isLocalRequest(req),
    version: VERSION,
  }, { 'Access-Control-Allow-Origin': '*' });
});

route('POST', '/api/setup', null, async ({ req, res, ip }) => {
  if (db.users.length) throw new HttpError(409, 'El hosting ya está configurado');
  checkLimit(ip);
  const { code, username, password } = await readJson(req);
  if (!isLocalRequest(req)) {
    const given = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!setupCode || given !== setupCode.replace('-', '')) {
      const n = await failLimit(ip);
      log(`\x1b[31m●\x1b[0m Código de configuración incorrecto desde ${ip} (${n}/${LIMIT_MAX_FAILS})`);
      throw new HttpError(403, 'Código de configuración incorrecto. Míralo en la ventana del servidor.');
    }
  }
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) throw new HttpError(400, 'Usuario: 3 a 32 caracteres (letras, números, punto, guion)');
  validatePassword(password);
  const user = { id: crypto.randomUUID(), username: name, hash: hashPassword(password), role: 'admin', createdAt: Date.now(), lastLogin: Date.now() };
  db.users.push(user);
  setupCode = null;
  fs.rmSync(path.join(DATA_DIR, 'codigo-configuracion.txt'), { force: true });
  activity(user, 'setup', 'Cuenta de administrador creada', ip);
  writeDbNow();
  log(`\x1b[32m✓\x1b[0m Hosting configurado. Administrador: ${user.username}`);
  { const token = createSession(user); sendJson(res, 200, { ok: true, user: publicUser(user), token }, { 'Set-Cookie': sessionCookie(req, token, config.sessionHours * 3600) }); }
});

route('POST', '/api/login', null, async ({ req, res, ip }) => {
  checkLimit(ip);
  const { username, password } = await readJson(req);
  const user = findUser(username);
  const ok = typeof password === 'string' && password.length <= 256 && verifyPassword(password, user?.hash);
  if (!ok || !user) {
    const n = await failLimit(ip);
    activity(null, 'login_failed', `Usuario “${String(username || '').slice(0, 40)}”`, ip);
    log(`\x1b[31m●\x1b[0m Acceso fallido desde ${ip} (${n}/${LIMIT_MAX_FAILS})`);
    throw new HttpError(401, 'Usuario o contraseña incorrectos');
  }
  limiter.delete(ip);
  user.lastLogin = Date.now();
  activity(user, 'login', '', ip);
  log(`\x1b[32m●\x1b[0m ${user.username} inició sesión desde ${ip}`);
  { const token = createSession(user); sendJson(res, 200, { ok: true, user: publicUser(user), token }, { 'Set-Cookie': sessionCookie(req, token, config.sessionHours * 3600) }); }
});

route('POST', '/api/logout', null, ({ req, res, user, ip }) => {
  sessions.delete(sessionToken(req));
  if (user) activity(user, 'logout', '', ip);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
});

// ── Códigos de acceso (invitaciones para crear cuenta)

const inviteActive = (i) => (!i.expiresAt || i.expiresAt > Date.now()) && (!i.maxUses || i.uses < i.maxUses);
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

route('GET', '/api/invites', 'admin', ({ res }) => {
  sendJson(res, 200, { items: [...db.invites].sort((a, b) => b.createdAt - a.createdAt).map((i) => ({ ...i, active: inviteActive(i) })) });
});

route('POST', '/api/invites', 'admin', async ({ req, res, user, ip }) => {
  const { role, hours, uses, note } = await readJson(req);
  if (!ROLES[role]) throw new HttpError(400, 'Rol no válido');
  const h = Number(hours) || 0;
  const max = Math.max(0, Math.floor(Number(uses) || 0));
  let code;
  do { code = newSetupCode(); } while (db.invites.some((i) => i.code === code));
  const invite = {
    code, role, note: String(note || '').trim().slice(0, 80),
    createdBy: user.username, createdAt: Date.now(),
    expiresAt: h > 0 ? Date.now() + h * 3600 * 1000 : null,
    maxUses: max || null, uses: 0, usedBy: [],
  };
  db.invites.push(invite);
  saveDb();
  activity(user, 'invite_create', `${code} (${ROLE_ES[role]})`, ip);
  sendJson(res, 200, { ok: true, invite: { ...invite, active: true } });
});

route('DELETE', '/api/invites/:code', 'admin', ({ res, params, user, ip }) => {
  const before = db.invites.length;
  db.invites = db.invites.filter((i) => i.code !== params.code);
  if (db.invites.length === before) throw new HttpError(404, 'El código no existe');
  saveDb();
  activity(user, 'invite_delete', params.code, ip);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/register', null, async ({ req, res, ip }) => {
  checkLimit(ip);
  const { code, username, password } = await readJson(req);
  const invite = db.invites.find((i) => normCode(i.code) === normCode(code));
  if (!invite || !inviteActive(invite)) {
    const n = await failLimit(ip);
    log(`\x1b[31m●\x1b[0m Código de acceso no válido desde ${ip} (${n}/${LIMIT_MAX_FAILS})`);
    throw new HttpError(403, 'El código de acceso no es válido o ha caducado');
  }
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) throw new HttpError(400, 'Usuario: 3 a 32 caracteres (letras, números, punto, guion)');
  if (findUser(name)) throw new HttpError(409, 'Ese nombre de usuario ya existe');
  validatePassword(password);
  const user = { id: crypto.randomUUID(), username: name, hash: hashPassword(password), role: invite.role, createdAt: Date.now(), lastLogin: Date.now(), invitedBy: invite.createdBy };
  db.users.push(user);
  invite.uses++;
  invite.usedBy.push({ username: name, at: Date.now() });
  limiter.delete(ip);
  activity(user, 'register', `Con el código ${invite.code} (${ROLE_ES[user.role]})`, ip);
  writeDbNow();
  log(`\x1b[32m✓\x1b[0m Nueva cuenta: ${name} (${ROLE_ES[user.role]}) con el código ${invite.code}`);
  { const token = createSession(user); sendJson(res, 200, { ok: true, user: publicUser(user), token }, { 'Set-Cookie': sessionCookie(req, token, config.sessionHours * 3600) }); }
});

route('POST', '/api/account/password', 'viewer', async ({ req, res, user, ip }) => {
  const { current, next } = await readJson(req);
  if (!verifyPassword(String(current || ''), user.hash)) throw new HttpError(400, 'La contraseña actual no es correcta');
  validatePassword(next);
  user.hash = hashPassword(next);
  dropSessions(user.id, sessionToken(req));
  activity(user, 'password_change', 'Cambió su contraseña', ip);
  sendJson(res, 200, { ok: true });
});

// ── Archivos

const storeInfo = () => ({ kind: store().kind, name: ctx.storeLabel() });
const trashOfStore = () => db.trash.filter((t) => (t.store || 'local') === store().key);

route('GET', '/api/list', 'viewer', async ({ res, url }) => {
  const rel = checkRel(url.searchParams.get('path'));
  const items = await store().list(rel);
  sendJson(res, 200, { path: rel, items, storage: storeInfo() });
});

route('GET', '/api/search', 'viewer', async ({ res, url }) => {
  const q = String(url.searchParams.get('q') || '').trim();
  if (q.length < 2) throw new HttpError(400, 'Escribe al menos 2 caracteres');
  sendJson(res, 200, await store().search(q, 300));
});

route('GET', '/api/folders', 'viewer', async ({ res, url }) => {
  const rel = checkRel(url.searchParams.get('path'));
  sendJson(res, 200, { path: rel, folders: await store().folders(rel) });
});

route('GET', '/api/stats', 'viewer', async ({ res }) => {
  const s = store();
  const [usage, disk] = await Promise.all([storageUsage(), s.disk()]);
  sendJson(res, 200, { ...usage, disk, host: os.hostname(), studio: config.studioName, trash: trashOfStore().length, storage: storeInfo() });
});

route('GET', '/api/file', 'viewer', async ({ req, res, url, user, ip }) => {
  const rel = checkRel(url.searchParams.get('path'));
  const download = url.searchParams.get('dl') === '1';
  if (download && !req.headers.range) {
    activity(user, 'download', rel, ip);
    log(`↓ ${user.username} descargó ${rel}`);
  }
  await serveStoreFile(req, res, rel, { download });
});

route('GET', '/api/zip', 'viewer', async ({ res, url, user, ip }) => {
  const targets = url.searchParams.getAll('path').map(checkRel);
  if (!targets.length) throw new HttpError(400, 'Nada que comprimir');
  const entries = await zipTargets(targets);
  const zipName = targets.length === 1 && targets[0] ? `${baseName(targets[0])}.zip` : `${config.studioName}.zip`;
  activity(user, 'zip', `${zipName} (${entries.length} elementos)`, ip);
  log(`↓ ${user.username} descargó ${zipName}`);
  await streamZip(res, entries, zipName);
});

route('POST', '/api/mkdir', 'editor', async ({ req, res, user, ip }) => {
  const { path: rel, name } = await readJson(req);
  const clean = validName(name);
  if (!clean) throw new HttpError(400, 'Nombre de carpeta no válido');
  const target = joinRel(checkRel(rel), clean);
  if (await store().stat(target)) throw new HttpError(409, 'Ya existe un elemento con ese nombre');
  await store().mkdir(target);
  activity(user, 'mkdir', target, ip);
  sendJson(res, 200, { ok: true, name: clean });
});

route('POST', '/api/rename', 'editor', async ({ req, res, user, ip }) => {
  const { path: rel, name } = await readJson(req);
  const clean = validName(name);
  if (!clean) throw new HttpError(400, 'Nombre no válido');
  const from = checkRel(rel);
  if (!from) throw new HttpError(400, 'No se puede renombrar la raíz');
  const s = store();
  if (!(await s.stat(from))) throw new HttpError(404, 'El elemento no existe');
  const to = joinRel(parentRel(from), clean);
  if (to.toLowerCase() !== from.toLowerCase() && (await s.stat(to))) throw new HttpError(409, 'Ya existe un elemento con ese nombre');
  await s.rename(from, to);
  rewriteSharePaths(from, to);
  activity(user, 'rename', `${from} → ${clean}`, ip);
  sendJson(res, 200, { ok: true, name: clean });
});

async function transfer({ req, res, user, ip }, mode) {
  const { paths, dest } = await readJson(req);
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Nada seleccionado');
  const s = store();
  const destRel = checkRel(dest);
  if ((await s.stat(destRel))?.type !== 'dir') throw new HttpError(404, 'La carpeta de destino no existe');
  let count = 0;
  for (const raw of paths) {
    const from = checkRel(raw);
    if (!from) throw new HttpError(400, 'No se puede mover la raíz');
    if (!(await s.stat(from))) continue;
    if (destRel === from || destRel.startsWith(`${from}/`)) throw new HttpError(400, `No puedes ${mode === 'move' ? 'mover' : 'copiar'} “${baseName(from)}” dentro de sí misma`);
    if (mode === 'move' && parentRel(from) === destRel) continue;
    const to = joinRel(destRel, await s.unique(destRel, baseName(from)));
    if (mode === 'move') {
      await s.rename(from, to);
      rewriteSharePaths(from, to);
    } else {
      await s.copy(from, to);
    }
    count++;
  }
  invalidateUsage();
  activity(user, mode, `${count} elemento(s) → /${destRel}`, ip);
  sendJson(res, 200, { ok: true, count });
}

route('POST', '/api/move', 'editor', (c) => transfer(c, 'move'));
route('POST', '/api/copy', 'editor', (c) => transfer(c, 'copy'));

route('POST', '/api/delete', 'editor', async ({ req, res, user, ip }) => {
  const { paths } = await readJson(req);
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Nada que eliminar');
  const s = store();
  for (const raw of paths) {
    const rel = checkRel(raw);
    if (!rel) throw new HttpError(400, 'No se puede eliminar la raíz');
    const id = crypto.randomBytes(8).toString('hex');
    const info = await s.trash(rel, id);
    if (!info) continue;
    db.trash.push({ id, name: baseName(rel), original: rel, isDir: info.isDir, size: info.size, deletedAt: Date.now(), deletedBy: user.username, store: s.key });
    activity(user, 'delete', rel, ip);
  }
  invalidateUsage();
  saveDb();
  sendJson(res, 200, { ok: true });
});

// ── Papelera

route('GET', '/api/trash', 'editor', ({ res }) => {
  sendJson(res, 200, { items: [...trashOfStore()].sort((a, b) => b.deletedAt - a.deletedAt), days: config.trashDays });
});

route('POST', '/api/trash/restore', 'editor', async ({ req, res, user, ip }) => {
  const { ids } = await readJson(req);
  const s = store();
  let restored = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const item = trashOfStore().find((t) => t.id === id);
    if (!item) continue;
    const finalRel = await s.restore(item.id, item.name, item.original);
    db.trash = db.trash.filter((t) => t !== item);
    activity(user, 'restore', finalRel, ip);
    restored++;
  }
  invalidateUsage();
  saveDb();
  sendJson(res, 200, { ok: true, restored });
});

async function purgeTrash(ids) {
  for (const id of ids) {
    const item = db.trash.find((t) => t.id === id);
    if (!item) continue;
    const s = ctx.storeByKey(item.store || 'local');
    if (s) await s.purge(id).catch(() => {});
    db.trash = db.trash.filter((t) => t !== item);
  }
  saveDb();
}

route('POST', '/api/trash/purge', 'admin', async ({ req, res, user, ip }) => {
  const { ids, all } = await readJson(req);
  const list = all ? trashOfStore().map((t) => t.id) : (Array.isArray(ids) ? ids : []);
  await purgeTrash(list);
  activity(user, all ? 'empty_trash' : 'purge', `${list.length} elemento(s)`, ip);
  sendJson(res, 200, { ok: true });
});

// ── Enlaces compartidos

const shareActive = (s) => (!s.expiresAt || s.expiresAt > Date.now()) && (!s.maxDownloads || s.downloads < s.maxDownloads);
async function shareView(s) {
  const st = await store().stat(s.path).catch(() => null);
  return { ...s, passwordHash: undefined, hasPassword: Boolean(s.passwordHash), active: shareActive(s), exists: Boolean(st) };
}

route('GET', '/api/shares', 'editor', async ({ res, user }) => {
  const list = db.shares.filter((s) => user.role === 'admin' || s.createdBy === user.username);
  const items = await Promise.all(list.map(shareView));
  sendJson(res, 200, { items: items.sort((a, b) => b.createdAt - a.createdAt) });
});

route('POST', '/api/shares', 'editor', async ({ req, res, user, ip }) => {
  const { path: raw, hours, password, maxDownloads } = await readJson(req);
  const rel = checkRel(raw);
  if (!rel) throw new HttpError(400, 'No se puede compartir todo el almacenamiento');
  const st = await store().stat(rel);
  if (!st) throw new HttpError(404, 'El elemento no existe');
  const h = Number(hours) || 0;
  const max = Math.max(0, Math.floor(Number(maxDownloads) || 0));
  if (password) validatePassword(password);
  const share = {
    token: crypto.randomBytes(18).toString('base64url'),
    path: rel,
    name: baseName(rel),
    isDir: st.type === 'dir',
    createdBy: user.username,
    createdAt: Date.now(),
    expiresAt: h > 0 ? Date.now() + h * 3600 * 1000 : null,
    maxDownloads: max || null,
    downloads: 0,
    passwordHash: password ? hashPassword(password) : null,
  };
  db.shares.push(share);
  saveDb();
  activity(user, 'share_create', share.path, ip);
  sendJson(res, 200, { ok: true, share: await shareView(share) });
});

route('DELETE', '/api/shares/:token', 'editor', ({ res, params, user, ip }) => {
  const s = db.shares.find((x) => x.token === params.token);
  if (!s) throw new HttpError(404, 'El enlace no existe');
  if (user.role !== 'admin' && s.createdBy !== user.username) throw new HttpError(403, 'Solo puedes eliminar tus propios enlaces');
  db.shares = db.shares.filter((x) => x !== s);
  saveDb();
  activity(user, 'share_delete', s.path, ip);
  sendJson(res, 200, { ok: true });
});

// Acceso público a un enlace compartido
const shareKey = (s) => crypto.createHmac('sha256', db.secret).update(`${s.token}:${s.passwordHash || ''}`).digest('base64url').slice(0, 32);

async function getShare(token) {
  const s = db.shares.find((x) => x.token === token);
  if (!s || !shareActive(s)) throw new HttpError(404, 'Este enlace no existe o ha caducado');
  const st = await store().stat(s.path);
  if (!st) throw new HttpError(404, 'El archivo compartido ya no está disponible');
  return { s, st };
}

route('GET', '/api/public/share/:token', null, async ({ res, params }) => {
  const { s, st } = await getShare(params.token);
  sendJson(res, 200, {
    name: s.name,
    isDir: st.type === 'dir',
    size: st.type === 'dir' ? await store().dirSize(s.path) : st.size,
    mtime: st.mtime,
    expiresAt: s.expiresAt,
    remaining: s.maxDownloads ? s.maxDownloads - s.downloads : null,
    needsPassword: Boolean(s.passwordHash),
    sharedBy: s.createdBy,
    studio: config.studioName,
  });
});

route('POST', '/api/public/share/:token/unlock', null, async ({ req, res, params, ip }) => {
  checkLimit(ip);
  const { s } = await getShare(params.token);
  const { password } = await readJson(req);
  if (!s.passwordHash || !verifyPassword(String(password || ''), s.passwordHash)) {
    await failLimit(ip);
    throw new HttpError(401, 'Contraseña incorrecta');
  }
  sendJson(res, 200, { key: shareKey(s) });
});

route('GET', '/api/public/share/:token/file', null, async ({ req, res, url, params, ip }) => {
  const { s, st } = await getShare(params.token);
  if (s.passwordHash && url.searchParams.get('key') !== shareKey(s)) throw new HttpError(401, 'Este enlace está protegido con contraseña');
  const download = url.searchParams.get('dl') === '1';
  if (download && !req.headers.range) {
    s.downloads++;
    saveDb();
    activity({ username: `enlace · ${s.createdBy}` }, 'share_download', s.path, ip);
    log(`↓ Descarga por enlace compartido: ${s.path}`);
  }
  if (st.type === 'dir') {
    if (!download) throw new HttpError(400, 'Las carpetas solo se pueden descargar');
    return streamZip(res, await zipTargets([s.path]), `${s.name}.zip`);
  }
  await serveStoreFile(req, res, s.path, { download });
});

// ── Usuarios (administración)

route('GET', '/api/users', 'admin', ({ res }) => {
  sendJson(res, 200, { items: db.users.map(publicUser) });
});

route('POST', '/api/users', 'admin', async ({ req, res, user, ip }) => {
  const { username, password, role } = await readJson(req);
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) throw new HttpError(400, 'Usuario: 3 a 32 caracteres (letras, números, punto, guion)');
  if (findUser(name)) throw new HttpError(409, 'Ese nombre de usuario ya existe');
  if (!ROLES[role]) throw new HttpError(400, 'Rol no válido');
  validatePassword(password);
  const created = { id: crypto.randomUUID(), username: name, hash: hashPassword(password), role, createdAt: Date.now(), lastLogin: null };
  db.users.push(created);
  saveDb();
  activity(user, 'user_create', `${name} (${ROLE_ES[role]})`, ip);
  sendJson(res, 200, { ok: true, user: publicUser(created) });
});

route('PATCH', '/api/users/:id', 'admin', async ({ req, res, params, user, ip }) => {
  const target = db.users.find((u) => u.id === params.id);
  if (!target) throw new HttpError(404, 'El usuario no existe');
  const { role, password } = await readJson(req);
  if (role !== undefined) {
    if (!ROLES[role]) throw new HttpError(400, 'Rol no válido');
    const admins = db.users.filter((u) => u.role === 'admin');
    if (target.role === 'admin' && role !== 'admin' && admins.length === 1) throw new HttpError(400, 'Debe quedar al menos un administrador');
    target.role = role;
    activity(user, 'user_update', `${target.username} → ${ROLE_ES[role]}`, ip);
  }
  if (password !== undefined) {
    validatePassword(password);
    target.hash = hashPassword(password);
    dropSessions(target.id, target.id === user.id ? sessionToken(req) : null);
    activity(user, 'user_update', `Nueva contraseña para ${target.username}`, ip);
  }
  saveDb();
  sendJson(res, 200, { ok: true, user: publicUser(target) });
});

route('DELETE', '/api/users/:id', 'admin', ({ res, params, user, ip }) => {
  const target = db.users.find((u) => u.id === params.id);
  if (!target) throw new HttpError(404, 'El usuario no existe');
  if (target.id === user.id) throw new HttpError(400, 'No puedes eliminar tu propia cuenta');
  db.users = db.users.filter((u) => u !== target);
  dropSessions(target.id);
  saveDb();
  activity(user, 'user_delete', target.username, ip);
  sendJson(res, 200, { ok: true });
});

// ── Actividad y ajustes

route('GET', '/api/activity', 'admin', ({ res }) => {
  sendJson(res, 200, { items: db.activity.slice(-400).reverse() });
});

route('GET', '/api/settings', 'viewer', ({ res }) => {
  sendJson(res, 200, {
    studioName: config.studioName,
    sessionHours: config.sessionHours,
    trashDays: config.trashDays,
    publicUrl: publicBase(),
    fixedUrl: process.env.NOIR_FIXED_URL || null,
    lanUrls: lanAddresses().map((ip) => `http://${ip}:${config.port}`),
    storagePath: store().kind === 'local' ? STORAGE : `${store().agent.name}: ${store().agent.root}`,
    storageKind: store().kind,
    host: os.hostname(),
    version: VERSION,
    node: process.version,
    uptime: process.uptime(),
  });
});

route('POST', '/api/settings', 'admin', async ({ req, res, user, ip }) => {
  const { studioName, sessionHours, trashDays } = await readJson(req);
  const cfg = loadConfig();
  if (studioName !== undefined) {
    const n = String(studioName).trim();
    if (!n || n.length > 40) throw new HttpError(400, 'El nombre debe tener entre 1 y 40 caracteres');
    cfg.studioName = n;
  }
  if (sessionHours !== undefined) {
    const h = Number(sessionHours);
    if (!(h >= 1 && h <= 720)) throw new HttpError(400, 'La sesión debe durar entre 1 y 720 horas');
    cfg.sessionHours = h;
  }
  if (trashDays !== undefined) {
    const d = Number(trashDays);
    if (!(d >= 1 && d <= 365)) throw new HttpError(400, 'La papelera debe conservar entre 1 y 365 días');
    cfg.trashDays = d;
  }
  saveConfig(cfg);
  config = { ...config, ...cfg };
  activity(user, 'settings', 'Ajustes actualizados', ip);
  sendJson(res, 200, { ok: true });
});

// ── Subidas por fragmentos (reanudables)

// Zona de destino de una subida: archivos del hosting, bases de datos o un proyecto de Código.
function uploadTarget(url, user) {
  const area = ['db', 'project'].includes(url.searchParams.get('area')) ? url.searchParams.get('area') : 'files';
  const dirRel = area === 'db' ? '' : checkRel(url.searchParams.get('path'));
  const name = validName(url.searchParams.get('name'));
  const size = Number(url.searchParams.get('size'));
  if (!name || (area === 'db' && name.startsWith('.'))) throw new HttpError(400, 'Nombre de archivo no válido');
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Tamaño no válido');
  if (area === 'project') {
    if (!ctx.projectCanUpload(url.searchParams.get('project'), user)) throw new HttpError(403, 'Solo quien subió el proyecto o un administrador puede cambiarlo');
    if (ctx.projectRejects(joinRel(dirRel, name))) throw new HttpError(400, 'Archivo omitido: dependencias o claves no se suben');
  }
  const s = area === 'db' ? ctx.localStore : area === 'project' ? ctx.projectStore(url.searchParams.get('project')) : store();
  const id = crypto.createHash('sha256').update(`${area}\0${s.key}\0${dirRel}\0${name}\0${size}`).digest('hex').slice(0, 40);
  return { area, dirRel, name, size, id, s };
}

route('GET', '/api/upload/status', 'editor', async ({ res, url, user }) => {
  const t = uploadTarget(url, user);
  if (t.area !== 'db') await t.s.mkdir(t.dirRel);
  const offset = uploadLocks.has(t.id) ? await t.s.partSize(t.id) : await t.s.resetPart(t.id, t.size);
  sendJson(res, 200, { offset });
});

route('PUT', '/api/upload', 'editor', async ({ req, res, url, user, ip }) => {
  const t = uploadTarget(url, user);
  const offset = Number(url.searchParams.get('offset'));
  const maxChunk = config.maxChunkMB * 1024 * 1024;
  if (Number(req.headers['content-length']) > maxChunk) throw new HttpError(413, 'Fragmento demasiado grande');
  if (uploadLocks.has(t.id)) throw new HttpError(423, 'Este archivo ya se está subiendo');

  uploadLocks.add(t.id);
  try {
    let now;
    try {
      now = await t.s.appendPart(t.id, offset, req, maxChunk, t.size);
    } catch (err) {
      req.resume();
      throw err;
    }
    if (now < t.size) return sendJson(res, 200, { offset: now, done: false });

    if (t.area === 'db') {
      const replaced = await ctx.finalizeDbUpload(ctx.localStore.partPath(t.id), t.name);
      activity(user, 'db_upload', `${t.name} (${fmtBytes(t.size)})${replaced ? ' · versión anterior guardada' : ''}`, ip);
      log(`↑ ${user.username} subió la base de datos ${t.name} (${fmtBytes(t.size)})`);
      return sendJson(res, 200, { offset: now, done: true, name: t.name });
    }
    const finalName = await t.s.finishPart(t.id, t.dirRel, t.name);
    if (t.area === 'project') return sendJson(res, 200, { offset: now, done: true, name: finalName });
    const rel = joinRel(t.dirRel, finalName);
    invalidateUsage();
    activity(user, 'upload', `${rel} (${fmtBytes(t.size)})`, ip);
    log(`↑ ${user.username} subió ${rel} (${fmtBytes(t.size)})${t.s.kind === 'remote' ? ` → ${t.s.agent.name}` : ''}`);
    sendJson(res, 200, { offset: now, done: true, name: finalName });
  } finally {
    uploadLocks.delete(t.id);
  }
});

route('DELETE', '/api/upload', 'editor', async ({ res, url, user }) => {
  const t = uploadTarget(url, user);
  if (!uploadLocks.has(t.id)) await t.s.cancelPart(t.id);
  sendJson(res, 200, { ok: true });
});

// ───────────────────────── Módulos: código y bases de datos ─────────────────────────

const ctx = {
  ROOT, DATA_DIR, STORAGE, IS_SEA, VERSION, CONFIG_PATH,
  publicBase: () => publicBase(),
  lanUrls: () => lanAddresses().map((ip) => `http://${ip}:${config.port}`),
  invalidateUsage: () => invalidateUsage(),
  DB_DIR: path.join(ROOT, 'databases'),
  BIN_DIR: path.join(ROOT, 'bin'),
  db, route, HttpError, sendJson, readJson, activity, saveDb, writeDbNow, log,
  serveFile, streamZip, validName, movePath, fmtBytes, resolveIn,
  getConfig: () => config,
  updateConfig(patch) {
    const cfg = { ...loadConfig(), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete cfg[k];
    saveConfig(cfg);
    config = { ...config, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete config[k];
  },
};
require('./lib/storage')(ctx);
require('./lib/projects')(ctx);
require('./lib/databases')(ctx);
require('./lib/updates')(ctx);
require('./lib/migrate')(ctx);

const publicBase = () => process.env.NOIR_PUBLIC_URL || null;

// Mensajes del supervisor (servidor instalado): dirección pública actual del túnel.
process.on('message', (msg) => {
  if (msg?.type === 'public-url') process.env.NOIR_PUBLIC_URL = msg.url || '';
  if (msg?.type === 'shutdown') {
    try { writeDbNow(); } catch { /* nada */ }
    process.exit(0);
  }
});

// ───────────────────────── Estáticos ─────────────────────────

const APP_CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Ruta inválida'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (/^\/s\/[\w-]+\/?$/.test(rel)) rel = '/share.html';
  rel = path.posix.normalize(rel);
  if (!rel.startsWith('/') || rel.includes('..') || rel.includes('\0')) throw new HttpError(404, 'No encontrado');
  let data;
  try {
    // En el .exe, la web va incrustada como recursos; en desarrollo se lee de public/.
    data = IS_SEA ? Buffer.from(sea.getAsset(`public${rel}`)) : await fsp.readFile(path.join(PUBLIC_DIR, rel));
  } catch {
    throw new HttpError(404, 'No encontrado');
  }
  const ext = path.extname(rel);
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': APP_CSP,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ───────────────────────── Página en GitHub Pages (CORS) ─────────────────────────

const PAGES_ORIGIN = 'https://noirstudio-web.github.io';
function corsAllowed(req, res) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = [PAGES_ORIGIN, ...(Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [])];
  if (!allowed.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

// ───────────────────────── Servidor ─────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/') && corsAllowed(req, res)) {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError || err.expose ? err.status : 500;
    if (status === 500) log('\x1b[31mError:\x1b[0m', err.stack || err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Error interno del servidor' : err.message, ...err.extra });
    else res.destroy();
  }
});
server.requestTimeout = 0; // subidas largas por internet
server.headersTimeout = 60 * 1000;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function banner() {
  const gold = (s) => `\x1b[38;5;180m${s}\x1b[0m`;
  const dim = (s) => `\x1b[90m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const line = dim('─'.repeat(60));
  console.log('');
  console.log(`  ${gold('■')} ${bold(config.studioName.toUpperCase())}  ${dim(`· Hosting privado · v${VERSION}`)}`);
  console.log(`  ${line}`);
  console.log(`  ${dim('Este equipo     ')} http://localhost:${config.port}`);
  for (const ip of lanAddresses()) console.log(`  ${dim('Red local       ')} http://${ip}:${config.port}`);
  if (process.env.NOIR_PUBLIC_URL) {
    console.log(`  ${dim('Desde internet  ')} ${gold(bold(process.env.NOIR_PUBLIC_URL))}  ${dim('(copiado al portapapeles)')}`);
  }
  if (process.env.NOIR_FIXED_URL) {
    console.log(`  ${dim('Enlace fijo     ')} ${gold(bold(process.env.NOIR_FIXED_URL))}  ${dim('(siempre el mismo)')}`);
  }
  console.log(`  ${dim('Usuarios        ')} ${db.users.length}`);
  console.log(`  ${line}`);
  if (setupCode) {
    console.log(`  ${gold('▲')} ${bold('PRIMER INICIO')} — abre el panel y crea tu usuario administrador.`);
    console.log(`    Código de configuración:  ${gold(bold(setupCode))}`);
    console.log(`    ${dim('(solo se pide si lo configuras desde otro equipo)')}`);
    console.log(`  ${line}`);
  }
  console.log(`  ${dim('Deja esta ventana abierta. Ctrl+C para detener.')}`);
  console.log('');
}

function readStdinLines() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf.replace(/^\uFEFF/, '').split(/\r?\n/)));
  });
}

function prompt(question, hidden) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (input) => {
      for (const ch of input) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\b' || ch === '\u007f') {
          if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        buf += ch;
        process.stdout.write(hidden ? '*' : ch);
      }
    };
    stdin.on('data', onData);
  });
}

// Restablece la contraseña de un usuario desde este equipo (por si se olvida).
async function resetPasswordFlow() {
  console.log('\n  \x1b[38;5;180m■\x1b[0m \x1b[1mRestablecer contraseña\x1b[0m\n');
  if (!db.users.length) {
    console.log('  Aún no hay usuarios. Inicia el hosting y crea tu cuenta desde el navegador.\n');
    return;
  }
  console.log(`  Usuarios: ${db.users.map((u) => `${u.username} (${u.role})`).join(', ')}\n`);
  const tty = process.stdin.isTTY;
  const lines = tty ? null : await readStdinLines();
  const username = tty ? await prompt('  Usuario:              ') : lines[0];
  const user = findUser(username);
  if (!user) { console.log('  \x1b[31mEse usuario no existe.\x1b[0m\n'); process.exitCode = 1; return; }
  const pw = tty ? await prompt('  Nueva contraseña:     ', true) : lines[1] || '';
  const again = tty ? await prompt('  Repite la contraseña: ', true) : pw;
  if (pw.length < 8) { console.log('  \x1b[31mDebe tener al menos 8 caracteres.\x1b[0m\n'); process.exitCode = 1; return; }
  if (pw !== again) { console.log('  \x1b[31mLas contraseñas no coinciden.\x1b[0m\n'); process.exitCode = 1; return; }
  user.hash = hashPassword(pw);
  activity(user, 'password_change', 'Restablecida desde el equipo servidor');
  writeDbNow();
  console.log(`  \x1b[32m✓ Contraseña de ${user.username} actualizada.\x1b[0m Reinicia el hosting si estaba abierto.\n`);
}

async function main() {
  if (!db.secret) db.secret = crypto.randomBytes(32).toString('hex');
  if (process.argv.includes('--reset-password')) {
    await resetPasswordFlow();
    return;
  }
  // Migración desde la versión 1 (contraseña única sin usuarios).
  if (config.passwordHash) {
    const cfg = loadConfig();
    delete cfg.passwordHash;
    saveConfig(cfg);
    delete config.passwordHash;
  }
  if (!fs.existsSync(CONFIG_PATH)) saveConfig({ ...DEFAULTS });

  await fsp.mkdir(STORAGE, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.mkdir(TRASH_DIR, { recursive: true });

  // Vacía automáticamente lo que lleve en la papelera más días de los configurados.
  const purgeOld = () => {
    const limit = Date.now() - config.trashDays * 86400 * 1000;
    const old = db.trash.filter((t) => t.deletedAt < limit).map((t) => t.id);
    if (old.length) purgeTrash(old).then(() => log(`Papelera: ${old.length} elemento(s) antiguos eliminados`));
  };
  purgeOld();
  setInterval(purgeOld, 3600 * 1000).unref();

  // Mientras no haya cuentas, el código de configuración también se deja en data/ (solo accesible en este equipo).
  const setupFile = path.join(DATA_DIR, 'codigo-configuracion.txt');
  if (!db.users.length) {
    setupCode = newSetupCode();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(setupFile, `${setupCode}\n`);
  } else {
    fs.rmSync(setupFile, { force: true });
  }
  writeDbNow();

  const shutdown = () => { try { writeDbNow(); } catch { /* nada */ } process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`\n  \x1b[31mEl puerto ${config.port} ya está en uso. ¿Hay otra ventana del hosting abierta?\x1b[0m\n`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(config.port, config.host, banner);
}

main();
