'use strict';
/*
 * Bases de datos: subida con historial de versiones, explorador de tablas SQLite
 * y consultas de solo lectura. También muestra volcados .sql, CSV y JSON.
 * Los archivos están en databases/ del servidor o, en la nube, en Object Storage (d/ y dv/).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_VERSIONS = 10;
const PREVIEW_BYTES = 512 * 1024;
const MAX_ROWS = 500;

let sqlite;
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = () => {}; // oculta el aviso "experimental" de node:sqlite
  try { sqlite = require('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = emit; }
  return sqlite;
}

const qid = (name) => `"${String(name).replace(/"/g, '""')}"`;

function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `[BLOB · ${v.length} bytes]`;
  if (typeof v === 'string' && v.length > 1000) return `${v.slice(0, 1000)}…`;
  return v;
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length > 200) break;
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// ── Archivos de bases de datos en el disco del servidor
function diskFiles(ctx) {
  const DIR = ctx.DB_DIR;
  const VERS = path.join(DIR, '.versions');
  fs.mkdirSync(VERS, { recursive: true });
  const full = (name) => path.join(DIR, name);
  const versionsDir = (name) => path.join(VERS, name);
  return {
    async list() {
      const out = [];
      for (const e of await fsp.readdir(DIR, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        const st = await fsp.stat(full(e.name)).catch(() => null);
        if (st) out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
      }
      return out;
    },
    async stat(name) {
      const st = await fsp.stat(full(name)).catch(() => null);
      return st?.isFile() ? { size: st.size, mtime: st.mtimeMs } : null;
    },
    async head(name, bytes) {
      const fd = await fsp.open(full(name), 'r');
      try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fd.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fd.close();
      }
    },
    async localPath(name) { return full(name); },
    async versions(name) {
      let files = [];
      try { files = await fsp.readdir(versionsDir(name)); } catch { return []; }
      const out = [];
      for (const f of files) {
        const st = await fsp.stat(path.join(versionsDir(name), f)).catch(() => null);
        if (st) out.push({ id: f, savedAt: Number(f.split('__')[0]) || st.mtimeMs, size: st.size });
      }
      return out.sort((a, b) => b.savedAt - a.savedAt);
    },
    async archive(name) {
      if (!fs.existsSync(full(name))) return false;
      await fsp.mkdir(versionsDir(name), { recursive: true });
      await ctx.movePath(full(name), path.join(versionsDir(name), `${Date.now()}__${name}`));
      for (const v of (await this.versions(name)).slice(MAX_VERSIONS)) await fsp.rm(path.join(versionsDir(name), v.id), { force: true });
      return true;
    },
    async hasVersion(name, id) { return fs.existsSync(path.join(versionsDir(name), id)); },
    async restore(name, id) {
      const tmp = `${full(name)}.restoring`;
      await fsp.copyFile(path.join(versionsDir(name), id), tmp);
      await this.archive(name);
      await ctx.movePath(tmp, full(name));
    },
    async remove(name) {
      await fsp.rm(full(name), { force: true });
      await fsp.rm(versionsDir(name), { recursive: true, force: true });
    },
    serve(req, res, name, opts) { return ctx.serveFile(req, res, full(name), opts); },
    serveVersion(req, res, name, id) { return ctx.serveFile(req, res, path.join(versionsDir(name), id), { download: true }); },
  };
}

// ── Archivos de bases de datos en la nube
function cloudFiles(ctx) {
  const { S3Store } = require('./s3store');
  const main = new S3Store(ctx.s3, { prefix: 'd/', kind: 'db', key: 'db', contentType: ctx.contentTypeOf });
  const vers = new S3Store(ctx.s3, { prefix: 'dv/', kind: 'db', key: 'db-versions', contentType: ctx.contentTypeOf });
  ctx.dbStore = main;
  return {
    async list() {
      return (await main.list('')).filter((e) => e.type === 'file' && !e.name.startsWith('.')).map((e) => ({ name: e.name, size: e.size, mtime: e.mtime }));
    },
    async stat(name) {
      const st = await main.stat(name);
      return st?.type === 'file' ? { size: st.size, mtime: st.mtime } : null;
    },
    async head(name, bytes) {
      const st = await main.stat(name);
      return st?.size ? readAll(await main.openRead(name, 0, Math.min(bytes, st.size) - 1)) : Buffer.alloc(0);
    },
    localPath(name) { return main.localCopy(name); },
    async versions(name) {
      let items = [];
      try { items = await vers.list(name); } catch { return []; }
      return items.filter((e) => e.type === 'file').map((e) => ({ id: e.name, savedAt: Number(e.name.split('__')[0]) || e.mtime, size: e.size })).sort((a, b) => b.savedAt - a.savedAt);
    },
    async archive(name) {
      if (!(await this.stat(name))) return false;
      await ctx.s3.copy(main.keyOf(name), vers.keyOf(`${name}/${Date.now()}__${name}`));
      for (const v of (await this.versions(name)).slice(MAX_VERSIONS)) await vers.remove(`${name}/${v.id}`).catch(() => {});
      return true;
    },
    async hasVersion(name, id) { return (await vers.stat(`${name}/${id}`))?.type === 'file'; },
    async restore(name, id) {
      const tmp = `.restaurando-${Date.now()}`;
      await ctx.s3.copy(vers.keyOf(`${name}/${id}`), main.keyOf(tmp));
      await this.archive(name);
      await ctx.s3.copy(main.keyOf(tmp), main.keyOf(name));
      await main.remove(tmp);
    },
    async remove(name) {
      await main.remove(name);
      await vers.remove(name).catch(() => {});
    },
    serve(req, res, name, opts) { return ctx.serveStoreFile(req, res, name, { ...opts, store: main }); },
    serveVersion(req, res, name, id) { return ctx.serveStoreFile(req, res, `${name}/${id}`, { download: true, store: vers }); },
  };
}

module.exports = function registerDatabases(ctx) {
  const { route, HttpError, sendJson, readJson, activity } = ctx;
  const files = ctx.CLOUD ? cloudFiles(ctx) : diskFiles(ctx);

  function nameOf(name) {
    const clean = ctx.validName(name);
    if (!clean || clean.startsWith('.')) throw new HttpError(400, 'Nombre no válido');
    return clean;
  }

  async function existing(name) {
    const n = nameOf(name);
    const st = await files.stat(n);
    if (!st) throw new HttpError(404, 'La base de datos no existe');
    return { name: n, st };
  }

  async function detect(name) {
    const head = await files.head(name, 16);
    if (head.toString('latin1', 0, 15) === 'SQLite format 3') return 'sqlite';
    const ext = path.extname(name).slice(1).toLowerCase();
    if (ext === 'sql') return 'sql';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (ext === 'json') return 'json';
    return 'other';
  }

  // Antes de reemplazar una base de datos, la versión anterior pasa al historial.
  ctx.archiveDbVersion = (name) => files.archive(nameOf(name));
  // Servidor local: llamado al terminar una subida por fragmentos.
  ctx.finalizeDbUpload = async (part, name) => {
    const n = nameOf(name);
    const replaced = await files.archive(n);
    await ctx.movePath(part, path.join(ctx.DB_DIR, n));
    return replaced;
  };

  async function openSqlite(name) {
    const lib = loadSqlite();
    if (!lib) throw new HttpError(501, 'Esta versión de Node.js no incluye SQLite. Actualiza Node.js a la versión 22 o superior.');
    const full = await files.localPath(name);
    try {
      return new lib.DatabaseSync(full, { readOnly: true });
    } catch (err) {
      throw new HttpError(400, `No se pudo abrir la base de datos: ${err.message}`);
    }
  }

  async function versionId(name, id) {
    if (!/^\d+__/.test(id) || id.includes('/') || id.includes('\\') || id.includes('..')) throw new HttpError(400, 'Versión no válida');
    if (!(await files.hasVersion(name, id))) throw new HttpError(404, 'La versión no existe');
    return id;
  }

  route('GET', '/api/databases', 'editor', async ({ res }) => {
    const items = [];
    for (const e of await files.list()) {
      items.push({ ...e, type: await detect(e.name).catch(() => 'other'), versions: (await files.versions(e.name)).length });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    sendJson(res, 200, { items, sqlite: Boolean(loadSqlite()) });
  });

  route('GET', '/api/databases/:name/file', 'editor', async ({ req, res, url, params, user, ip }) => {
    const { name } = await existing(params.name);
    if (!req.headers.range) activity(user, 'db_download', name, ip);
    await files.serve(req, res, name, { download: url.searchParams.get('dl') !== '0' });
  });

  route('DELETE', '/api/databases/:name', 'editor', async ({ res, params, user, ip }) => {
    const { name } = await existing(params.name);
    await files.remove(name);
    activity(user, 'db_delete', name, ip);
    sendJson(res, 200, { ok: true });
  }, { lock: false });

  route('GET', '/api/databases/:name/versions', 'editor', async ({ res, params }) => {
    const { name } = await existing(params.name);
    sendJson(res, 200, { items: await files.versions(name) });
  });

  route('GET', '/api/databases/:name/versions/:id', 'editor', async ({ req, res, params }) => {
    const name = nameOf(params.name);
    await files.serveVersion(req, res, name, await versionId(name, params.id));
  });

  route('POST', '/api/databases/:name/versions/:id/restore', 'editor', async ({ res, params, user, ip }) => {
    const name = nameOf(params.name);
    const id = await versionId(name, params.id);
    await files.restore(name, id);
    activity(user, 'db_restore', `${name} → versión del ${new Date(Number(id.split('__')[0])).toLocaleString('es')}`, ip);
    sendJson(res, 200, { ok: true });
  }, { lock: false });

  route('GET', '/api/databases/:name/inspect', 'editor', async ({ res, params }) => {
    const { name, st } = await existing(params.name);
    const type = await detect(name);
    const base = { name, type, size: st.size, mtime: st.mtime };

    if (type === 'sqlite') {
      const dbh = await openSqlite(name);
      try {
        const tables = dbh.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((t) => {
          let rows = null;
          try { rows = Number(dbh.prepare(`SELECT COUNT(*) AS c FROM ${qid(t.name)}`).get().c); } catch { /* vista rota */ }
          const columns = dbh.prepare(`PRAGMA table_info(${qid(t.name)})`).all().map((c) => ({ name: c.name, type: c.type, pk: Boolean(c.pk), notnull: Boolean(c.notnull) }));
          return { name: t.name, kind: t.type, rows, columns };
        });
        return sendJson(res, 200, { ...base, tables });
      } finally {
        dbh.close();
      }
    }

    const head = await files.head(name, PREVIEW_BYTES);
    const text = head.toString('utf8').replace(/^﻿/, '');
    const truncated = st.size > head.length;
    if (type === 'csv') {
      const firstLine = text.split(/\r?\n/, 1)[0];
      const delimiter = path.extname(name).toLowerCase() === '.tsv' ? '\t' : [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
      const rows = parseCsv(text, delimiter);
      return sendJson(res, 200, { ...base, columns: rows[0] || [], rows: rows.slice(1, 201), truncated: truncated || rows.length > 201 });
    }
    if (type === 'sql' || type === 'json') {
      let display = text;
      if (type === 'json' && !truncated) {
        try { display = JSON.stringify(JSON.parse(text), null, 2); } catch { /* se muestra tal cual */ }
      }
      const tables = type === 'sql' ? [...new Set([...text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.-]+)/gi)].map((m) => m[1]))] : undefined;
      return sendJson(res, 200, { ...base, text: display, truncated, tables });
    }
    sendJson(res, 200, base);
  });

  route('GET', '/api/databases/:name/table', 'editor', async ({ res, url, params }) => {
    const { name } = await existing(params.name);
    const t = url.searchParams.get('t');
    const limit = Math.min(MAX_ROWS, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const dbh = await openSqlite(name);
    try {
      const exists = dbh.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(t);
      if (!exists) throw new HttpError(404, 'La tabla no existe');
      const columns = dbh.prepare(`PRAGMA table_info(${qid(t)})`).all().map((c) => c.name);
      const rows = dbh.prepare(`SELECT * FROM ${qid(t)} LIMIT ? OFFSET ?`).all(limit, offset).map((r) => columns.map((c) => cell(r[c])));
      const total = Number(dbh.prepare(`SELECT COUNT(*) AS c FROM ${qid(t)}`).get().c);
      sendJson(res, 200, { table: t, columns, rows, total, offset, limit });
    } finally {
      dbh.close();
    }
  });

  route('POST', '/api/databases/:name/query', 'editor', async ({ req, res, params, user, ip }) => {
    const { name } = await existing(params.name);
    const { sql } = await readJson(req);
    const q = String(sql || '').trim();
    if (!q) throw new HttpError(400, 'Escribe una consulta');
    if (q.length > 20000) throw new HttpError(400, 'La consulta es demasiado larga');
    const dbh = await openSqlite(name);
    const started = process.hrtime.bigint();
    try {
      let stmt;
      try { stmt = dbh.prepare(q); } catch (err) { throw new HttpError(400, err.message); }
      const rows = [];
      let columns = null;
      let more = false;
      try {
        for (const r of stmt.iterate()) {
          if (rows.length >= MAX_ROWS) { more = true; break; }
          columns ||= Object.keys(r);
          rows.push(columns.map((c) => cell(r[c])));
        }
      } catch (err) {
        const msg = /readonly/i.test(err.message) ? 'Solo se permiten consultas de lectura (SELECT). La base de datos se abre en modo protegido.' : err.message;
        throw new HttpError(400, msg);
      }
      if (!columns) {
        try { columns = stmt.columns().map((c) => c.name); } catch { columns = []; }
      }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      activity(user, 'db_query', `${name}: ${q.slice(0, 120)}`, ip);
      sendJson(res, 200, { columns, rows, more, ms: Math.round(ms * 10) / 10 });
    } finally {
      dbh.close();
    }
  }, { lock: false });
};
