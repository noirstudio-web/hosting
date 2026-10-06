'use strict';
/*
 * Explorador de código: proyectos de desarrollo, en solo lectura.
 * - 'upload': carpetas subidas desde el navegador (en la nube o en projects/<id> del servidor).
 * - 'path':   carpetas de este equipo (solo en el servidor local).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { FsStore } = require('./fsstore');

// Nunca se muestran: dependencias, cachés y control de versiones.
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.idea', '.vs', '.gradle', '.parcel-cache', '.turbo']);
// Nunca se muestran: secretos y claves.
const SECRET_RE = /^(\.env(\..+)?|.+\.(pem|key|pfx|p12|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|credentials(\.json)?)$/i;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_WALK = 20000;

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

module.exports = function registerProjects(ctx) {
  const { route, HttpError, sendJson, readJson, activity, saveDb, db } = ctx;

  if (!Array.isArray(db.projects)) {
    // En el servidor instalado (.exe) o en la nube no hay código fuente que mostrar: empieza sin proyectos.
    db.projects = ctx.IS_SEA || ctx.CLOUD ? [] : [{
      id: 'hosting',
      name: 'Noir Studio Hosting',
      path: ctx.ROOT,
      exclude: ['data', 'storage', 'databases', 'bin', '.uploads', 'config.json', 'node_modules'],
      createdAt: Date.now(),
      createdBy: 'sistema',
    }];
    saveDb();
  }

  // Proyectos subidos desde el navegador: en la nube (p/<id>/) o dentro del hosting (projects/<id>).
  const PROJECTS_DIR = path.join(ctx.ROOT, 'projects');
  const dirOf = (p) => (p.kind === 'upload' ? path.join(PROJECTS_DIR, p.id) : p.path);
  const stores = new Map();

  function storeOf(p) {
    if (!stores.has(p.id)) {
      let s;
      if (p.kind === 'upload' && ctx.CLOUD) {
        const { S3Store } = require('./s3store');
        s = new S3Store(ctx.s3, { prefix: `p/${p.id}/`, kind: 'project', key: `project:${p.id}`, contentType: ctx.contentTypeOf });
      } else {
        s = new FsStore({ root: dirOf(p), trashDir: path.join(ctx.DATA_DIR, 'trash'), tmpDir: path.join(ctx.DATA_DIR, 'uploads') });
        s.kind = 'project';
        s.key = `project:${p.id}`;
      }
      stores.set(p.id, s);
    }
    return stores.get(p.id);
  }
  const exists = (p) => (p.kind === 'upload' && ctx.CLOUD) || fs.existsSync(dirOf(p));

  const getProject = (id) => {
    const p = db.projects.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'El proyecto no existe');
    if (p.kind !== 'upload' && ctx.CLOUD) throw new HttpError(404, 'Esta carpeta estaba en un PC: vuelve a subirla arrastrándola');
    if (!exists(p)) throw new HttpError(404, p.kind === 'upload' ? 'Los archivos de este proyecto no están: vuelve a subir la carpeta' : `La carpeta del proyecto ya no existe: ${dirOf(p)}`);
    return { ...p, path: dirOf(p), store: storeOf(p) };
  };

  // Destino de las subidas de un proyecto (lo usa la ruta de subidas del servidor).
  ctx.projectStore = (id) => {
    const p = db.projects.find((x) => x.id === id && x.kind === 'upload');
    if (!p) throw new HttpError(404, 'El proyecto no existe o no admite subidas');
    return storeOf(p);
  };
  // Proyectos subidos: los gestiona quien lo subió (o un administrador).
  const canManage = (p, user) => user.role === 'admin' || (p.kind === 'upload' && p.createdBy === user.username);
  ctx.projectCanUpload = (id, user) => {
    const p = db.projects.find((x) => x.id === id && x.kind === 'upload');
    return Boolean(p && canManage(p, user));
  };
  const ownProject = (id, user) => {
    const p = db.projects.find((x) => x.id === id && x.kind === 'upload');
    if (!p) throw new HttpError(404, 'El proyecto no existe o no admite subidas');
    if (!canManage(p, user)) throw new HttpError(403, `Solo ${p.createdBy} o un administrador pueden cambiar este proyecto`);
    return p;
  };

  // Nunca se guardan dependencias ni archivos de claves, aunque el navegador los envíe.
  ctx.projectRejects = (rel) => {
    const parts = String(rel || '').split('/').filter(Boolean);
    return parts.some((s) => HIDDEN_DIRS.has(s)) || SECRET_RE.test(parts[parts.length - 1] || '');
  };

  function isHidden(project, rel) {
    if (!rel) return false;
    const parts = rel.split('/');
    if (parts.some((s) => HIDDEN_DIRS.has(s))) return true;
    if (SECRET_RE.test(parts[parts.length - 1])) return true;
    return (project.exclude || []).some((e) => rel === e || rel.startsWith(`${e}/`));
  }

  function checkRel(project, rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (clean.includes('\0') || clean.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(400, 'Ruta inválida');
    if (isHidden(project, clean)) throw new HttpError(403, 'Este archivo está protegido y no se puede mostrar');
    return clean;
  }

  // Recorre los archivos visibles: onFile(rel, { size, mtime }) → false para parar.
  async function walk(project, onFile) {
    if (project.kind === 'upload') {
      let count = 0;
      for (const e of await project.store.walk('', MAX_WALK * 2)) {
        if (e.type !== 'file' || isHidden(project, e.rel)) continue;
        if (++count > MAX_WALK) return true;
        if ((await onFile(e.rel, e)) === false) return true;
      }
      return false;
    }
    // Carpeta de este equipo: se poda node_modules, .git… sin recorrerlos.
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
          const st = await fsp.stat(full).catch(() => null);
          if (!st) continue;
          count++;
          if ((await onFile(childRel, { size: st.size, mtime: st.mtimeMs })) === false) { count = MAX_WALK; return; }
        }
      }
    }
    await go(project.path, '');
    return count >= MAX_WALK;
  }

  const readFile = async (project, rel, size) => (size ? readAll(await project.store.openRead(rel, 0, size - 1)) : Buffer.alloc(0));

  function gitInfo(p) {
    const dir = p.path;
    return new Promise((resolve) => {
      if (p.kind === 'upload' || !fs.existsSync(path.join(dir, '.git'))) return resolve(null);
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

  const view = (p, user) => ({
    id: p.id, name: p.name, kind: p.kind || 'path', path: p.kind === 'upload' ? null : p.path,
    exclude: p.exclude || [], createdAt: p.createdAt, updatedAt: p.updatedAt || null, exists: !(ctx.CLOUD && p.kind !== 'upload') && exists(p),
    createdBy: p.createdBy, canManage: user ? canManage(p, user) : false,
  });

  route('GET', '/api/projects', 'editor', async ({ res, user }) => {
    const items = [];
    for (const p of db.projects) {
      let branch = null;
      if (p.kind !== 'upload' && !ctx.CLOUD) {
        try {
          const head = fs.readFileSync(path.join(dirOf(p), '.git', 'HEAD'), 'utf8').trim();
          branch = head.startsWith('ref:') ? head.split('/').pop() : head.slice(0, 7);
        } catch { /* no es git */ }
      }
      items.push({ ...view(p, user), branch });
    }
    sendJson(res, 200, { items });
  });

  route('GET', '/api/projects/:id', 'editor', async ({ res, params, user }) => {
    const p = getProject(params.id);
    const languages = {};
    let files = 0;
    let size = 0;
    let lastModified = 0;
    const truncated = await walk(p, async (rel, st) => {
      files++;
      size += st.size;
      if (st.mtime > lastModified) lastModified = st.mtime;
      const ext = path.extname(rel).slice(1).toLowerCase() || '(sin ext.)';
      languages[ext] = (languages[ext] || 0) + 1;
    });
    sendJson(res, 200, { project: view(p, user), stats: { files, size, lastModified, languages, truncated }, git: await gitInfo(p) });
  });

  route('POST', '/api/projects', 'admin', async ({ req, res, user, ip }) => {
    if (ctx.CLOUD) throw new HttpError(400, 'En la nube no hay carpetas de un PC: arrastra la carpeta del proyecto para subirla');
    const { name, path: dir, exclude } = await readJson(req);
    const n = String(name || '').trim();
    if (!n || n.length > 60) throw new HttpError(400, 'El nombre debe tener entre 1 y 60 caracteres');
    const raw = String(dir || '').trim().replace(/^"|"$/g, '');
    if (!raw || !path.isAbsolute(raw)) throw new HttpError(400, 'Escribe la ruta completa de la carpeta (p. ej. C:\\Users\\tu\\proyectos\\mi-app)');
    const full = path.resolve(raw);
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(404, 'Esa carpeta no existe en este equipo');
    if (full === path.parse(full).root) throw new HttpError(400, 'No se puede añadir un disco completo');
    if (db.projects.some((p) => p.kind !== 'upload' && path.resolve(p.path).toLowerCase() === full.toLowerCase())) throw new HttpError(409, 'Esa carpeta ya está añadida');
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
    sendJson(res, 200, { ok: true, project: view(project, user) });
  });

  route('POST', '/api/projects/upload', 'editor', async ({ req, res, user, ip }) => {
    const { name } = await readJson(req);
    const n = String(name || '').trim();
    if (!n || n.length > 60) throw new HttpError(400, 'El nombre debe tener entre 1 y 60 caracteres');
    const project = { id: crypto.randomBytes(6).toString('hex'), name: n, kind: 'upload', exclude: [], createdAt: Date.now(), createdBy: user.username };
    if (!ctx.CLOUD) await fsp.mkdir(dirOf(project), { recursive: true });
    db.projects.push(project);
    saveDb();
    activity(user, 'project_add', `${n} (subido al hosting)`, ip);
    sendJson(res, 200, { ok: true, project: view(project, user) });
  });

  async function clearFiles(p) {
    if (ctx.CLOUD) return storeOf(p).remove('');
    await fsp.rm(dirOf(p), { recursive: true, force: true });
    await fsp.mkdir(dirOf(p), { recursive: true });
  }

  // Vacía un proyecto subido antes de volver a subir su carpeta (actualización).
  route('POST', '/api/projects/:id/clear', 'editor', async ({ res, params, user }) => {
    await clearFiles(ownProject(params.id, user));
    sendJson(res, 200, { ok: true });
  }, { lock: false });

  route('POST', '/api/projects/:id/uploaded', 'editor', async ({ req, res, params, user, ip }) => {
    const p = ownProject(params.id, user);
    const { files, skipped } = await readJson(req);
    p.updatedAt = Date.now();
    saveDb();
    activity(user, 'project_upload', `${p.name}: ${Number(files) || 0} archivos${skipped ? ` (${skipped} omitidos)` : ''}`, ip);
    sendJson(res, 200, { ok: true, project: view(p, user) });
  });

  route('DELETE', '/api/projects/:id', 'editor', async ({ res, params, user, ip }) => {
    const p = db.projects.find((x) => x.id === params.id);
    if (!p) throw new HttpError(404, 'El proyecto no existe');
    if (!canManage(p, user)) throw new HttpError(403, p.kind === 'upload' ? `Solo ${p.createdBy} o un administrador pueden eliminar este proyecto` : 'Solo un administrador puede quitar este proyecto');
    db.projects = db.projects.filter((x) => x !== p);
    if (p.kind === 'upload') {
      if (ctx.CLOUD) await storeOf(p).remove('');
      else await fsp.rm(dirOf(p), { recursive: true, force: true });
      stores.delete(p.id);
    }
    saveDb();
    activity(user, 'project_remove', p.name, ip);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/projects/:id/tree', 'editor', async ({ res, url, params }) => {
    const p = getProject(params.id);
    const rel = checkRel(p, url.searchParams.get('path'));
    let entries;
    try { entries = await p.store.list(rel); } catch { throw new HttpError(404, 'La carpeta no existe'); }
    const items = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isHidden(p, childRel)) continue;
      items.push({ name: e.name, path: childRel, type: e.type, size: e.type === 'file' ? e.size : null });
    }
    items.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' })));
    sendJson(res, 200, { path: rel, items });
  });

  route('GET', '/api/projects/:id/file', 'editor', async ({ res, url, params }) => {
    const p = getProject(params.id);
    const rel = checkRel(p, url.searchParams.get('path'));
    const st = rel ? await p.store.stat(rel) : null;
    if (st?.type !== 'file') throw new HttpError(404, 'El archivo no existe');
    const base = { path: rel, name: path.basename(rel), size: st.size, mtime: st.mtime };
    if (st.size > MAX_TEXT) return sendJson(res, 200, { ...base, tooLarge: true });
    const buf = await readFile(p, rel, st.size);
    if (buf.subarray(0, 8000).includes(0)) return sendJson(res, 200, { ...base, binary: true });
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    sendJson(res, 200, { ...base, text, lines: text.split('\n').length });
  });

  route('GET', '/api/projects/:id/raw', 'editor', async ({ req, res, url, params }) => {
    const p = getProject(params.id);
    const rel = checkRel(p, url.searchParams.get('path'));
    await ctx.serveStoreFile(req, res, rel, { download: url.searchParams.get('dl') === '1', store: p.store });
  });

  route('GET', '/api/projects/:id/search', 'editor', async ({ res, url, params }) => {
    const p = getProject(params.id);
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 2) throw new HttpError(400, 'Escribe al menos 2 caracteres');
    const inContent = url.searchParams.get('content') === '1';
    const needle = q.toLowerCase();
    const results = [];
    await walk(p, async (rel, st) => {
      if (results.length >= 200) return false;
      if (!inContent) {
        if (rel.toLowerCase().includes(needle)) results.push({ path: rel });
        return;
      }
      if (st.size > 1024 * 1024) return;
      const buf = await readFile(p, rel, st.size).catch(() => null);
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
    await walk(p, async (rel, st) => {
      total += st.size;
      entries.push({ rel: `${p.name}/${rel}`, isDir: false, size: st.size, mtime: new Date(st.mtime), open: () => p.store.openRead(rel, 0, Math.max(0, st.size - 1)) });
    });
    if (total > 3.9 * 1024 ** 3 || entries.length > 65000) throw new HttpError(413, 'El proyecto es demasiado grande para un ZIP (máx. 4 GB)');
    activity(user, 'project_zip', p.name, ip);
    await ctx.streamZip(res, entries, `${p.name}.zip`);
  });
};
