'use strict';
/*
 * Almacenamiento sobre el sistema de archivos.
 * Lo usan el hosting (disco de este PC) y la app NoirAlmacenamiento (disco del otro PC),
 * así ambos se comportan exactamente igual.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');

class StoreError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.expose = true;
    this.extra = extra;
  }
}

const STORE_KIND_EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'raw'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff'],
  document: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'csv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  project: ['psd', 'ai', 'fig', 'sketch', 'xd', 'blend', 'fbx', 'obj', 'c4d', 'aep', 'prproj', 'flp', 'als', 'ptx', 'logicx'],
};
const STORE_KIND_OF = {};
for (const [k, list] of Object.entries(STORE_KIND_EXT)) for (const e of list) STORE_KIND_OF[e] = k;

const PART_ID = /^[a-f0-9]{40}$/;
const TRASH_ID = /^[a-f0-9]{16}$/;

async function* limitBytes(source, max, onChunk) {
  let n = 0;
  for await (const chunk of source) {
    n += chunk.length;
    if (n > max) throw new StoreError(413, 'El fragmento excede el tamaño permitido');
    onChunk?.(chunk.length);
    yield chunk;
  }
}

class FsStore {
  constructor({ root, trashDir, tmpDir }) {
    this.root = path.resolve(root);
    this.trashDir = path.resolve(trashDir);
    this.tmpDir = path.resolve(tmpDir);
    for (const d of [this.root, this.trashDir, this.tmpDir]) fs.mkdirSync(d, { recursive: true });
  }

  full(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.includes('\0')) throw new StoreError(400, 'Ruta inválida');
    const f = path.resolve(this.root, clean);
    if (f !== this.root && !f.startsWith(this.root + path.sep)) throw new StoreError(400, 'Ruta fuera del almacenamiento');
    return f;
  }

  rel(full) {
    return path.relative(this.root, full).split(path.sep).join('/');
  }

  async stat(rel) {
    const f = this.full(rel);
    try {
      const st = await fsp.stat(f);
      return { type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : null, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async list(rel) {
    const dir = this.full(rel);
    let entries;
    try {
      if (!(await fsp.stat(dir)).isDirectory()) throw new Error();
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      throw new StoreError(404, 'La carpeta no existe');
    }
    const items = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isFile()) continue;
      try {
        const st = await fsp.stat(path.join(dir, e.name));
        items.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? st.size : null, mtime: st.mtimeMs });
      } catch { /* inaccesible */ }
    }
    return items;
  }

  async folders(rel) {
    const items = await this.list(rel);
    return items.filter((i) => i.type === 'dir').map((i) => i.name).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  }

  async mkdir(rel) {
    await fsp.mkdir(this.full(rel), { recursive: true });
  }

  async unique(dirRel, name) {
    const dir = this.full(dirRel);
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base} (${i})${ext}`;
    return candidate;
  }

  async move(from, to) {
    try {
      await fsp.rename(from, to);
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EBUSY') throw new StoreError(409, `“${path.basename(from)}” está en uso por otro programa`);
      if (err.code !== 'EXDEV') throw err;
      await fsp.cp(from, to, { recursive: true });
      await fsp.rm(from, { recursive: true, force: true });
    }
  }

  async rename(fromRel, toRel) {
    await this.move(this.full(fromRel), this.full(toRel));
  }

  async copy(fromRel, toRel) {
    await fsp.cp(this.full(fromRel), this.full(toRel), { recursive: true, errorOnExist: true });
  }

  async remove(rel) {
    const f = this.full(rel);
    if (f === this.root) throw new StoreError(400, 'No se puede eliminar la raíz');
    await fsp.rm(f, { recursive: true, force: true });
  }

  // Recorre un subárbol (incluye carpetas). Se usa para ZIP y estadísticas.
  async walk(rel, limit = 200000) {
    const out = [];
    const go = async (dir, depth) => {
      if (depth > 32 || out.length >= limit) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (!e.isDirectory() && !e.isFile()) continue;
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        out.push({ rel: this.rel(full), name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? st.size : 0, mtime: st.mtimeMs });
        if (e.isDirectory()) await go(full, depth + 1);
      }
    };
    await go(this.full(rel), 0);
    return out;
  }

  async search(q, limit = 300) {
    const needle = String(q || '').toLowerCase();
    const results = [];
    let truncated = false;
    const go = async (dir, depth) => {
      if (depth > 32 || truncated) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (truncated) return;
        if (!e.isDirectory() && !e.isFile()) continue;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(needle)) {
          if (results.length >= limit) { truncated = true; return; }
          const st = await fsp.stat(full).catch(() => null);
          if (st) {
            const rel = this.rel(full);
            results.push({ name: e.name, path: rel, parent: rel.split('/').slice(0, -1).join('/'), type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? st.size : null, mtime: st.mtimeMs });
          }
        }
        if (e.isDirectory()) await go(full, depth + 1);
      }
    };
    await go(this.root, 0);
    return { results, truncated };
  }

  async usage() {
    const byKind = {};
    let used = 0;
    let files = 0;
    let folders = 0;
    for (const e of await this.walk('', 500000)) {
      if (e.type === 'dir') { folders++; continue; }
      const ext = path.extname(e.name).slice(1).toLowerCase();
      const kind = STORE_KIND_OF[ext] || 'other';
      byKind[kind] = byKind[kind] || { count: 0, size: 0 };
      byKind[kind].count++;
      byKind[kind].size += e.size;
      used += e.size;
      files++;
    }
    return { used, files, folders, byKind };
  }

  async disk() {
    try {
      const s = await fsp.statfs(this.root);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      return null;
    }
  }

  async dirSize(rel) {
    let total = 0;
    for (const e of await this.walk(rel)) total += e.size;
    return total;
  }

  async openRead(rel, start, end) {
    const f = this.full(rel);
    const st = await fsp.stat(f).catch(() => null);
    if (!st?.isFile()) throw new StoreError(404, 'Archivo no encontrado');
    return fs.createReadStream(f, { start, end });
  }

  // ── Subidas por fragmentos
  partPath(id) {
    if (!PART_ID.test(String(id))) throw new StoreError(400, 'Identificador de subida no válido');
    return path.join(this.tmpDir, `${id}.part`);
  }

  async partSize(id) {
    try { return (await fsp.stat(this.partPath(id))).size; } catch { return 0; }
  }

  async resetPart(id, total) {
    const size = await this.partSize(id);
    if (size > total) {
      await fsp.rm(this.partPath(id), { force: true });
      return 0;
    }
    return size;
  }

  async appendPart(id, offset, source, maxBytes, total) {
    const part = this.partPath(id);
    const current = await this.partSize(id);
    if (offset !== current) throw new StoreError(409, 'Desfase de subida', { offset: current });
    let written = 0;
    await pipeline(
      limitBytes(source, Math.min(maxBytes, total - current), (n) => { written += n; }),
      fs.createWriteStream(part, { flags: 'a' }),
    );
    return current + written;
  }

  async finishPart(id, dirRel, name) {
    const part = this.partPath(id);
    await this.mkdir(dirRel);
    if (!fs.existsSync(part)) await fsp.writeFile(part, '');
    const finalName = await this.unique(dirRel, name);
    await this.move(part, path.join(this.full(dirRel), finalName));
    return finalName;
  }

  async cancelPart(id) {
    await fsp.rm(this.partPath(id), { force: true });
  }

  // ── Papelera (fuera de la carpeta de archivos)
  async trash(rel, id) {
    if (!TRASH_ID.test(String(id))) throw new StoreError(400, 'Identificador no válido');
    const f = this.full(rel);
    if (f === this.root) throw new StoreError(400, 'No se puede eliminar la raíz');
    const st = await fsp.stat(f).catch(() => null);
    if (!st) return null;
    const size = st.isDirectory() ? await this.dirSize(rel) : st.size;
    const holder = path.join(this.trashDir, id);
    await fsp.mkdir(holder, { recursive: true });
    try {
      await this.move(f, path.join(holder, path.basename(f)));
    } catch (err) {
      await fsp.rm(holder, { recursive: true, force: true });
      throw err;
    }
    return { size, isDir: st.isDirectory() };
  }

  async restore(id, name, destRel) {
    if (!TRASH_ID.test(String(id))) throw new StoreError(400, 'Identificador no válido');
    const src = path.join(this.trashDir, id, path.basename(name));
    if (!fs.existsSync(src)) throw new StoreError(404, 'El elemento ya no está en la papelera');
    const parentRel = destRel.split('/').slice(0, -1).join('/');
    await this.mkdir(parentRel);
    const finalName = await this.unique(parentRel, path.basename(destRel));
    const finalRel = parentRel ? `${parentRel}/${finalName}` : finalName;
    await this.move(src, this.full(finalRel));
    await fsp.rm(path.join(this.trashDir, id), { recursive: true, force: true });
    return finalRel;
  }

  async purge(id) {
    if (!TRASH_ID.test(String(id))) return;
    await fsp.rm(path.join(this.trashDir, id), { recursive: true, force: true });
  }
}

// Operaciones que se pueden pedir a distancia (app del otro PC). Las de flujo (lectura/escritura) van aparte.
const STORE_OPS = ['stat', 'list', 'folders', 'mkdir', 'unique', 'rename', 'copy', 'remove', 'walk', 'search', 'usage', 'disk', 'dirSize', 'partSize', 'resetPart', 'finishPart', 'cancelPart', 'trash', 'restore', 'purge'];

if (typeof module !== 'undefined') module.exports = { FsStore, StoreError, STORE_OPS, limitBytes };
