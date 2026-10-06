'use strict';
/*
 * Pasa los datos de este PC a la nube (Neon): usuarios, enlaces, códigos, ajustes, actividad,
 * archivos de storage/, bases de datos y proyectos de Código.
 * Uso: node scripts/nube-importar.cjs [--forzar]   (lee las credenciales de .env.local)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^(\w+)="?(.*?)"?$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Algunos Windows no resuelven las direcciones de Neon con el resolvedor del sistema: se consulta el DNS directamente.
const dns = require('dns');
const systemLookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  systemLookup(host, opts, (err, address, family) => {
    if (!err) return cb(err, address, family);
    dns.resolve4(host, (e2, list) => {
      if (e2 || !list?.length) return cb(err);
      const ip = list.find((a) => !a.startsWith('100.')) || list[0];
      return opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);
    });
  });
};
const { S3 } = require('../lib/s3');
const { S3Store } = require('../lib/s3store');
const { createCloud } = require('../lib/cloud');

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'srt', 'vtt']);
const contentType = (name) => (TEXT_EXT.has(path.extname(name).slice(1).toLowerCase()) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.idea', '.vs', '.gradle', '.parcel-cache', '.turbo']);
const SECRET_RE = /^(\.env(\..+)?|.+\.(pem|key|pfx|p12|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|credentials(\.json)?|\.neon)$/i;
const MAX_FILE = 200 * 1024 * 1024;

function filesIn(dir, skip = () => false, rel = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r, e)) continue;
    if (e.isDirectory()) out.push(...filesIn(dir, skip, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

async function upload(store, dir, rels, label) {
  let n = 0;
  for (const r of rels) {
    const full = path.join(dir, r);
    const size = fs.statSync(full).size;
    if (size > MAX_FILE) { console.log(`  · omitido (muy grande): ${r}`); continue; }
    await store.writeFile(r, fs.readFileSync(full), contentType(r));
    n++;
  }
  console.log(`  ✓ ${label}: ${n} archivo(s)`);
}

(async () => {
  const s3 = S3.fromEnv(process.env.NOIR_BUCKET || 'noir');
  const cloud = createCloud({ log: console.log });
  const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'db.json'), 'utf8'));
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { /* sin ajustes */ }

  const state = {};
  await cloud.init(state, { users: [], shares: [], trash: [], activity: [], invites: [], projects: [] });
  if (state.users.length && !process.argv.includes('--forzar')) {
    console.log(`La nube ya tiene ${state.users.length} usuario(s). Usa --forzar para reemplazar su estado.`);
    process.exit(1);
  }

  // Proyectos: los de carpetas de este PC pasan a ser proyectos subidos (en la nube).
  const projects = [];
  for (const p of local.projects || []) {
    const dir = p.kind === 'upload' ? path.join(ROOT, 'projects', p.id) : p.path;
    if (!fs.existsSync(dir)) { console.log(`  · proyecto sin carpeta, omitido: ${p.name}`); continue; }
    const exclude = new Set([...(p.exclude || []), 'node_modules']);
    const skip = (r) => {
      const parts = r.split('/');
      return parts.some((s) => HIDDEN_DIRS.has(s)) || SECRET_RE.test(parts[parts.length - 1]) || [...exclude].some((e) => r === e || r.startsWith(`${e}/`));
    };
    const store = new S3Store(s3, { prefix: `p/${p.id}/`, kind: 'project', key: `project:${p.id}` });
    await store.remove('');
    // Repositorio git: solo los archivos del repositorio (sin compilados ni datos locales).
    let list = null;
    if (fs.existsSync(path.join(dir, '.git'))) {
      try { list = require('child_process').execFileSync('git', ['-C', dir, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean).filter((r) => !skip(r) && fs.existsSync(path.join(dir, r))); } catch { list = null; }
    }
    await upload(store, dir, list || filesIn(dir, skip), `proyecto «${p.name}»`);
    projects.push({ id: p.id, name: p.name, kind: 'upload', exclude: [], createdAt: p.createdAt, updatedAt: Date.now(), createdBy: p.createdBy === 'sistema' ? (local.users.find((u) => u.role === 'admin')?.username || 'sistema') : p.createdBy });
  }

  // Archivos y bases de datos.
  const files = new S3Store(s3, { prefix: 'f/', kind: 'cloud', key: 'cloud' });
  const storageDir = path.resolve(ROOT, cfg.storage || './storage');
  if (fs.existsSync(storageDir)) await upload(files, storageDir, filesIn(storageDir), 'archivos');
  const dbDir = path.join(ROOT, 'databases');
  if (fs.existsSync(dbDir)) await upload(new S3Store(s3, { prefix: 'd/', kind: 'db', key: 'db' }), dbDir, fs.readdirSync(dbDir).filter((n) => !n.startsWith('.') && fs.statSync(path.join(dbDir, n)).isFile()), 'bases de datos');

  const config = {};
  for (const k of ['studioName', 'sessionHours', 'trashDays', 'githubRepo', 'allowedOrigins']) if (cfg[k] !== undefined) config[k] = cfg[k];
  const next = {
    users: local.users || [],
    shares: (local.shares || []).filter((s) => fs.existsSync(path.join(storageDir, s.path))),
    trash: [],
    invites: local.invites || [],
    projects,
    secret: local.secret,
    config,
  };
  await cloud.tx(async () => {
    for (const k of Object.keys(state)) if (k !== 'activity') delete state[k];
    Object.assign(state, next);
    cloud.markDirty();
  });
  for (const a of local.activity || []) cloud.activity.add({ t: a.t, user: a.user, action: a.action, detail: a.detail, ip: a.ip });
  cloud.activity.add({ t: Date.now(), user: null, action: 'settings', detail: 'Datos pasados a la nube', ip: '' });
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`  ✓ estado: ${next.users.length} usuario(s), ${next.invites.length} código(s), ${next.shares.length} enlace(s), ${projects.length} proyecto(s)`);
  await cloud.pool.end();
})().catch((err) => { console.error('Error:', err); process.exit(1); });
