'use strict';
/*
 * Explorador de código: proyectos de desarrollo de este equipo, en solo lectura.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Nunca se muestran: dependencias, cachés y control de versiones.
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.idea', '.vs', '.gradle', '.parcel-cache', '.turbo']);
// Nunca se muestran: secretos y claves.
const SECRET_RE = /^(\.env(\..+)?|.+\.(pem|key|pfx|p12|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|credentials(\.json)?)$/i;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_WALK = 20000;

module.exports = function registerProjects(ctx) {
  const { route, HttpError, sendJson, readJson, activity, saveDb, db } = ctx;

  if (!Array.isArray(db.projects)) {
    // En el servidor instalado (.exe) no hay código fuente que mostrar: empieza sin proyectos.
    db.projects = ctx.IS_SEA ? [] : [{
      id: 'hosting',
      name: 'Noir Studio Hosting',
      path: ctx.ROOT,
      exclude: ['data', 'storage', 'databases', 'bin', '.uploads', 'config.json'],
      createdAt: Date.now(),
      createdBy: 'sistema',
    }];
    saveDb();
  }

  const getProject = (id) => {
    const p = db.projects.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'El proyecto no existe');
    if (!fs.existsSync(p.path)) throw new HttpError(404, `La carpeta del proyecto ya no existe: ${p.path}`);
    return p;
  };

  function isHidden(project, rel) {
    if (!rel) return false;
    const parts = rel.split('/');
    if (parts.some((s) => HIDDEN_DIRS.has(s))) return true;
    if (SECRET_RE.test(parts[parts.length - 1])) return true;
    return (project.exclude || []).some((e) => rel === e || rel.startsWith(`${e}/`));
  }

  function resolve(project, rel) {
    const full = ctx.resolveIn(path.resolve(project.path), rel);
    const clean = path.relative(project.path, full).split(path.sep).join('/');
    if (isHidden(project, clean)) throw new HttpError(403, 'Este archivo está protegido y no se puede mostrar');
    return { full, rel: clean };
  }

  async function walk(project, onFile) {
    let count = 0;
    async function go(dir, rel) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (count >= MAX_WALK) return;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (isHidden(project, childRel)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await go(full, childRel);
        else if (e.isFile()) {
          count++;
          if ((await onFile(full, childRel, e)) === false) { count = MAX_WALK; return; }
        }
      }
    }
    await go(project.path, '');
    return count >= MAX_WALK;
  }

  function gitInfo(dir) {
    return new Promise((resolve) => {
      if (!fs.existsSync(path.join(dir, '.git'))) return resolve(null);
      execFile('git', ['-C', dir, 'log', '-n', '15', '--pretty=format:%h%x1f%an%x1f%at%x1f%s'], { timeout: 5000, windowsHide: true }, (err, out) => {
        let branch = null;
        try {
          const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
          branch = head.startsWith('ref:') ? head.split('/').pop() : head.slice(0, 7);
        } catch { /* sin HEAD */ }
        const commits = err ? [] : out.split('\n').filter(Boolean).map((l) => {
          const [hash, author, at, subject] = l.split('\x1f');
          return { hash, author, at: Number(at) * 1000, subject };
        });
        resolve({ branch, commits });
      });
    });
  }

  const view = (p) => ({ id: p.id, name: p.name, path: p.path, exclude: p.exclude || [], createdAt: p.createdAt, exists: fs.existsSync(p.path) });

  route('GET', '/api/projects', 'editor', async ({ res }) => {
    const items = [];
    for (const p of db.projects) {
      let branch = null;
      try {
        const head = fs.readFileSync(path.join(p.path, '.git', 'HEAD'), 'utf8').trim();
        branch = head.startsWith('ref:') ? head.split('/').pop() : head.slice(0, 7);
      } catch { /* no es git */ }
      items.push({ ...view(p), branch });
    }
    sendJson(res, 200, { items });
  });

  route('GET', '/api/projects/:id', 'editor', async ({ res, params }) => {
    const p = getProject(params.id);
    const languages = {};
    let files = 0;
    let size = 0;
    let lastModified = 0;
    const truncated = await walk(p, async (full, rel) => {
      const st = await fsp.stat(full).catch(() => null);
      if (!st) return;
      files++;
      size += st.size;
      if (st.mtimeMs > lastModified) lastModified = st.mtimeMs;
      const ext = path.extname(rel).slice(1).toLowerCase() || '(sin ext.)';
      languages[ext] = (languages[ext] || 0) + 1;
    });
    sendJson(res, 200, { project: view(p), stats: { files, size, lastModified, languages, truncated }, git: await gitInfo(p.path) });
  });

  route('POST', '/api/projects', 'admin', async ({ req, res, user, ip }) => {
    const { name, path: dir, exclude } = await readJson(req);
    const n = String(name || '').trim();
    if (!n || n.length > 60) throw new HttpError(400, 'El nombre debe tener entre 1 y 60 caracteres');
    const raw = String(dir || '').trim().replace(/^"|"$/g, '');
    if (!raw || !path.isAbsolute(raw)) throw new HttpError(400, 'Escribe la ruta completa de la carpeta (p. ej. C:\\Users\\tu\\proyectos\\mi-app)');
    const full = path.resolve(raw);
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(404, 'Esa carpeta no existe en este equipo');
    if (full === path.parse(full).root) throw new HttpError(400, 'No se puede añadir un disco completo');
    if (db.projects.some((p) => path.resolve(p.path).toLowerCase() === full.toLowerCase())) throw new HttpError(409, 'Esa carpeta ya está añadida');
    const project = {
      id: crypto.randomBytes(6).toString('hex'),
      name: n,
      path: full,
      exclude: (Array.isArray(exclude) ? exclude : String(exclude || '').split(','))
        .map((e) => String(e).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean).slice(0, 50),
      createdAt: Date.now(),
      createdBy: user.username,
    };
    db.projects.push(project);
    saveDb();
    activity(user, 'project_add', `${n} (${full})`, ip);
    sendJson(res, 200, { ok: true, project: view(project) });
  });

  route('DELETE', '/api/projects/:id', 'admin', ({ res, params, user, ip }) => {
    const p = db.projects.find((x) => x.id === params.id);
    if (!p) throw new HttpError(404, 'El proyecto no existe');
    db.projects = db.projects.filter((x) => x !== p);
    saveDb();
    activity(user, 'project_remove', p.name, ip);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/projects/:id/tree', 'editor', async ({ res, url, params }) => {
    const p = getProject(params.id);
    const { full, rel } = resolve(p, url.searchParams.get('path'));
    let entries;
    try { entries = await fsp.readdir(full, { withFileTypes: true }); } catch { throw new HttpError(404, 'La carpeta no existe'); }
    const items = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if ((!e.isDirectory() && !e.isFile()) || isHidden(p, childRel)) continue;
      const st = e.isFile() ? await fsp.stat(path.join(full, e.name)).catch(() => null) : null;
      items.push({ name: e.name, path: childRel, type: e.isDirectory() ? 'dir' : 'file', size: st?.size ?? null });
    }
    items.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' })));
    sendJson(res, 200, { path: rel, items });
  });

  route('GET', '/api/projects/:id/file', 'editor', async ({ res, url, params }) => {
    const p = getProject(params.id);
    const { full, rel } = resolve(p, url.searchParams.get('path'));
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, 'El archivo no existe');
    const base = { path: rel, name: path.basename(full), size: st.size, mtime: st.mtimeMs };
    if (st.size > MAX_TEXT) return sendJson(res, 200, { ...base, tooLarge: true });
    const buf = await fsp.readFile(full);
    if (buf.subarray(0, 8000).includes(0)) return sendJson(res, 200, { ...base, binary: true });
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    sendJson(res, 200, { ...base, text, lines: text.split('\n').length });
  });

  route('GET', '/api/projects/:id/raw', 'editor', async ({ req, res, url, params }) => {
    const p = getProject(params.id);
    const { full } = resolve(p, url.searchParams.get('path'));
    await ctx.serveFile(req, res, full, { download: url.searchParams.get('dl') === '1' });
  });

  route('GET', '/api/projects/:id/search', 'editor', async ({ res, url, params }) => {
    const p = getProject(params.id);
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 2) throw new HttpError(400, 'Escribe al menos 2 caracteres');
    const inContent = url.searchParams.get('content') === '1';
    const needle = q.toLowerCase();
    const results = [];
    await walk(p, async (full, rel) => {
      if (results.length >= 200) return false;
      if (!inContent) {
        if (rel.toLowerCase().includes(needle)) results.push({ path: rel });
        return;
      }
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.size > 1024 * 1024) return;
      const buf = await fsp.readFile(full).catch(() => null);
      if (!buf || buf.subarray(0, 8000).includes(0)) return;
      const lines = buf.toString('utf8').split('\n');
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < 5; i++) {
        if (lines[i].toLowerCase().includes(needle)) matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
      if (matches.length) results.push({ path: rel, matches });
    });
    sendJson(res, 200, { results, truncated: results.length >= 200 });
  });

  route('GET', '/api/projects/:id/zip', 'editor', async ({ res, params, user, ip }) => {
    const p = getProject(params.id);
    const entries = [];
    let total = 0;
    await walk(p, async (full, rel) => {
      const st = await fsp.stat(full).catch(() => null);
      if (!st) return;
      total += st.size;
      entries.push({ abs: full, rel: `${p.name}/${rel}`, isDir: false, size: st.size, mtime: st.mtime });
    });
    if (total > 3.9 * 1024 ** 3 || entries.length > 65000) throw new HttpError(413, 'El proyecto es demasiado grande para un ZIP (máx. 4 GB)');
    activity(user, 'project_zip', p.name, ip);
    await ctx.streamZip(res, entries, `${p.name}.zip`);
  });
};
