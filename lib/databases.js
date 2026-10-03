'use strict';
/*
 * Bases de datos: subida con historial de versiones, explorador de tablas SQLite
 * y consultas de solo lectura. También muestra volcados .sql, CSV y JSON.
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

module.exports = function registerDatabases(ctx) {
  const { route, HttpError, sendJson, readJson, activity } = ctx;
  const DIR = ctx.DB_DIR;
  const VERS = path.join(DIR, '.versions');
  fs.mkdirSync(VERS, { recursive: true });

  function fileOf(name) {
    const clean = ctx.validName(name);
    if (!clean || clean.startsWith('.')) throw new HttpError(400, 'Nombre no válido');
    return path.join(DIR, clean);
  }

  async function existing(name) {
    const full = fileOf(name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, 'La base de datos no existe');
    return { full, st };
  }

  async function readHead(full, bytes) {
    const fd = await fsp.open(full, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fd.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
  }

  async function detect(full) {
    const head = await readHead(full, 16);
    if (head.toString('latin1', 0, 15) === 'SQLite format 3') return 'sqlite';
    const ext = path.extname(full).slice(1).toLowerCase();
    if (ext === 'sql') return 'sql';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (ext === 'json') return 'json';
    return 'other';
  }

  async function versionsOf(name) {
    const d = path.join(VERS, name);
    let files = [];
    try { files = await fsp.readdir(d); } catch { return []; }
    const out = [];
    for (const f of files) {
      const st = await fsp.stat(path.join(d, f)).catch(() => null);
      if (st) out.push({ id: f, savedAt: Number(f.split('__')[0]) || st.mtimeMs, size: st.size });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async function archive(full) {
    const name = path.basename(full);
    const d = path.join(VERS, name);
    await fsp.mkdir(d, { recursive: true });
    await ctx.movePath(full, path.join(d, `${Date.now()}__${name}`));
    for (const v of (await versionsOf(name)).slice(MAX_VERSIONS)) await fsp.rm(path.join(d, v.id), { force: true });
  }

  // Llamado al terminar una subida: si ya existía, la versión anterior pasa al historial.
  ctx.finalizeDbUpload = async (part, name) => {
    const full = fileOf(name);
    const replaced = fs.existsSync(full);
    if (replaced) await archive(full);
    await ctx.movePath(part, full);
    return replaced;
  };

  function openSqlite(full) {
    const lib = loadSqlite();
    if (!lib) throw new HttpError(501, 'Esta versión de Node.js no incluye SQLite. Actualiza Node.js a la versión 22 o superior.');
    try {
      return new lib.DatabaseSync(full, { readOnly: true });
    } catch (err) {
      throw new HttpError(400, `No se pudo abrir la base de datos: ${err.message}`);
    }
  }

  function versionFile(name, id) {
    if (!/^\d+__/.test(id) || id.includes('/') || id.includes('\\') || id.includes('..')) throw new HttpError(400, 'Versión no válida');
    const full = path.join(VERS, path.basename(fileOf(name)), id);
    if (!fs.existsSync(full)) throw new HttpError(404, 'La versión no existe');
    return full;
  }

  route('GET', '/api/databases', 'editor', async ({ res }) => {
    const items = [];
    for (const e of await fsp.readdir(DIR, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const full = path.join(DIR, e.name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      items.push({ name: e.name, size: st.size, mtime: st.mtimeMs, type: await detect(full).catch(() => 'other'), versions: (await versionsOf(e.name)).length });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    sendJson(res, 200, { items, sqlite: Boolean(loadSqlite()) });
  });

  route('GET', '/api/databases/:name/file', 'editor', async ({ req, res, url, params, user, ip }) => {
    const { full } = await existing(params.name);
    if (!req.headers.range) activity(user, 'db_download', params.name, ip);
    await ctx.serveFile(req, res, full, { download: url.searchParams.get('dl') !== '0' });
  });

  route('DELETE', '/api/databases/:name', 'editor', async ({ res, params, user, ip }) => {
    const { full } = await existing(params.name);
    await fsp.rm(full, { force: true });
    await fsp.rm(path.join(VERS, path.basename(full)), { recursive: true, force: true });
    activity(user, 'db_delete', params.name, ip);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/databases/:name/versions', 'editor', async ({ res, params }) => {
    await existing(params.name);
    sendJson(res, 200, { items: await versionsOf(path.basename(fileOf(params.name))) });
  });

  route('GET', '/api/databases/:name/versions/:id', 'editor', async ({ req, res, params }) => {
    await ctx.serveFile(req, res, versionFile(params.name, params.id), { download: true });
  });

  route('POST', '/api/databases/:name/versions/:id/restore', 'editor', async ({ res, params, user, ip }) => {
    const src = versionFile(params.name, params.id);
    const full = fileOf(params.name);
    const tmp = `${full}.restoring`;
    await fsp.copyFile(src, tmp);
    if (fs.existsSync(full)) await archive(full);
    await ctx.movePath(tmp, full);
    activity(user, 'db_restore', `${params.name} → versión del ${new Date(Number(params.id.split('__')[0])).toLocaleString('es')}`, ip);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/databases/:name/inspect', 'editor', async ({ res, params }) => {
    const { full, st } = await existing(params.name);
    const type = await detect(full);
    const base = { name: params.name, type, size: st.size, mtime: st.mtimeMs };

    if (type === 'sqlite') {
      const dbh = openSqlite(full);
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

    const head = await readHead(full, PREVIEW_BYTES);
    const text = head.toString('utf8').replace(/^﻿/, '');
    const truncated = st.size > head.length;
    if (type === 'csv') {
      const firstLine = text.split(/\r?\n/, 1)[0];
      const delimiter = path.extname(full).toLowerCase() === '.tsv' ? '\t' : [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
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
    const { full } = await existing(params.name);
    const t = url.searchParams.get('t');
    const limit = Math.min(MAX_ROWS, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const dbh = openSqlite(full);
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
    const { full } = await existing(params.name);
    const { sql } = await readJson(req);
    const q = String(sql || '').trim();
    if (!q) throw new HttpError(400, 'Escribe una consulta');
    if (q.length > 20000) throw new HttpError(400, 'La consulta es demasiado larga');
    const dbh = openSqlite(full);
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
      activity(user, 'db_query', `${params.name}: ${q.slice(0, 120)}`, ip);
      sendJson(res, 200, { columns, rows, more, ms: Math.round(ms * 10) / 10 });
    } finally {
      dbh.close();
    }
  });
};
