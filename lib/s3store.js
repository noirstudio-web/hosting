'use strict';
/*
 * Almacenamiento en la nube (Neon Object Storage, compatible con S3).
 * Misma interfaz que FsStore (lib/fsstore.js): el resto del servidor no nota la diferencia.
 *
 * Distribución de claves dentro del bucket:
 *   <prefijo><ruta>        archivos      (p. ej. f/Beats/tema.wav)
 *   <prefijo><ruta>/       carpeta vacía (marcador de 0 bytes)
 *   t/<id>/<nombre>[...]   papelera
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { StoreError } = require('./fsstore');

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

const TRASH_ID = /^[a-f0-9]{16}$/;
const PARALLEL = 8;

// El almacenamiento de Neon falla al copiar claves con «+»: se guardan escapados (y también «%»).
const escKey = (s) => s.replace(/[%+]/g, (c) => (c === '%' ? '%25' : '%2B'));
const unescKey = (s) => s.replace(/%(25|2B)/g, (m, c) => (c === '25' ? '%' : '+'));

async function inParallel(items, fn, n = PARALLEL) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

function cleanRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (r.includes('\0') || r.split('/').some((s) => s === '..' || s === '.')) throw new StoreError(400, 'Ruta inválida');
  return r;
}

class S3Store {
  // s3: cliente de lib/s3.js · prefix: p. ej. 'f/' · trashPrefix: 't/'
  constructor(s3, { prefix, trashPrefix = 't/', kind = 'cloud', key = 'cloud', quota = null, contentType }) {
    this.s3 = s3;
    this.prefix = prefix;
    this.trashPrefix = trashPrefix;
    this.kind = kind;
    this.key = key;
    this.quota = quota;
    this.contentType = contentType || (() => 'application/octet-stream');
  }

  keyOf(rel) { return this.prefix + escKey(cleanRel(rel)); }
  dirKey(rel) { const r = cleanRel(rel); return r ? `${this.prefix}${escKey(r)}/` : this.prefix; }
  relOf(key) { return unescKey(key.slice(this.prefix.length)).replace(/\/$/, ''); }

  async stat(rel) {
    const r = cleanRel(rel);
    if (!r) return { type: 'dir', size: null, mtime: Date.now() };
    const h = await this.s3.head(this.keyOf(r));
    if (h) return { type: 'file', size: h.size, mtime: h.mtime };
    const { objects, prefixes } = await this.s3.list(this.dirKey(r), { limit: 1 });
    if (!objects.length && !prefixes.length) return null;
    const marker = objects.find((o) => o.key === this.dirKey(r));
    return { type: 'dir', size: null, mtime: marker ? marker.mtime : objects[0].mtime };
  }

  async list(rel) {
    const dk = this.dirKey(rel);
    const { objects, prefixes } = await this.s3.list(dk, { delimiter: '/' });
    if (cleanRel(rel) && !objects.length && !prefixes.length) throw new StoreError(404, 'La carpeta no existe');
    const items = [];
    for (const p of prefixes) items.push({ name: unescKey(p.slice(dk.length, -1)), type: 'dir', size: null, mtime: null });
    for (const o of objects) {
      if (o.key === dk) continue;
      items.push({ name: unescKey(o.key.slice(dk.length)), type: 'file', size: o.size, mtime: o.mtime });
    }
    return items; // las carpetas no tienen fecha propia en la nube (se muestra «—»)
  }

  async folders(rel) {
    const dk = this.dirKey(rel);
    const { prefixes } = await this.s3.list(dk, { delimiter: '/' });
    return prefixes.map((p) => unescKey(p.slice(dk.length, -1))).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  }

  async mkdir(rel) {
    const r = cleanRel(rel);
    if (!r) return;
    if (await this.s3.head(this.keyOf(r))) throw new StoreError(409, 'Ya existe un archivo con ese nombre');
    await this.s3.put(this.dirKey(r), Buffer.alloc(0));
  }

  async unique(dirRel, name, taken = new Set()) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let candidate = name;
    const dir = cleanRel(dirRel);
    for (let i = 1; taken.has(candidate) || (await this.stat(dir ? `${dir}/${candidate}` : candidate)); i++) candidate = `${base} (${i})${ext}`;
    return candidate;
  }

  // Todas las claves de un archivo o carpeta.
  async keysOf(rel) {
    const r = cleanRel(rel);
    const fileKey = this.keyOf(r);
    const own = r ? await this.s3.head(fileKey) : null;
    if (own) return { isDir: false, keys: [{ key: fileKey, size: own.size }] };
    const { objects } = await this.s3.list(this.dirKey(r));
    return { isDir: true, keys: objects.map((o) => ({ key: o.key, size: o.size })) };
  }

  async copyKeys(list, fromBase, toBase) {
    await inParallel(list, async ({ key }) => {
      await this.s3.copy(key, toBase + key.slice(fromBase.length));
    });
  }

  async moveTree(fromRel, toKeyFile, toKeyDir) {
    const { isDir, keys } = await this.keysOf(fromRel);
    if (!keys.length) throw new StoreError(404, 'El elemento no existe');
    if (isDir) await this.copyKeys(keys, this.dirKey(fromRel), toKeyDir);
    else await this.s3.copy(keys[0].key, toKeyFile);
    await this.s3.delMany(keys.map((k) => k.key));
    return { isDir, size: keys.reduce((s, k) => s + k.size, 0) };
  }

  async rename(fromRel, toRel) {
    if (cleanRel(fromRel) === cleanRel(toRel)) return;
    await this.moveTree(fromRel, this.keyOf(toRel), this.dirKey(toRel));
  }

  async copy(fromRel, toRel) {
    const { isDir, keys } = await this.keysOf(fromRel);
    if (!keys.length) throw new StoreError(404, 'El elemento no existe');
    if (isDir) {
      await this.copyKeys(keys, this.dirKey(fromRel), this.dirKey(toRel));
      if (!keys.some((k) => k.key === this.dirKey(fromRel))) await this.s3.put(this.dirKey(toRel), Buffer.alloc(0));
    } else await this.s3.copy(keys[0].key, this.keyOf(toRel));
  }

  async remove(rel) {
    if (!cleanRel(rel) && this.kind === 'cloud') throw new StoreError(400, 'No se puede eliminar la raíz');
    const { keys } = await this.keysOf(rel);
    await this.s3.delMany(keys.map((k) => k.key));
  }

  async walk(rel, limit = 200000) {
    const base = this.dirKey(rel);
    const { objects } = await this.s3.list(base, { limit });
    const dirs = new Map();
    const out = [];
    const addDir = (r, mtime) => {
      if (!r || r === cleanRel(rel)) return;
      const d = dirs.get(r);
      if (d) { if (mtime && (!d.mtime || mtime > d.mtime)) d.mtime = mtime; return; }
      const entry = { rel: r, name: r.split('/').pop(), type: 'dir', size: 0, mtime: mtime || 0 };
      dirs.set(r, entry);
      out.push(entry);
    };
    for (const o of objects.slice(0, limit)) {
      const r = this.relOf(o.key);
      const parts = r.split('/');
      for (let i = 1; i < parts.length; i++) addDir(parts.slice(0, i).join('/'), 0);
      if (o.key.endsWith('/')) { addDir(r, o.mtime); continue; }
      out.push({ rel: r, name: parts[parts.length - 1], type: 'file', size: o.size, mtime: o.mtime });
    }
    return out;
  }

  async search(q, limit = 300) {
    const needle = String(q || '').toLowerCase();
    const results = [];
    let truncated = false;
    for (const e of await this.walk('')) {
      if (!e.name.toLowerCase().includes(needle)) continue;
      if (results.length >= limit) { truncated = true; break; }
      results.push({ name: e.name, path: e.rel, parent: e.rel.split('/').slice(0, -1).join('/'), type: e.type, size: e.type === 'file' ? e.size : null, mtime: e.mtime });
    }
    return { results, truncated };
  }

  // Uso del almacenamiento: se calcula una sola vez aunque lo pidan muchos a la vez, y se guarda 30 s.
  async usage() {
    if (this.usageCache && Date.now() - this.usageCache.at < 30000) return this.usageCache.value;
    if (!this.usagePending) {
      this.usagePending = this.computeUsage()
        .then((value) => { this.usageCache = { at: Date.now(), value }; return value; })
        .finally(() => { this.usagePending = null; });
    }
    return this.usagePending;
  }

  invalidate() { this.usageCache = null; }

  async computeUsage() {
    const byKind = {};
    let used = 0;
    let files = 0;
    let folders = 0;
    for (const e of await this.walk('', 500000)) {
      if (e.type === 'dir') { folders++; continue; }
      const kind = KIND_OF[path.extname(e.name).slice(1).toLowerCase()] || 'other';
      byKind[kind] = byKind[kind] || { count: 0, size: 0 };
      byKind[kind].count++;
      byKind[kind].size += e.size;
      used += e.size;
      files++;
    }
    return { used, files, folders, byKind };
  }

  // Espacio del plan de la nube (si se configuró una cuota).
  async disk() {
    if (!this.quota) return null;
    const { used } = await this.usage();
    return { total: this.quota, free: Math.max(0, this.quota - used) };
  }

  async dirSize(rel) {
    return (await this.keysOf(rel)).keys.reduce((s, k) => s + k.size, 0);
  }

  async openRead(rel, start, end) {
    const key = this.keyOf(rel);
    let res;
    try {
      res = await this.s3.get(key, start, end);
    } catch (err) {
      if (err.s3Status === 404) throw new StoreError(404, 'Archivo no encontrado');
      throw err;
    }
    return Readable.fromWeb(res.body);
  }

  async readText(rel, max) {
    return (await this.s3.getBuffer(this.keyOf(rel), 0, max - 1)).toString('utf8');
  }

  async writeFile(rel, data, contentType) {
    await this.s3.put(this.keyOf(rel), data, contentType || this.contentType(rel));
  }

  // Enlace firmado para que el navegador lea el archivo directamente de la nube.
  signedUrl(rel, seconds = 3600) {
    return this.s3.presign('GET', this.keyOf(rel), { expires: seconds });
  }

  // Copia local temporal (p. ej. para abrir una base de datos SQLite).
  async localCopy(rel) {
    const h = await this.s3.head(this.keyOf(rel));
    if (!h) throw new StoreError(404, 'Archivo no encontrado');
    const dir = path.join(os.tmpdir(), 'noir-cache');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${crypto.createHash('sha1').update(`${this.keyOf(rel)}\0${h.etag}\0${h.size}`).digest('hex')}${path.extname(rel)}`);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      const { pipeline } = require('stream/promises');
      await pipeline(await this.openRead(rel), fs.createWriteStream(tmp));
      await fsp.rename(tmp, file);
    }
    return file;
  }

  // ── Papelera
  async trash(rel, id) {
    if (!TRASH_ID.test(String(id))) throw new StoreError(400, 'Identificador no válido');
    const r = cleanRel(rel);
    if (!r) throw new StoreError(400, 'No se puede eliminar la raíz');
    const holder = `${this.trashPrefix}${id}/${escKey(r.split('/').pop())}`;
    try {
      return await this.moveTree(r, holder, `${holder}/`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async restore(id, name, destRel) {
    if (!TRASH_ID.test(String(id))) throw new StoreError(400, 'Identificador no válido');
    const holder = `${this.trashPrefix}${id}/${escKey(path.basename(name))}`;
    const own = await this.s3.head(holder);
    const { objects } = own ? { objects: [] } : await this.s3.list(`${holder}/`);
    if (!own && !objects.length) throw new StoreError(404, 'El elemento ya no está en la papelera');
    const parent = cleanRel(destRel).split('/').slice(0, -1).join('/');
    const finalName = await this.unique(parent, path.basename(destRel));
    const finalRel = parent ? `${parent}/${finalName}` : finalName;
    if (own) {
      await this.s3.copy(holder, this.keyOf(finalRel));
      await this.s3.del(holder);
    } else {
      await this.copyKeys(objects, `${holder}/`, this.dirKey(finalRel));
      await this.s3.delMany(objects.map((o) => o.key));
    }
    return finalRel;
  }

  async purge(id) {
    if (!TRASH_ID.test(String(id))) return;
    const { objects } = await this.s3.list(`${this.trashPrefix}${id}/`);
    await this.s3.delMany(objects.map((o) => o.key));
  }
}

module.exports = { S3Store, escKey, unescKey, inParallel };
