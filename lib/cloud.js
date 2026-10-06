'use strict';
/*
 * Modo nube (Neon): el estado del hosting vive en Postgres y los archivos en Object Storage.
 *
 * - noir_state:    un único documento JSON (usuarios, enlaces, papelera, proyectos, ajustes…) con versión.
 *                  Cada petición que modifica algo se ejecuta en una transacción con bloqueo, así varias
 *                  instancias del servidor en la nube nunca se pisan los cambios.
 * - noir_sessions: sesiones (compartidas entre instancias).
 * - noir_activity: registro de actividad.
 * - noir_uploads:  subidas en curso (directas del navegador a la nube, por partes).
 */
const crypto = require('crypto');

const LOCK_ID = 7342001;
const STATE_SKIP = new Set(['activity']); // va en su propia tabla

const SCHEMA = `
CREATE TABLE IF NOT EXISTS noir_state (id int PRIMARY KEY, version bigint NOT NULL DEFAULT 0, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS noir_sessions (token_hash text PRIMARY KEY, user_id text NOT NULL, exp bigint NOT NULL);
CREATE INDEX IF NOT EXISTS noir_sessions_user ON noir_sessions (user_id);
CREATE TABLE IF NOT EXISTS noir_activity (id bigserial PRIMARY KEY, t bigint NOT NULL, username text, action text NOT NULL, detail text, ip text);
CREATE TABLE IF NOT EXISTS noir_uploads (id text PRIMARY KEY, key text NOT NULL, upload_id text, size bigint NOT NULL, created bigint NOT NULL);
`;

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function createCloud({ log, connectionString = process.env.DATABASE_URL } = {}) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: String(connectionString || '').replace(/sslmode=require/, 'sslmode=verify-full'), max: 5, idleTimeoutMillis: 30000 });
  // Las desconexiones de clientes inactivos no deben tumbar el proceso.
  pool.on('error', (err) => { if (!/ECONNRESET|EPIPE|ETIMEDOUT|terminated/i.test(err.message)) log?.('Postgres:', err.message); });

  let db = null; // objeto de estado compartido con server.js (se conserva la identidad)
  let version = -1;
  let inTx = false;
  let dirty = false;
  let chain = Promise.resolve();

  const snapshot = () => {
    const out = {};
    for (const [k, v] of Object.entries(db)) if (!STATE_SKIP.has(k)) out[k] = v;
    return out;
  };

  function apply(data, v) {
    for (const k of Object.keys(db)) if (!STATE_SKIP.has(k)) delete db[k];
    Object.assign(db, data);
    version = Number(v);
  }

  async function init(target, empty) {
    db = target;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      await client.query(SCHEMA);
      const r = await client.query('SELECT version, data FROM noir_state WHERE id = 1');
      if (r.rows.length) apply({ ...empty, ...r.rows[0].data }, r.rows[0].version);
      else {
        apply({ ...empty, ...snapshot() }, 0);
        await client.query('INSERT INTO noir_state (id, version, data) VALUES (1, 0, $1)', [JSON.stringify(snapshot())]);
      }
      await client.query('DELETE FROM noir_sessions WHERE exp < $1', [Date.now()]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Trae el estado más reciente si otra instancia lo cambió (peticiones de solo lectura).
  async function refresh() {
    if (inTx) return;
    const r = await pool.query('SELECT version FROM noir_state WHERE id = 1');
    if (Number(r.rows[0].version) === version || inTx) return;
    const full = await pool.query('SELECT version, data FROM noir_state WHERE id = 1');
    if (!inTx) apply(full.rows[0].data, full.rows[0].version);
  }

  // Ejecuta fn con el estado bloqueado y al día; guarda al final si hubo cambios.
  // Si fn devuelve, el resultado ya está confirmado en la base de datos.
  function tx(fn) {
    const run = chain.then(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '60s'");
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
        const r = await client.query('SELECT version FROM noir_state WHERE id = 1');
        if (Number(r.rows[0].version) !== version) {
          const full = await client.query('SELECT version, data FROM noir_state WHERE id = 1');
          apply(full.rows[0].data, full.rows[0].version);
        }
        inTx = true;
        dirty = false;
        const result = await fn();
        if (dirty) {
          const u = await client.query('UPDATE noir_state SET data = $1, version = version + 1 WHERE id = 1 RETURNING version', [JSON.stringify(snapshot())]);
          version = Number(u.rows[0].version);
        }
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (dirty) version = -1; // el estado en memoria quedó a medias: se recarga en la próxima petición
        throw err;
      } finally {
        inTx = false;
        dirty = false;
        client.release();
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  // Llamado por saveDb()/writeDbNow() de server.js.
  function markDirty() {
    if (version < 0 && !inTx) return; // aún no se cargó el estado (registro de módulos al arrancar)
    if (inTx) { dirty = true; return; }
    // Cambio fuera de una transacción (raro): se guarda en una transacción propia.
    tx(async () => { dirty = true; }).catch((err) => log?.('No se pudo guardar el estado:', err.message));
  }

  // ── Sesiones
  const sessions = {
    async create(userId, hours) {
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO noir_sessions (token_hash, user_id, exp) VALUES ($1, $2, $3)', [hashToken(token), userId, Date.now() + hours * 3600 * 1000]);
      return token;
    },
    async get(token, hours) {
      const r = await pool.query('SELECT user_id, exp FROM noir_sessions WHERE token_hash = $1', [hashToken(token)]);
      const s = r.rows[0];
      if (!s) return null;
      const exp = Number(s.exp);
      if (exp < Date.now()) { pool.query('DELETE FROM noir_sessions WHERE token_hash = $1', [hashToken(token)]).catch(() => {}); return null; }
      // Sesión deslizante: se renueva cuando ha pasado la mitad del tiempo.
      const span = hours * 3600 * 1000;
      if (exp - Date.now() < span / 2) pool.query('UPDATE noir_sessions SET exp = $2 WHERE token_hash = $1', [hashToken(token), Date.now() + span]).catch(() => {});
      return s.user_id;
    },
    async remove(token) {
      if (token) await pool.query('DELETE FROM noir_sessions WHERE token_hash = $1', [hashToken(token)]);
    },
    async dropUser(userId, exceptToken) {
      await pool.query('DELETE FROM noir_sessions WHERE user_id = $1 AND token_hash <> $2', [userId, exceptToken ? hashToken(exceptToken) : '']);
    },
  };

  // ── Actividad
  const activity = {
    add(e) {
      pool.query('INSERT INTO noir_activity (t, username, action, detail, ip) VALUES ($1, $2, $3, $4, $5)', [e.t, e.user, e.action, String(e.detail || '').slice(0, 500), e.ip || ''])
        .catch((err) => log?.('Actividad no guardada:', err.message));
    },
    async list(limit) {
      const r = await pool.query('SELECT t, username, action, detail, ip FROM noir_activity ORDER BY id DESC LIMIT $1', [limit]);
      return r.rows.map((x) => ({ t: Number(x.t), user: x.username, action: x.action, detail: x.detail, ip: x.ip }));
    },
    async prune(keep) {
      await pool.query('DELETE FROM noir_activity WHERE id < (SELECT COALESCE(MAX(id), 0) - $1 FROM noir_activity)', [keep]);
    },
  };

  // ── Subidas en curso
  const uploads = {
    async get(id) {
      const r = await pool.query('SELECT key, upload_id, size FROM noir_uploads WHERE id = $1', [id]);
      return r.rows[0] ? { key: r.rows[0].key, uploadId: r.rows[0].upload_id, size: Number(r.rows[0].size) } : null;
    },
    async put(id, row) {
      await pool.query('INSERT INTO noir_uploads (id, key, upload_id, size, created) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET key = $2, upload_id = $3, size = $4, created = $5', [id, row.key, row.uploadId, row.size, Date.now()]);
    },
    async remove(id) {
      await pool.query('DELETE FROM noir_uploads WHERE id = $1', [id]);
    },
    async keysLike(prefix) {
      const r = await pool.query("SELECT key FROM noir_uploads WHERE key LIKE $1 || '%'", [prefix.replace(/[\\%_]/g, '\\$&')]);
      return r.rows.map((x) => x.key);
    },
    async stale(olderThan) {
      const r = await pool.query('SELECT id, key, upload_id FROM noir_uploads WHERE created < $1', [olderThan]);
      return r.rows.map((x) => ({ id: x.id, key: x.key, uploadId: x.upload_id }));
    },
  };

  return { pool, init, refresh, tx, markDirty, sessions, activity, uploads, get inTx() { return inTx; } };
}

module.exports = { createCloud };
