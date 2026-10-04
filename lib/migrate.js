'use strict';
/*
 * Paquete de mudanza: un ZIP con todo lo necesario para llevar el hosting a otro PC
 * (ajustes, usuarios, enlaces, archivos, bases de datos y la clave del enlace fijo).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

module.exports = function registerMigrate(ctx) {
  const { route, HttpError, activity, log } = ctx;

  async function collect(dir, prefix, out, skip = () => false) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = `${prefix}/${e.name}`;
      if (skip(rel)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      if (e.isDirectory()) {
        out.push({ rel, isDir: true, size: 0, mtime: st.mtime });
        await collect(full, rel, out, skip);
      } else if (e.isFile()) {
        out.push({ rel, abs: full, isDir: false, size: st.size, mtime: st.mtime });
      }
    }
  }

  route('GET', '/api/migrate/package', 'admin', async ({ res, user, ip }) => {
    ctx.writeDbNow();
    const entries = [];
    const st = await fsp.stat(ctx.CONFIG_PATH).catch(() => null);
    if (st) entries.push({ rel: 'config.json', abs: ctx.CONFIG_PATH, isDir: false, size: st.size, mtime: st.mtime });
    await collect(ctx.DATA_DIR, 'data', entries, (rel) => rel === 'data/uploads' || rel.startsWith('data/uploads/') || rel === 'data/codigo-configuracion.txt');
    await collect(ctx.STORAGE, 'storage', entries);
    await collect(ctx.DB_DIR, 'databases', entries);
    await collect(path.join(ctx.ROOT, 'projects'), 'projects', entries);
    const total = entries.reduce((s, e) => s + e.size, 0);
    if (total > 3.9 * 1024 ** 3) throw new HttpError(413, 'Tus datos superan 4 GB: copia la carpeta storage al otro PC a mano y descarga el paquete sin archivos.');
    const name = `noir-respaldo-${new Date().toISOString().slice(0, 10)}.zip`;
    activity(user, 'migrate_package', `${entries.filter((e) => !e.isDir).length} archivos`, ip);
    log(`↓ ${user.username} descargó el paquete de mudanza`);
    await ctx.streamZip(res, entries, name);
  });
};
