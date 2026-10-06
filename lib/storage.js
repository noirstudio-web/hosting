'use strict';
/*
 * Almacenamiento del hosting: disco de este PC (local) o disco de otro PC con la app NoirAlmacenamiento (remoto).
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { FsStore, StoreError, limitBytes } = require('./fsstore');

const ONLINE_MS = 3 * 60 * 1000;
const PAIR_HOURS = 48;
const AGENT_EXE = 'NoirAlmacenamiento.exe';
const TRAILER_MAGIC = Buffer.from('NOIRCFG1');

class RemoteStore {
  constructor(agent, log) {
    this.agent = agent;
    this.log = log;
    this.kind = 'remote';
    this.key = agent.id;
    this.base = null;
    this.baseAt = 0;
  }

  offline() {
    return new StoreError(503, `El PC de almacenamiento «${this.agent.name}» no responde. Comprueba que esté encendido y con la app NoirAlmacenamiento abierta.`);
  }

  // Elige la dirección que responde: primero red local (más rápida), luego el túnel por internet.
  async pickBase(force = false) {
    if (!force && this.base && Date.now() - this.baseAt < 60000) return this.base;
    const urls = [...(this.agent.urls || [])].sort((a, b) => Number(b.startsWith('http://')) - Number(a.startsWith('http://')));
    for (const u of urls) {
      try {
        const r = await fetch(`${u}/ping`, { signal: AbortSignal.timeout(u.startsWith('http://') ? 1500 : 8000) });
        const j = await r.json();
        if (j?.noir === 'agent' && j.id === this.agent.id) {
          this.base = u;
          this.baseAt = Date.now();
          return u;
        }
      } catch { /* siguiente */ }
    }
    this.base = null;
    throw this.offline();
  }

  headers(extra = {}) {
    return { 'x-noir-key': this.agent.secret, ...extra };
  }

  async request(pathname, init = {}, retry = true) {
    const base = await this.pickBase();
    let res;
    try {
      res = await fetch(`${base}${pathname}`, { ...init, headers: this.headers(init.headers) });
    } catch (err) {
      if (retry && !init.body) {
        this.base = null;
        return this.request(pathname, init, false);
      }
      throw this.offline();
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new StoreError(res.status === 401 ? 502 : res.status, data?.error || `Error del PC de almacenamiento (${res.status})`, data?.extra);
    }
    return res;
  }

  async call(op, ...args) {
    const timeout = ['walk', 'usage', 'search', 'dirSize', 'copy', 'trash'].includes(op) ? 300000 : 60000;
    const res = await this.request('/op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(timeout),
    });
    return (await res.json()).result;
  }

  async openRead(rel, start, end) {
    const qs = new URLSearchParams({ path: rel, start: String(start), end: String(end) });
    const res = await this.request(`/read?${qs}`);
    return Readable.fromWeb(res.body);
  }

  async appendPart(id, offset, source, maxBytes, total) {
    const qs = new URLSearchParams({ id, offset: String(offset), max: String(maxBytes), total: String(total) });
    const res = await this.request(`/part?${qs}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: limitBytes(source, maxBytes),
      duplex: 'half',
    }, false);
    return (await res.json()).size;
  }
}

for (const op of ['stat', 'list', 'folders', 'mkdir', 'unique', 'rename', 'copy', 'remove', 'walk', 'search', 'usage', 'disk', 'dirSize', 'partSize', 'resetPart', 'finishPart', 'cancelPart', 'trash', 'restore', 'purge']) {
  RemoteStore.prototype[op] = function remoteOp(...args) { return this.call(op, ...args); };
}

module.exports = function registerStorage(ctx) {
  const { route, HttpError, sendJson, readJson, activity, saveDb, db, log } = ctx;
  if (!Array.isArray(db.agents)) db.agents = [];
  if (!Array.isArray(db.agentPairs)) db.agentPairs = [];

  const cfg = () => ctx.getConfig();

  // ── Nube (Neon Object Storage): un único almacenamiento, sin PCs que vincular.
  if (ctx.CLOUD) {
    const { S3Store } = require('./s3store');
    const GB = 1024 ** 3;
    const cloudStore = new S3Store(ctx.s3, { prefix: 'f/', kind: 'cloud', key: 'cloud', contentType: ctx.contentTypeOf });
    Object.defineProperty(cloudStore, 'quota', { get: () => (Number(cfg().cloudQuotaGB) || 5) * GB });
    ctx.store = () => cloudStore;
    ctx.localStore = cloudStore;
    ctx.storeByKey = (key) => (key === 'cloud' ? cloudStore : null);
    ctx.storeLabel = () => 'Nube (Neon)';
    route('GET', '/api/storage', 'admin', async ({ res }) => {
      sendJson(res, 200, {
        mode: 'cloud',
        current: { kind: 'cloud', name: 'Nube · Neon Object Storage', root: 'Región aws-us-east-1 · siempre disponible, sin PCs encendidos', disk: await cloudStore.disk() },
        local: null, agents: [], agentAvailable: false, migration: null,
      });
    });
    return;
  }

  const local = new FsStore({ root: ctx.STORAGE, trashDir: path.join(ctx.DATA_DIR, 'trash'), tmpDir: path.join(ctx.DATA_DIR, 'uploads') });
  local.kind = 'local';
  local.key = 'local';
  const remotes = new Map();
  let migration = null;

  function remoteFor(agent) {
    let r = remotes.get(agent.id);
    if (!r || r.agent !== agent || r.urlsKey !== (agent.urls || []).join('|')) {
      r = new RemoteStore(agent, log);
      r.urlsKey = (agent.urls || []).join('|');
      remotes.set(agent.id, r);
    }
    return r;
  }

  // Si la carpeta de la app NoirAlmacenamiento está en este mismo PC (servidor instalado), se usa
  // directamente desde el disco: no hace falta que la app esté abierta.
  const sameMachine = new Map();
  function sameMachineStore(agent) {
    if (!ctx.IS_SEA || !agent.root || !fs.existsSync(agent.root)) return null;
    if (!sameMachine.has(agent.id)) {
      const parent = path.dirname(agent.root);
      const s = new FsStore({ root: agent.root, trashDir: path.join(parent, '.papelera'), tmpDir: path.join(parent, '.temp') });
      s.kind = 'local';
      s.key = agent.id; // la papelera de esa app sigue siendo suya
      s.sameMachineOf = agent;
      sameMachine.set(agent.id, s);
    }
    return sameMachine.get(agent.id);
  }

  // Almacenamiento activo. config.storageMode: 'local' | 'agent:<id>'
  ctx.store = () => {
    const mode = cfg().storageMode || 'local';
    if (mode.startsWith('agent:')) {
      const agent = db.agents.find((a) => a.id === mode.slice(6));
      if (agent) return sameMachineStore(agent) || remoteFor(agent);
    }
    return local;
  };
  ctx.localStore = local;
  ctx.storeByKey = (key) => {
    if (key === 'local') return local;
    const agent = db.agents.find((a) => a.id === key);
    return agent ? sameMachineStore(agent) || remoteFor(agent) : null;
  };
  ctx.storeLabel = () => {
    const s = ctx.store();
    return s.kind === 'local' ? `Este equipo (${os.hostname()})` : `${s.agent.name} (otro PC)`;
  };

  const online = (a) => Boolean(a.lastSeen && Date.now() - a.lastSeen < ONLINE_MS);
  const agentView = (a) => ({
    id: a.id, name: a.name, hostname: a.hostname, root: a.root, disk: a.disk, version: a.version,
    pairedAt: a.pairedAt, lastSeen: a.lastSeen, online: online(a), lan: (a.urls || []).some((u) => u.startsWith('http://')),
  });

  // ── Panel (administrador)

  route('GET', '/api/storage', 'admin', async ({ res }) => {
    const current = ctx.store();
    const mode = current.sameMachineOf ? `agent:${current.sameMachineOf.id}` : current.kind === 'local' ? 'local' : `agent:${current.agent.id}`;
    let localDisk = await local.disk();
    sendJson(res, 200, {
      mode,
      current: current.kind === 'local' ? { kind: 'local', name: os.hostname(), root: current.root, disk: current === local ? localDisk : await current.disk() } : { kind: 'remote', ...agentView(current.agent) },
      local: { name: os.hostname(), root: local.root, disk: localDisk },
      agents: db.agents.map(agentView),
      agentAvailable: fs.existsSync(path.join(ctx.BIN_DIR, AGENT_EXE)),
      migration,
    });
  });

  route('POST', '/api/storage/mode', 'admin', async ({ req, res, user, ip }) => {
    const { mode } = await readJson(req);
    if (mode !== 'local') {
      const agent = db.agents.find((a) => `agent:${a.id}` === mode);
      if (!agent) throw new HttpError(404, 'Ese PC de almacenamiento no existe');
      try { await remoteFor(agent).pickBase(true); } catch { throw new HttpError(503, `«${agent.name}» no está conectado ahora. Abre la app en ese PC e inténtalo de nuevo.`); }
    }
    ctx.updateConfig({ storageMode: mode });
    ctx.invalidateUsage();
    activity(user, 'storage_mode', ctx.storeLabel(), ip);
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', '/api/storage/agents/:id', 'admin', ({ res, params, user, ip }) => {
    const agent = db.agents.find((a) => a.id === params.id);
    if (!agent) throw new HttpError(404, 'Ese PC de almacenamiento no existe');
    db.agents = db.agents.filter((a) => a !== agent);
    remotes.delete(agent.id);
    if (cfg().storageMode === `agent:${agent.id}`) ctx.updateConfig({ storageMode: 'local' });
    saveDb();
    activity(user, 'agent_remove', agent.name, ip);
    sendJson(res, 200, { ok: true });
  });

  // Descarga de la app ya vinculada: el .exe lleva al final un código de un solo uso y cómo encontrar este hosting.
  route('GET', '/api/storage/agent-download', 'admin', async ({ res, user, ip }) => {
    const exe = path.join(ctx.BIN_DIR, AGENT_EXE);
    if (!fs.existsSync(exe)) throw new HttpError(404, 'La app aún no está construida. Ejecuta CONSTRUIR APP ALMACENAMIENTO.bat en este PC.');
    const code = crypto.randomBytes(24).toString('base64url');
    db.agentPairs = db.agentPairs.filter((p) => p.expiresAt > Date.now());
    db.agentPairs.push({ code, createdBy: user.username, createdAt: Date.now(), expiresAt: Date.now() + PAIR_HOURS * 3600 * 1000 });
    saveDb();
    const info = {
      pair: code,
      hosting: ctx.publicBase(),
      lan: ctx.lanUrls(),
      repo: cfg().githubRepo || null,
      studio: cfg().studioName,
    };
    const json = Buffer.from(JSON.stringify(info));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length);
    const st = await fsp.stat(exe);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.microsoft.portable-executable',
      'Content-Disposition': 'attachment; filename="NoirAlmacenamiento.exe"',
      'Content-Length': st.size + json.length + 4 + TRAILER_MAGIC.length,
      'Cache-Control': 'no-store',
    });
    activity(user, 'agent_download', 'App de almacenamiento descargada', ip);
    const stream = fs.createReadStream(exe);
    stream.on('error', () => res.destroy());
    stream.on('end', () => res.end(Buffer.concat([json, len, TRAILER_MAGIC])));
    stream.pipe(res, { end: false });
  });

  // Copia los archivos de este PC al almacenamiento activo (sin borrar los originales).
  route('POST', '/api/storage/migrate', 'admin', async ({ res, user, ip }) => {
    const target = ctx.store();
    if (target.kind === 'local') throw new HttpError(400, 'Primero elige un PC de almacenamiento como destino');
    if (migration?.running) throw new HttpError(409, 'Ya hay una copia en curso');
    const entries = await local.walk('');
    const files = entries.filter((e) => e.type === 'file');
    migration = { running: true, target: target.agent.name, total: files.length, done: 0, bytes: files.reduce((s, f) => s + f.size, 0), bytesDone: 0, errors: 0, startedAt: Date.now() };
    activity(user, 'storage_migrate', `${files.length} archivo(s) → ${target.agent.name}`, ip);
    sendJson(res, 200, { ok: true, migration });
    (async () => {
      for (const d of entries.filter((e) => e.type === 'dir')) await target.mkdir(d.rel).catch(() => {});
      for (const f of files) {
        try {
          const exists = await target.stat(f.rel);
          if (!exists) {
            const id = crypto.createHash('sha256').update(`migrate\0${f.rel}\0${f.size}`).digest('hex').slice(0, 40);
            await target.cancelPart(id);
            let offset = 0;
            const CHUNK = 32 * 1024 * 1024;
            while (offset < f.size || (f.size === 0 && offset === 0)) {
              const end = Math.min(offset + CHUNK, f.size) - 1;
              const src = f.size === 0 ? Readable.from([]) : await local.openRead(f.rel, offset, end);
              offset = await target.appendPart(id, offset, src, CHUNK, f.size);
              if (f.size === 0) break;
            }
            const parent = f.rel.split('/').slice(0, -1).join('/');
            await target.finishPart(id, parent, f.name);
          }
          migration.bytesDone += f.size;
        } catch (err) {
          migration.errors++;
          log(`Copia: error con ${f.rel}: ${err.message}`);
        }
        migration.done++;
      }
      migration.running = false;
      migration.finishedAt = Date.now();
      ctx.invalidateUsage();
      log(`Copia al PC de almacenamiento terminada: ${migration.done - migration.errors}/${migration.total} archivos`);
    })();
  });

  // ── App del otro PC (sin sesión: se autentica con el código de vinculación o su clave)

  route('POST', '/api/agent/pair', null, async ({ req, res, ip }) => {
    const body = await readJson(req);
    const pair = db.agentPairs.find((p) => p.code === body.pair && p.expiresAt > Date.now());
    if (!pair) throw new HttpError(403, 'El código de vinculación no es válido o caducó. Descarga la app otra vez desde el panel.');
    db.agentPairs = db.agentPairs.filter((p) => p !== pair);
    const agent = {
      id: crypto.randomBytes(8).toString('hex'),
      secret: crypto.randomBytes(32).toString('base64url'),
      name: String(body.name || 'PC de almacenamiento').slice(0, 60),
      hostname: String(body.hostname || '').slice(0, 60),
      root: String(body.root || '').slice(0, 300),
      disk: body.disk || null,
      version: String(body.version || ''),
      urls: [],
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    };
    db.agents.push(agent);
    // Si el hosting usa este equipo, el PC recién vinculado pasa a ser el almacenamiento.
    const autoSwitch = ctx.store().kind === 'local';
    if (autoSwitch) ctx.updateConfig({ storageMode: `agent:${agent.id}` });
    ctx.writeDbNow();
    ctx.invalidateUsage();
    activity({ username: pair.createdBy }, 'agent_pair', `${agent.name}${autoSwitch ? ' · ahora es el almacenamiento del hosting' : ''}`, ip);
    log(`\x1b[32m✓\x1b[0m PC de almacenamiento vinculado: ${agent.name}${autoSwitch ? ' (activo)' : ''}`);
    sendJson(res, 200, { ok: true, id: agent.id, secret: agent.secret, active: autoSwitch, studio: cfg().studioName });
  });

  route('POST', '/api/agent/announce', null, async ({ req, res }) => {
    const body = await readJson(req);
    const agent = db.agents.find((a) => a.id === body.id);
    const given = Buffer.from(String(body.secret || ''));
    const expected = Buffer.from(agent?.secret || 'x'.repeat(43));
    if (!agent || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(401, 'Este PC ya no está vinculado al hosting');
    const urls = (Array.isArray(body.urls) ? body.urls : []).filter((u) => /^https?:\/\/[\w.:-]+$/i.test(u)).slice(0, 8);
    const wasOnline = online(agent);
    Object.assign(agent, {
      urls, lastSeen: Date.now(),
      disk: body.disk || agent.disk, root: String(body.root || agent.root).slice(0, 300),
      version: String(body.version || agent.version), name: String(body.name || agent.name).slice(0, 60),
    });
    if (!wasOnline) log(`\x1b[32m●\x1b[0m PC de almacenamiento conectado: ${agent.name}`);
    saveDb();
    sendJson(res, 200, { ok: true, active: cfg().storageMode === `agent:${agent.id}`, studio: cfg().studioName });
  });
};

module.exports.RemoteStore = RemoteStore;
module.exports.AGENT_EXE = AGENT_EXE;
