'use strict';
/* Noir Studio · Página pública de un enlace compartido */

const $ = (id) => document.getElementById(id);
// En el servidor: /s/<token>. En GitHub Pages: s.html#<token> y la dirección del servidor la fija connect.js.
const token = location.hash.length > 1 ? location.hash.slice(1) : location.pathname.split('/').filter(Boolean)[1] || '';
const apiRoot = () => String(window.NOIR_API || '').replace(/\/+$/, '');
let base = `/api/public/share/${encodeURIComponent(token)}`;
let key = '';

const IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'];
const VIDEO = ['mp4', 'm4v', 'webm', 'mov'];
const AUDIO = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];

function fmtSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('es', { maximumFractionDigits: i ? 1 : 0 })} ${u[i]}`;
}

function untilText(ms) {
  const hours = (ms - Date.now()) / 3600000;
  if (hours < 1) return 'menos de 1 hora';
  if (hours < 48) return `${Math.round(hours)} horas`;
  return `${Math.round(hours / 24)} días`;
}

const fileUrl = (dl) => `${base}/file?${new URLSearchParams({ ...(key && { key }), ...(dl && { dl: '1' }) })}`;

function showError(msg) {
  $('loading').hidden = true;
  $('content').hidden = true;
  $('error').hidden = false;
  $('errorText').textContent = msg;
}

function unlocked(info) {
  $('unlockForm').hidden = true;
  $('downloadBtn').hidden = false;
  $('downloadBtn').href = fileUrl(true);
  if (info.isDir) {
    $('downloadBtn').lastChild.textContent = 'Descargar carpeta (ZIP)';
    return;
  }
  const ext = info.name.split('.').pop().toLowerCase();
  const box = $('preview');
  let el = null;
  if (IMAGE.includes(ext)) { el = document.createElement('img'); el.alt = info.name; }
  else if (VIDEO.includes(ext)) { el = document.createElement('video'); el.controls = true; el.playsInline = true; }
  else if (AUDIO.includes(ext)) { el = document.createElement('audio'); el.controls = true; }
  if (el) {
    el.src = fileUrl(false);
    box.replaceChildren(el);
    box.hidden = false;
  }
}

async function load() {
  let info;
  try {
    const res = await fetch(base, { cache: 'no-store' });
    info = await res.json();
    if (!res.ok) return showError(info.error || 'Este enlace no existe o ha caducado.');
  } catch {
    return showError('No se pudo conectar con el servidor. Puede que esté apagado.');
  }
  $('loading').hidden = true;
  $('content').hidden = false;
  $('studio').textContent = info.studio;
  document.title = `${info.name} · ${info.studio}`;
  $('from').textContent = `${info.sharedBy} te ha compartido`;
  $('fileName').textContent = info.name;
  $('fileInfo').textContent = `${info.isDir ? 'Carpeta · ' : ''}${fmtSize(info.size)}`;
  if (info.isDir) $('fileIcon').firstElementChild.firstElementChild.setAttribute('href', '#i-folder');
  $('fileIcon').classList.add(info.isDir ? 'dir' : 'file');
  const notes = [];
  if (info.expiresAt) notes.push(`Disponible durante ${untilText(info.expiresAt)}`);
  if (info.remaining != null) notes.push(`${info.remaining} ${info.remaining === 1 ? 'descarga restante' : 'descargas restantes'}`);
  $('note').textContent = notes.join(' · ');

  if (info.needsPassword) {
    $('unlockForm').hidden = false;
    $('sharePass').focus();
    $('unlockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('unlockError').textContent = '';
      try {
        const res = await fetch(`${base}/unlock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'noir' },
          body: JSON.stringify({ password: $('sharePass').value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Contraseña incorrecta');
        key = data.key;
        unlocked(info);
      } catch (err) {
        $('unlockError').textContent = err.message;
      }
    });
  } else {
    unlocked(info);
  }
}

(async () => {
  if (window.NOIR_READY) await window.NOIR_READY;
  base = `${apiRoot()}/api/public/share/${encodeURIComponent(token)}`;
  load();
})();
