'use strict';
/*
 * Actualizaciones del servidor instalado: busca la última versión publicada en GitHub (Releases),
 * la descarga, comprueba que arranca y pide al supervisor que la active.
 */
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');

const ASSET = 'NoirStudioServidor.exe';
const CHECK_MS = 6 * 3600 * 1000;

const parse = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => Number(n) || 0);
function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

module.exports = function registerUpdates(ctx) {
  const { route, HttpError, sendJson, readJson, activity, log } = ctx;
  const supervised = ctx.IS_SEA && typeof process.send === 'function' && Boolean(process.env.NOIR_APP_EXE);
  const state = { latest: null, checkedAt: null, error: null, applying: false, progress: null };
  const cfg = () => ctx.getConfig();
  const repo = () => cfg().githubRepo || 'noirstudio-web/hosting';

  async function check() {
    try {
      const r = await fetch(process.env.NOIR_UPDATE_API || `https://api.github.com/repos/${repo()}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) {
        state.latest = null;
      } else {
        if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
        const rel = await r.json();
        const asset = (rel.assets || []).find((a) => a.name === ASSET);
        state.latest = { version: String(rel.tag_name || '').replace(/^v/, ''), notes: rel.body || '', publishedAt: rel.published_at, url: asset?.browser_download_url || null, size: asset?.size || null };
      }
      state.error = null;
    } catch (err) {
      state.error = `No se pudo consultar GitHub: ${err.message}`;
    }
    state.checkedAt = Date.now();
    return view();
  }

  const view = () => ({
    current: ctx.VERSION,
    supervised,
    latest: state.latest,
    available: Boolean(state.latest?.url && newer(state.latest.version, ctx.VERSION)),
    checkedAt: state.checkedAt,
    error: state.error,
    applying: state.applying,
    progress: state.progress,
    autoUpdate: cfg().autoUpdate !== false,
    repo: repo(),
  });

  async function apply(by) {
    if (!supervised) throw new HttpError(400, 'Las actualizaciones automáticas solo funcionan en el servidor instalado');
    if (state.applying) throw new HttpError(409, 'Ya se está actualizando');
    if (!state.latest?.url || !newer(state.latest.version, ctx.VERSION)) throw new HttpError(400, 'Ya tienes la última versión');
    state.applying = true;
    state.progress = 0;
    const target = `${process.env.NOIR_APP_EXE}.new`;
    try {
      log(`Descargando la versión ${state.latest.version}…`);
      const r = await fetch(state.latest.url);
      if (!r.ok || !r.body) throw new Error(`descarga fallida (${r.status})`);
      const total = Number(r.headers.get('content-length')) || state.latest.size || 0;
      const out = fs.createWriteStream(target);
      let done = 0;
      for await (const chunk of r.body) {
        done += chunk.length;
        if (total) state.progress = Math.round((done / total) * 100);
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      // Comprueba que el nuevo ejecutable arranca y es la versión esperada.
      const v = await new Promise((res) => execFile(target, ['--version'], { timeout: 30000, windowsHide: true }, (e, so) => res(e ? '' : String(so).trim())));
      if (v !== state.latest.version) throw new Error(`el archivo descargado no es válido (${v || 'no arranca'})`);
      activity(by, 'update', `${ctx.VERSION} → ${v}`, '');
      ctx.writeDbNow();
      log(`\x1b[32m✓\x1b[0m Versión ${v} lista. Reiniciando…`);
      process.send({ type: 'apply-update', file: target, version: v });
    } catch (err) {
      state.applying = false;
      state.progress = null;
      state.error = `No se pudo actualizar: ${err.message}`;
      await fsp.rm(target, { force: true }).catch(() => {});
      log(`\x1b[31m●\x1b[0m Actualización fallida: ${err.message}`);
      throw new HttpError(502, `No se pudo actualizar: ${err.message}`);
    }
  }

  route('GET', '/api/update', 'admin', ({ res }) => sendJson(res, 200, view()));
  route('POST', '/api/update/check', 'admin', async ({ res }) => sendJson(res, 200, await check()));
  route('POST', '/api/update/apply', 'admin', async ({ res, user }) => {
    if (!supervised) throw new HttpError(400, 'Las actualizaciones automáticas solo funcionan en el servidor instalado');
    if (!view().available) throw new HttpError(400, 'Ya tienes la última versión');
    state.error = null;
    apply(user).catch(() => {}); // la descarga sigue en segundo plano; el panel consulta el progreso
    sendJson(res, 200, view());
  });
  route('POST', '/api/update/auto', 'admin', async ({ req, res, user, ip }) => {
    const { enabled } = await readJson(req);
    ctx.updateConfig({ autoUpdate: Boolean(enabled) });
    activity(user, 'settings', `Actualizaciones automáticas ${enabled ? 'activadas' : 'desactivadas'}`, ip);
    sendJson(res, 200, view());
  });

  // Comprobación automática en el servidor instalado.
  if (supervised) {
    const auto = async () => {
      await check();
      if (cfg().autoUpdate !== false && view().available) apply({ username: 'actualización automática' }).catch(() => {});
    };
    setTimeout(auto, 2 * 60 * 1000).unref();
    setInterval(auto, CHECK_MS).unref();
  }
};
