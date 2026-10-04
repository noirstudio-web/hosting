'use strict';
/* Noir Studio · Hosting — cliente */

const CHUNK = 32 * 1024 * 1024; // por debajo del límite de 100 MB del túnel
const PARALLEL = 2;
const MAX_RETRIES = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k) { try { return localStorage.getItem(`noir.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`noir.${k}`, v); } catch { /* sin almacenamiento */ } },
};

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };
const ROLE_LABEL = { admin: 'Administrador', editor: 'Editor', viewer: 'Lector' };
const ROLE_DESC = {
  admin: 'Control total: archivos, usuarios, actividad y ajustes.',
  editor: 'Sube, organiza, comparte y elimina archivos.',
  viewer: 'Solo puede ver y descargar.',
};

const state = {
  me: null,
  studio: 'Noir Studio',
  settings: null,
  view: 'files',
  path: '',
  query: '',
  items: [],
  selected: new Set(),
  sort: { key: 'name', dir: 1 },
  filter: '',
  layout: store.get('view') === 'grid' ? 'grid' : 'list',
};

const can = (role) => state.me && ROLE_RANK[state.me.role] >= ROLE_RANK[role];

// ───────────────────────── Tipos de archivo ─────────────────────────

const GROUPS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'csv', 'log', 'srt', 'vtt', 'ini', 'cfg', 'conf'],
  code: ['json', 'xml', 'yml', 'yaml', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  doc: ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pages', 'key', 'numbers'],
  design: ['psd', 'ai', 'fig', 'sketch', 'xd', 'blend', 'fbx', 'obj', 'c4d', 'aep', 'prproj', 'flp', 'als', 'ptx', 'logicx'],
};
const GROUP_OF = {};
for (const [g, list] of Object.entries(GROUPS)) for (const e of list) GROUP_OF[e] = g;
const GROUP_ICON = { dir: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'doc', text: 'doc', code: 'code', archive: 'archive', doc: 'doc', design: 'cube', file: 'file' };
const PLAYABLE_VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov']);
const PLAYABLE_AUDIO = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);

const KIND_INFO = {
  image: { label: 'Imágenes', color: '#9fc3e8' },
  video: { label: 'Video', color: '#c9a2e8' },
  audio: { label: 'Audio', color: '#8fd6c0' },
  document: { label: 'Documentos', color: '#e8a39f' },
  archive: { label: 'Comprimidos', color: '#e3c27a' },
  project: { label: 'Proyectos', color: '#e89fc9' },
  other: { label: 'Otros', color: '#8b8b93' },
};

const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const kindOf = (item) => (item.type === 'dir' ? 'dir' : GROUP_OF[extOf(item.name)] || 'file');

function previewKind(item) {
  if (item.type === 'dir') return null;
  const ext = extOf(item.name);
  const g = GROUP_OF[ext];
  if (g === 'image') return 'image';
  if (g === 'pdf') return 'pdf';
  if (g === 'text' || g === 'code') return 'text';
  if (g === 'video' && PLAYABLE_VIDEO.has(ext)) return 'video';
  if (g === 'audio' && PLAYABLE_AUDIO.has(ext)) return 'audio';
  return null;
}

// ───────────────────────── Utilidades ─────────────────────────

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `ic ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const typeBadge = (item) => {
  const k = kindOf(item);
  return h('span', { class: `ftype ${k}` }, icon(GROUP_ICON[k]));
};

function fmtSize(bytes) {
  if (bytes == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('es', { maximumFractionDigits: i ? 1 : 0 })} ${u[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (ms) => (ms ? dateFmt.format(new Date(ms)) : '—');
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

function timeAgo(ms) {
  if (!ms) return 'Nunca';
  const s = (ms - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 45) return s < 0 ? 'Hace un momento' : 'En un momento';
  for (const [unit, sec] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (abs >= sec) return cap(rtf.format(Math.round(s / sec), unit));
  }
  return cap(rtf.format(Math.round(s), 'second'));
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)} s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.ceil((sec % 3600) / 60)} min`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${hrs} h` : hrs ? `${hrs} h ${m} min` : `${m} min`;
}

const joinPath = (...parts) => parts.flatMap((p) => String(p || '').split('/')).filter(Boolean).join('/');
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
const encPath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const fileUrl = (p, dl) => `/api/file?path=${encodeURIComponent(p)}${dl ? '&dl=1' : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ───────────────────────── API ─────────────────────────

async function api(url, opts = {}) {
  const { allow401, json, ...init } = opts;
  const headers = { 'X-Requested-With': 'noir', ...init.headers };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init, headers });
  } catch {
    throw Object.assign(new Error('No se pudo conectar con el servidor'), { status: 0 });
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
  if (res.status === 401 && !allow401) {
    showAuth();
    throw Object.assign(new Error('Tu sesión ha expirado'), { status: 401, silent: true });
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Error ${res.status}`), { status: res.status, data });
  return data;
}

function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copiado al portapapeles');
}

// ───────────────────────── Avisos, diálogos y menús ─────────────────────────

function toast(message, type = 'ok') {
  const el = h('div', { class: `toast ${type}` }, icon(type === 'error' ? 'alert' : 'check'), h('span', { text: message }));
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, type === 'error' ? 5000 : 2800);
}

function reportError(err) {
  if (!err?.silent) toast(err?.message || 'Ha ocurrido un error', 'error');
}

/**
 * Diálogo modal. onConfirm puede ser async: si lanza un error se muestra en el diálogo;
 * su valor de retorno es el resultado. Devuelve null si se cancela.
 */
function openDialog({ title, message = '', body = null, confirm = 'Aceptar', cancel = 'Cancelar', danger = false, onConfirm = null, wide = false }) {
  const dlg = $('#dialog');
  const form = $('#dialogForm');
  const err = h('p', { class: 'form-error', role: 'alert' });
  $('#dialogTitle').textContent = title;
  $('#dialogMsg').textContent = message;
  $('#dialogBody').replaceChildren(...[body, err].filter(Boolean));
  const ok = h('button', { class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`, type: 'submit', value: 'ok', text: confirm, autofocus: true });
  const actions = [ok];
  if (cancel) actions.push(h('button', { class: 'btn btn-ghost', type: 'submit', value: 'cancel', formnovalidate: true, text: cancel }));
  $('#dialogActions').replaceChildren(...actions);
  dlg.classList.toggle('wide', wide);
  dlg.returnValue = '';

  let result = true;
  return new Promise((resolve) => {
    const onSubmit = async (e) => {
      if (e.submitter?.value === 'cancel') return;
      e.preventDefault();
      if (!onConfirm) return dlg.close('ok');
      ok.disabled = true;
      err.textContent = '';
      try {
        const r = await onConfirm();
        if (r === false) return;
        result = r === undefined ? true : r;
        dlg.close('ok');
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        ok.disabled = false;
      }
    };
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', () => {
      form.removeEventListener('submit', onSubmit);
      resolve(dlg.returnValue === 'ok' ? result : null);
    }, { once: true });
    dlg.showModal();
    const first = $('#dialogBody input:not([type=hidden]):not([readonly]), #dialogBody select', dlg);
    (first || ok).focus();
  });
}

function field(label, input, hint) {
  return h('label', { class: 'dfield' }, h('span', { class: 'dfield-label', text: label }), input, hint && h('small', { class: 'field-hint', text: hint }));
}

function askText({ title, value = '', confirm = 'Aceptar', onConfirm }) {
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', required: true });
  input.value = value;
  queueMicrotask(() => {
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
  return openDialog({ title, body: input, confirm, onConfirm: () => onConfirm(input.value.trim()) });
}

function confirmDanger(title, message, confirm = 'Eliminar') {
  return openDialog({ title, message, confirm, danger: true });
}

let menuCleanup = null;
function showMenu(x, y, entries, flipY = null) {
  closeMenu();
  const menu = $('#menu');
  const items = [];
  for (const e of entries) {
    if (!e) continue;
    if (e === '-') {
      if (items.length && items[items.length - 1].className !== 'menu-sep') items.push(h('div', { class: 'menu-sep' }));
      continue;
    }
    items.push(h('button', {
      class: `menu-item${e.danger ? ' danger' : ''}`, type: 'button', role: 'menuitem',
      onclick: () => { closeMenu(); e.action(); },
    }, icon(e.icon), h('span', { text: e.label }), e.hint && h('kbd', { text: e.hint })));
  }
  while (items.length && items[items.length - 1].className === 'menu-sep') items.pop();
  if (!items.length) return;
  menu.replaceChildren(...items);
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  const top = flipY !== null && y + r.height > innerHeight - 8 ? flipY - r.height - 6 : y;
  menu.style.top = `${Math.max(8, Math.min(top, innerHeight - r.height - 8))}px`;
  menu.querySelector('button')?.focus();
  const onDown = (ev) => { if (!menu.contains(ev.target)) closeMenu(); };
  const onKey = (ev) => {
    if (ev.key === 'Escape') closeMenu();
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const btns = $$('.menu-item', menu);
      const i = btns.indexOf(document.activeElement);
      btns[(i + (ev.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  });
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
  };
}

function closeMenu() {
  $('#menu').hidden = true;
  menuCleanup?.();
  menuCleanup = null;
}

function menuAt(anchor, entries) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, entries, r.top);
}

// ───────────────────────── Sesión ─────────────────────────

function setStudio(name) {
  state.studio = name;
  for (const el of $$('[data-studio]')) el.textContent = name;
  document.title = `${name} · Hosting`;
}

async function showAuth() {
  $('#app').hidden = true;
  $('#preview').hidden = true;
  closeMenu();
  if ($('#dialog').open) $('#dialog').close();
  $('#auth').hidden = false;
  let s = null;
  try { s = await api('/api/session', { allow401: true }); } catch { /* sin conexión */ }
  if (s) setStudio(s.studio);
  $('#setupCodeField').hidden = !s?.setupNeedsCode;
  $('#setupCode').required = Boolean(s?.setupNeedsCode);
  // Enlace de invitación: #/invite/CODIGO
  const invite = (location.hash.match(/^#\/invite\/([A-Za-z0-9-]+)/) || [])[1];
  if (invite) $('#regCode').value = formatCode(invite);
  showAuthForm(s?.setupRequired ? 'setup' : invite ? 'register' : 'login');
}

function showAuthForm(mode) {
  for (const [id, m] of [['#setupForm', 'setup'], ['#loginForm', 'login'], ['#registerForm', 'register']]) {
    $(id).hidden = mode !== m;
    $('.form-error', $(id)).textContent = '';
  }
  const first = {
    setup: $('#setupCodeField').hidden ? '#setupUser' : '#setupCode',
    login: '#loginUser',
    register: $('#regCode').value ? '#regUser' : '#regCode',
  }[mode];
  setTimeout(() => $(first).focus(), 60);
}

function formatCode(v) {
  const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

function enterApp(user) {
  state.me = user;
  if (location.hash.startsWith('#/invite/')) history.replaceState(null, '', '#/f/');
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#accountAvatar').textContent = user.username.charAt(0).toUpperCase();
  $('#accountName').textContent = user.username;
  $('#accountRole').textContent = ROLE_LABEL[user.role];
  for (const el of $$('[data-min]')) el.hidden = !can(el.dataset.min);
  api('/api/settings').then((s) => { state.settings = s; }).catch(() => {});
  loadStats();
  route();
}

function shakeCard() {
  const card = $('.login-card');
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
}

async function submitAuth(form, url, payload) {
  const btn = $('button[type=submit]', form);
  const err = $('.form-error', form);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Verificando…';
  err.textContent = '';
  try {
    const r = await api(url, { method: 'POST', json: payload, allow401: true });
    form.reset();
    enterApp(r.user);
  } catch (ex) {
    err.textContent = ex.message;
    shakeCard();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth(e.target, '/api/login', { username: $('#loginUser').value, password: $('#loginPass').value });
});

$('#setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('.form-error', e.target);
  if ($('#setupPass').value !== $('#setupPass2').value) {
    err.textContent = 'Las contraseñas no coinciden';
    return shakeCard();
  }
  submitAuth(e.target, '/api/setup', { code: $('#setupCode').value, username: $('#setupUser').value, password: $('#setupPass').value });
});

function strengthScore(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return pw ? Math.max(1, s) : 0;
}

function strengthMeter(input) {
  const meter = h('div', { class: 'strength' }, h('span'), h('span'), h('span'), h('span'));
  input.addEventListener('input', () => { meter.dataset.score = strengthScore(input.value); });
  return meter;
}

$('#registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('.form-error', e.target);
  if ($('#regPass').value !== $('#regPass2').value) {
    err.textContent = 'Las contraseñas no coinciden';
    return shakeCard();
  }
  submitAuth(e.target, '/api/register', { code: $('#regCode').value, username: $('#regUser').value, password: $('#regPass').value });
});

$('#setupPass').addEventListener('input', (e) => { $('#setupStrength').dataset.score = strengthScore(e.target.value); });
$('#regPass').addEventListener('input', (e) => { $('#regStrength').dataset.score = strengthScore(e.target.value); });
for (const id of ['#setupCode', '#regCode']) $(id).addEventListener('input', (e) => { e.target.value = formatCode(e.target.value); });
$('#toRegister').addEventListener('click', () => showAuthForm('register'));
$('#toLogin').addEventListener('click', () => showAuthForm('login'));

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.me = null;
  showAuth();
}

function changePassword() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const body = h('div', { class: 'dform' }, field('Contraseña actual', current), field('Nueva contraseña', next), strengthMeter(next), field('Repite la nueva contraseña', again));
  openDialog({
    title: 'Cambiar contraseña', body, confirm: 'Guardar',
    onConfirm: async () => {
      if (next.value !== again.value) throw new Error('Las contraseñas no coinciden');
      await api('/api/account/password', { method: 'POST', json: { current: current.value, next: next.value } });
      toast('Contraseña actualizada. Las demás sesiones se cerraron.');
    },
  });
}

function accountMenu() {
  menuAt($('#accountBtn'), [
    { icon: 'settings', label: 'Ajustes', action: () => { location.hash = '#/settings'; } },
    { icon: 'key', label: 'Cambiar contraseña', action: changePassword },
    '-',
    { icon: 'logout', label: 'Cerrar sesión', danger: true, action: logout },
  ]);
}

$('#accountBtn').addEventListener('click', accountMenu);
$('#accountBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); accountMenu(); } });

// ───────────────────────── Navegación ─────────────────────────

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  let tail = '';
  try { tail = rest.filter(Boolean).map(decodeURIComponent).join('/'); } catch { /* ruta corrupta */ }
  if (head === 'search') return { view: 'search', query: tail };
  if (head !== 'files' && Object.hasOwn(VIEWS, head)) return { view: head, sub: tail };
  return { view: 'files', path: head === 'f' ? tail : '' };
}

const filesHash = (p) => `#/f/${encPath(p)}`;

function navigate(p) {
  const hash = filesHash(p);
  if (location.hash === hash) route();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => { if (state.me) route(); });

const VIEWS = {
  files: { render: renderFilesView },
  search: { render: renderSearchView },
  shared: { render: renderSharedView, min: 'editor' },
  trash: { render: renderTrashView, min: 'editor' },
  users: { render: renderUsersView, min: 'admin' },
  activity: { render: renderActivityView, min: 'admin' },
  settings: { render: renderSettingsView },
};

function route() {
  const r = parseHash();
  const def = VIEWS[r.view];
  if (def.min && !can(def.min)) return navigate('');
  const changed = r.view !== state.view || (r.path ?? '') !== state.path || (r.query ?? '') !== state.query || (r.sub ?? '') !== state.sub;
  if (changed) {
    state.selected.clear();
    state.filter = '';
  }
  state.view = r.view;
  state.path = r.path ?? '';
  state.query = r.query ?? '';
  state.sub = r.sub ?? '';
  for (const a of $$('.nav-item[data-view]')) a.classList.toggle('active', a.dataset.view === (r.view === 'search' ? 'files' : r.view));
  closeSidebar();
  closeMenu();
  def.render();
}

function refresh() {
  VIEWS[state.view].render({ keep: true });
}

function setHeader(titleNodes, actionNodes = [], toolbarNodes = null) {
  $('#title').replaceChildren(...[titleNodes].flat().filter(Boolean));
  $('#actions').replaceChildren(...actionNodes.filter(Boolean));
  $('#toolbar').hidden = !toolbarNodes;
  $('#toolbar').replaceChildren(...(toolbarNodes || []).filter(Boolean));
}

const heading = (text, sub) => h('div', { class: 'view-title' }, h('h1', { text }), sub && h('span', { text: sub }));

function setContent(...nodes) {
  $('#content').replaceChildren(...nodes.flat().filter(Boolean));
}

function setLoading(on) {
  $('#content').classList.toggle('loading', on);
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    setStudio(s.studio);
    $('#usedText').textContent = `${fmtSize(s.used)} en el hosting`;
    $('#trashCount').textContent = s.trash ? String(s.trash) : '';
    $('#storageWhere').textContent = s.storage ? `Guardando en: ${s.storage.name}` : '';
    $('#storageWhere').classList.remove('err');
    if (s.disk) {
      const pct = ((s.disk.total - s.disk.free) / s.disk.total) * 100;
      $('#diskFill').style.width = `${Math.max(2, pct).toFixed(1)}%`;
      $('#freeText').textContent = `${fmtSize(s.disk.free)} libres`;
    }
    return s;
  } catch (err) {
    if (err.status === 503) {
      $('#storageWhere').textContent = 'Sin conexión con el PC de almacenamiento';
      $('#storageWhere').classList.add('err');
    }
    return null;
  }
}

function emptyState(ic, title, text, action) {
  return h('div', { class: 'empty' },
    h('div', {},
      h('div', { class: 'empty-icon' }, icon(ic)),
      h('h3', { text: title }),
      h('p', { text }),
      action));
}

// ───────────────────────── Vista: archivos ─────────────────────────

function searchBox() {
  const input = h('input', { id: 'search', type: 'search', placeholder: 'Buscar… (Enter: en todo)', autocomplete: 'off', value: state.view === 'search' ? state.query : state.filter });
  input.addEventListener('input', () => {
    if (state.view !== 'files') return;
    state.filter = input.value.trim();
    renderFileList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q.length >= 2) location.hash = `#/search/${encodeURIComponent(q)}`;
      else toast('Escribe al menos 2 caracteres', 'error');
    }
  });
  return h('label', { class: 'search' }, icon('search'), input, h('kbd', { text: '/' }));
}

function fileActions() {
  if (!can('editor')) return [searchBox()];
  return [
    searchBox(),
    h('button', { class: 'btn', type: 'button', onclick: newFolder, title: 'Nueva carpeta' }, icon('folder-plus'), h('span', { text: 'Nueva carpeta' })),
    h('button', { class: 'btn btn-primary', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => uploadMenu(e.currentTarget) },
      icon('upload'), h('span', { text: 'Subir' }), icon('chevron', 'caret-down')),
  ];
}

function uploadMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.right - 220, r.bottom + 6, [
    { icon: 'file', label: 'Subir archivos', action: () => $('#fileInput').click() },
    { icon: 'folder', label: 'Subir carpeta', action: () => $('#folderInput').click() },
  ], r.top);
}

function crumbs() {
  const parts = state.path ? state.path.split('/') : [];
  const all = [{ name: state.studio, path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
  const nav = h('nav', { class: 'crumbs-nav', 'aria-label': 'Ruta' });
  all.forEach((c, i) => {
    if (i) nav.append(icon('chevron', 'crumb-sep'));
    const a = h('a', { class: `crumb${i === all.length - 1 ? ' current' : ''}`, href: filesHash(c.path), text: c.name, title: c.name });
    // Soltar archivos internos sobre una miga de pan los mueve a esa carpeta.
    if (can('editor')) enableDropTarget(a, c.path);
    nav.append(a);
  });
  $('#dropTarget').textContent = `en ${all[all.length - 1].name}`;
  return nav;
}

function layoutToggle() {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': 'Vista' },
    ...['list', 'grid'].map((v) => h('button', {
      type: 'button', class: state.layout === v ? 'active' : '', title: v === 'list' ? 'Lista' : 'Cuadrícula',
      onclick: () => { state.layout = v; store.set('view', v); renderFilesToolbar(); renderFileList(); },
    }, icon(v))));
}

function renderFilesToolbar() {
  const n = state.selected.size;
  const bar = [];
  if (n) {
    bar.push(h('div', { class: 'selection' },
      h('span', { class: 'sel-count', text: `${n} ${n === 1 ? 'seleccionado' : 'seleccionados'}` }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => downloadItems(selectedItems()) }, icon('download'), 'Descargar'),
      can('editor') && h('button', { class: 'btn btn-sm', type: 'button', onclick: () => transferItems(selectedItems(), 'move') }, icon('move'), 'Mover'),
      can('editor') && h('button', { class: 'btn btn-sm', type: 'button', onclick: () => transferItems(selectedItems(), 'copy') }, icon('copy'), 'Copiar'),
      can('editor') && h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => deleteItems(selectedItems()) }, icon('trash'), 'Eliminar'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { state.selected.clear(); renderFilesToolbar(); renderFileList(); } }, 'Cancelar')));
  } else {
    const dirs = state.items.filter((i) => i.type === 'dir').length;
    const files = state.items.length - dirs;
    const total = state.items.reduce((s, i) => s + (i.size || 0), 0);
    const parts = [];
    if (dirs) parts.push(plural(dirs, 'carpeta', 'carpetas'));
    if (files) parts.push(`${plural(files, 'archivo', 'archivos')} · ${fmtSize(total)}`);
    bar.push(h('div', { class: 'summary', text: state.view === 'search' ? `${plural(state.items.length, 'resultado', 'resultados')}` : parts.join(' · ') || 'Carpeta vacía' }));
  }
  bar.push(h('div', { class: 'toolbar-right' },
    h('button', { class: 'icon-btn', type: 'button', title: 'Actualizar', 'aria-label': 'Actualizar', onclick: () => { refresh(); loadStats(); } }, icon('refresh')),
    layoutToggle()));
  $('#toolbar').hidden = false;
  $('#toolbar').replaceChildren(...bar);
}

async function renderFilesView() {
  setHeader(crumbs(), fileActions(), []);
  setLoading(true);
  try {
    const data = await api(`/api/list?path=${encodeURIComponent(state.path)}`);
    if (state.view !== 'files') return;
    state.items = data.items.map((i) => ({ ...i, path: joinPath(state.path, i.name) }));
    for (const p of state.selected) if (!state.items.some((i) => i.path === p)) state.selected.delete(p);
    renderFilesToolbar();
    renderFileList();
  } catch (err) {
    if (err.status === 404 && state.path) {
      toast('La carpeta ya no existe', 'error');
      navigate('');
    } else {
      reportError(err);
      if (!err.silent) setContent(emptyState('alert', 'No se pudo cargar', err.message));
    }
  } finally {
    setLoading(false);
  }
}

async function renderSearchView() {
  setHeader(heading(`Resultados para “${state.query}”`, 'Búsqueda en todas las carpetas'), [searchBox()], []);
  setLoading(true);
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(state.query)}`);
    if (state.view !== 'search') return;
    state.items = data.results;
    renderFilesToolbar();
    renderFileList();
    if (data.truncated) toast('Mostrando los primeros 300 resultados');
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

function visibleItems() {
  const q = state.view === 'files' ? state.filter.toLowerCase() : '';
  const { key, dir } = state.sort;
  const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
  return state.items
    .filter((i) => !q || i.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      let r = 0;
      if (key === 'size') r = (a.size ?? 0) - (b.size ?? 0);
      else if (key === 'mtime') r = a.mtime - b.mtime;
      if (!r) r = collator.compare(a.name, b.name);
      return r * dir;
    });
}

const selectedItems = () => state.items.filter((i) => state.selected.has(i.path));

function renderFileList() {
  const items = visibleItems();
  if (!items.length) {
    if (state.view === 'search') return setContent(emptyState('search', 'Sin resultados', `No hay archivos ni carpetas que contengan “${state.query}”.`));
    if (state.filter) return setContent(emptyState('search', 'Sin resultados', `Nada coincide con “${state.filter}” en esta carpeta.`));
    return setContent(emptyState(can('editor') ? 'upload' : 'folder', 'Esta carpeta está vacía',
      can('editor') ? 'Arrastra archivos o carpetas aquí, o usa el botón Subir.' : 'Todavía no hay archivos aquí.',
      can('editor') && h('div', { class: 'empty-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => $('#fileInput').click() }, icon('file'), 'Subir archivos'),
        h('button', { class: 'btn', type: 'button', onclick: () => $('#folderInput').click() }, icon('folder'), 'Subir carpeta'))));
  }
  setContent(state.layout === 'grid' ? renderGrid(items) : renderTable(items));
}

function toggleSelect(item, on) {
  on ? state.selected.add(item.path) : state.selected.delete(item.path);
  renderFilesToolbar();
  renderFileList();
}

function selectionCheckbox(item) {
  return h('input', {
    type: 'checkbox', class: 'check', checked: state.selected.has(item.path), 'aria-label': `Seleccionar ${item.name}`,
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => toggleSelect(item, e.target.checked),
  });
}

function rowActions(item) {
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  return h('div', { class: 'row-actions' },
    h('button', { class: 'icon-btn hide-mobile', type: 'button', title: item.type === 'dir' ? 'Descargar como ZIP' : 'Descargar', onclick: stop(() => downloadItems([item])) }, icon('download')),
    can('editor') && h('button', { class: 'icon-btn hide-mobile', type: 'button', title: 'Compartir enlace', onclick: stop(() => shareDialog(item)) }, icon('share')),
    h('button', { class: 'icon-btn', type: 'button', title: 'Más opciones', onclick: stop((e) => menuAt(e.currentTarget, itemMenu(item))) }, icon('more')));
}

function itemEvents(item) {
  return {
    tabindex: '0',
    draggable: can('editor') ? 'true' : null,
    onclick: () => openItem(item),
    onkeydown: (e) => {
      if (e.key === 'Enter') openItem(item);
      if (e.key === 'F2' && can('editor')) renameItem(item);
    },
    oncontextmenu: (e) => {
      e.preventDefault();
      const multi = state.selected.size > 1 && state.selected.has(item.path);
      showMenu(e.clientX, e.clientY, multi ? selectionMenu() : itemMenu(item));
    },
    ondragstart: (e) => {
      const paths = state.selected.has(item.path) ? [...state.selected] : [item.path];
      e.dataTransfer.setData('application/x-noir-paths', JSON.stringify(paths));
      e.dataTransfer.effectAllowed = 'move';
    },
  };
}

function enableDropTarget(el, destPath) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-noir-paths')) return;
    e.preventDefault();
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', async (e) => {
    const raw = e.dataTransfer.getData('application/x-noir-paths');
    el.classList.remove('drop-hover');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = JSON.parse(raw).filter((p) => p !== destPath && parentOf(p) !== destPath);
    if (!paths.length) return;
    try {
      const r = await api('/api/move', { method: 'POST', json: { paths, dest: destPath } });
      toast(`${plural(r.count, 'elemento movido', 'elementos movidos')}`);
      state.selected.clear();
      refresh();
    } catch (err) { reportError(err); }
  });
}

function renderTable(items) {
  const showLoc = state.view === 'search';
  const allChecked = items.every((i) => state.selected.has(i.path));
  const someChecked = items.some((i) => state.selected.has(i.path));
  const head = h('input', {
    type: 'checkbox', class: 'check', 'aria-label': 'Seleccionar todo', checked: allChecked,
    onchange: (e) => {
      for (const i of items) e.target.checked ? state.selected.add(i.path) : state.selected.delete(i.path);
      renderFilesToolbar();
      renderFileList();
    },
  });
  head.indeterminate = someChecked && !allChecked;

  const th = (label, key, cls) => {
    const active = state.sort.key === key;
    return h('th', {
      class: `${cls} sortable`,
      onclick: () => { state.sort = { key, dir: active ? -state.sort.dir : 1 }; renderFileList(); },
    }, label, active && h('span', { class: 'arrow', text: state.sort.dir === 1 ? '↑' : '↓' }));
  };

  const rows = items.map((item) => {
    const tr = h('tr', { class: state.selected.has(item.path) ? 'selected' : '', ...itemEvents(item) },
      h('td', { class: 'col-check' }, selectionCheckbox(item)),
      h('td', {}, h('div', { class: 'name-cell' }, typeBadge(item), h('span', { class: 'name', text: item.name, title: item.name }))),
      showLoc && h('td', { class: 'col-loc' }, h('a', {
        class: 'loc-link', href: filesHash(item.parent), text: `/${item.parent}`, title: `Abrir ubicación /${item.parent}`,
        onclick: (e) => e.stopPropagation(),
      })),
      h('td', { class: 'col-size', text: item.type === 'dir' ? '—' : fmtSize(item.size) }),
      h('td', { class: 'col-date', text: fmtDate(item.mtime) }),
      h('td', { class: 'col-actions' }, rowActions(item)));
    if (item.type === 'dir' && can('editor')) enableDropTarget(tr, item.path);
    return tr;
  });

  return h('table', { class: 'table files-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'col-check' }, head),
      th('Nombre', 'name', ''),
      showLoc && h('th', { class: 'col-loc', text: 'Ubicación' }),
      th('Tamaño', 'size', 'col-size'),
      th('Modificado', 'mtime', 'col-date'),
      h('th', { class: 'col-actions' }))),
    h('tbody', {}, rows));
}

function renderGrid(items) {
  return h('div', { class: `grid${state.selected.size ? ' selecting' : ''}` }, items.map((item) => {
    const thumb = kindOf(item) === 'image'
      ? h('img', { src: fileUrl(item.path), alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.replaceWith(typeBadge(item)) })
      : typeBadge(item);
    const card = h('div', { class: `card${state.selected.has(item.path) ? ' selected' : ''}`, ...itemEvents(item) },
      selectionCheckbox(item),
      rowActions(item),
      h('div', { class: 'card-thumb' }, thumb),
      h('div', { class: 'card-info' },
        h('div', { class: 'card-name', text: item.name, title: item.name }),
        h('div', { class: 'card-meta', text: item.type === 'dir' ? 'Carpeta' : `${fmtSize(item.size)} · ${fmtDate(item.mtime)}` })));
    if (item.type === 'dir' && can('editor')) enableDropTarget(card, item.path);
    return card;
  }));
}

function openItem(item) {
  if (state.selected.size) return toggleSelect(item, !state.selected.has(item.path));
  if (item.type === 'dir') return navigate(item.path);
  if (previewKind(item)) return openPreview(item);
  download(fileUrl(item.path, true));
}

function itemMenu(item) {
  const ed = can('editor');
  return [
    { icon: item.type === 'dir' ? 'folder' : previewKind(item) ? 'eye' : 'download', label: item.type === 'dir' ? 'Abrir' : previewKind(item) ? 'Vista previa' : 'Descargar', action: () => openItem(item), hint: '↵' },
    item.type === 'dir' || previewKind(item) ? { icon: 'download', label: item.type === 'dir' ? 'Descargar como ZIP' : 'Descargar', action: () => downloadItems([item]) } : null,
    state.view === 'search' ? { icon: 'folder', label: 'Abrir ubicación', action: () => navigate(item.parent) } : null,
    ed && { icon: 'share', label: 'Compartir enlace…', action: () => shareDialog(item) },
    '-',
    ed && { icon: 'edit', label: 'Renombrar', action: () => renameItem(item), hint: 'F2' },
    ed && { icon: 'move', label: 'Mover a…', action: () => transferItems([item], 'move') },
    ed && { icon: 'copy', label: 'Copiar a…', action: () => transferItems([item], 'copy') },
    { icon: 'copy', label: 'Copiar ruta', action: () => copyText(`/${item.path}`) },
    '-',
    ed && { icon: 'trash', label: 'Mover a la papelera', danger: true, action: () => deleteItems([item]), hint: 'Supr' },
  ];
}

function selectionMenu() {
  const items = selectedItems();
  const ed = can('editor');
  return [
    { icon: 'download', label: `Descargar ${items.length} como ZIP`, action: () => downloadItems(items) },
    '-',
    ed && { icon: 'move', label: 'Mover a…', action: () => transferItems(items, 'move') },
    ed && { icon: 'copy', label: 'Copiar a…', action: () => transferItems(items, 'copy') },
    '-',
    ed && { icon: 'trash', label: `Mover ${items.length} a la papelera`, danger: true, action: () => deleteItems(items) },
  ];
}

// ───────────────────────── Acciones sobre archivos ─────────────────────────

function downloadItems(items) {
  if (!items.length) return;
  if (items.length === 1 && items[0].type === 'file') return download(fileUrl(items[0].path, true));
  download(`/api/zip?${items.map((i) => `path=${encodeURIComponent(i.path)}`).join('&')}`);
  toast(items.length === 1 ? 'Preparando ZIP…' : `Preparando ZIP con ${items.length} elementos…`);
}

function renameItem(item) {
  askText({
    title: item.type === 'dir' ? 'Renombrar carpeta' : 'Renombrar archivo', value: item.name, confirm: 'Renombrar',
    onConfirm: async (name) => {
      if (!name || name === item.name) return;
      await api('/api/rename', { method: 'POST', json: { path: item.path, name } });
      toast('Nombre actualizado');
      refresh();
    },
  });
}

async function deleteItems(items) {
  if (!items.length) return;
  const label = items.length === 1 ? `“${items[0].name}”` : `${items.length} elementos`;
  const ok = await openDialog({
    title: `¿Mover ${label} a la papelera?`,
    message: 'Podrás restaurarlo desde la Papelera.',
    confirm: 'Mover a la papelera',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/delete', { method: 'POST', json: { paths: items.map((i) => i.path) } });
    for (const i of items) state.selected.delete(i.path);
    toast(items.length === 1 ? 'Movido a la papelera' : `${items.length} elementos movidos a la papelera`);
    refresh();
    loadStats();
  } catch (err) { reportError(err); }
}

function newFolder() {
  askText({
    title: 'Nueva carpeta', confirm: 'Crear',
    onConfirm: async (name) => {
      if (!name) throw new Error('Escribe un nombre');
      await api('/api/mkdir', { method: 'POST', json: { path: state.path, name } });
      toast(`Carpeta “${name}” creada`);
      refresh();
    },
  });
}

async function pickFolder(title, confirm, exclude = []) {
  let cur = state.view === 'files' ? state.path : '';
  const crumbsEl = h('div', { class: 'picker-crumbs' });
  const list = h('div', { class: 'picker-list' });
  const blocked = (p) => exclude.some((x) => p === x || p.startsWith(`${x}/`));

  async function go(p) {
    cur = p;
    const parts = p ? p.split('/') : [];
    crumbsEl.replaceChildren(...[{ name: state.studio, path: '' }, ...parts.map((n, i) => ({ name: n, path: parts.slice(0, i + 1).join('/') }))]
      .flatMap((c, i) => [i ? icon('chevron', 'crumb-sep') : null, h('button', { type: 'button', class: 'picker-crumb', text: c.name, onclick: () => go(c.path) })]).filter(Boolean));
    list.replaceChildren(h('div', { class: 'picker-empty' }, h('span', { class: 'spinner sm' })));
    try {
      const { folders } = await api(`/api/folders?path=${encodeURIComponent(p)}`);
      list.replaceChildren(...folders.map((name) => {
        const fp = joinPath(p, name);
        return h('button', { type: 'button', class: 'picker-item', disabled: blocked(fp), onclick: () => go(fp) }, icon('folder'), h('span', { text: name }), icon('chevron'));
      }));
      if (!folders.length) list.append(h('div', { class: 'picker-empty', text: 'Sin subcarpetas' }));
    } catch (err) {
      list.replaceChildren(h('div', { class: 'picker-empty', text: err.message }));
    }
  }

  const newInput = h('input', { type: 'text', placeholder: 'Nombre de la carpeta', autocomplete: 'off', spellcheck: 'false' });
  const createFolder = async () => {
    const name = newInput.value.trim();
    if (!name) return newInput.focus();
    try {
      await api('/api/mkdir', { method: 'POST', json: { path: cur, name } });
      newInput.value = '';
      newRow.hidden = true;
      newBtn.hidden = false;
      go(joinPath(cur, name));
    } catch (err) { reportError(err); }
  };
  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createFolder(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); newRow.hidden = true; newBtn.hidden = false; }
  });
  const newRow = h('div', { class: 'picker-newrow', hidden: true }, newInput, h('button', { type: 'button', class: 'btn btn-sm', onclick: createFolder }, 'Crear'));
  const newBtn = h('button', {
    type: 'button', class: 'btn btn-sm btn-ghost picker-new',
    onclick: () => { newBtn.hidden = true; newRow.hidden = false; newInput.focus(); },
  }, icon('folder-plus'), 'Nueva carpeta aquí');

  go(cur);
  return openDialog({
    title, wide: true, confirm,
    body: h('div', { class: 'picker' }, crumbsEl, list, can('editor') && newBtn, newRow),
    onConfirm: () => {
      if (blocked(cur)) throw new Error('No puedes elegir una carpeta seleccionada como destino');
      return cur;
    },
  });
}

async function transferItems(items, mode) {
  if (!items.length) return;
  const label = items.length === 1 ? `“${items[0].name}”` : `${items.length} elementos`;
  const dest = await pickFolder(mode === 'move' ? `Mover ${label} a…` : `Copiar ${label} a…`, mode === 'move' ? 'Mover aquí' : 'Copiar aquí', items.filter((i) => i.type === 'dir').map((i) => i.path));
  if (dest === null) return;
  try {
    const r = await api(`/api/${mode}`, { method: 'POST', json: { paths: items.map((i) => i.path), dest } });
    toast(mode === 'move' ? `${plural(r.count, 'elemento movido', 'elementos movidos')}` : `${plural(r.count, 'elemento copiado', 'elementos copiados')}`);
    state.selected.clear();
    refresh();
    loadStats();
  } catch (err) { reportError(err); }
}

// ───────────────────────── Compartir ─────────────────────────

const shareUrl = (s) => `${state.settings?.publicUrl || location.origin}/s/${s.token}`;

async function shareDialog(item) {
  const expiry = h('select', {},
    ...[['1', '1 hora'], ['24', '1 día'], ['168', '7 días'], ['720', '30 días'], ['0', 'Sin caducidad']].map(([v, t]) => h('option', { value: v, text: t })));
  expiry.value = '168';
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Opcional', minlength: '8' });
  const max = h('input', { type: 'number', min: '0', step: '1', placeholder: 'Ilimitadas' });
  const body = h('div', { class: 'dform' },
    field('Caduca en', expiry),
    h('div', { class: 'dform-row' }, field('Contraseña', pw), field('Máx. de descargas', max)));
  const share = await openDialog({
    title: `Compartir “${item.name}”`,
    message: 'Cualquier persona con el enlace podrá descargarlo, aunque no tenga cuenta.',
    body, confirm: 'Crear enlace',
    onConfirm: async () => (await api('/api/shares', {
      method: 'POST',
      json: { path: item.path, hours: Number(expiry.value), password: pw.value || undefined, maxDownloads: Number(max.value) || undefined },
    })).share,
  });
  if (share) showShareLink(share);
}

function showShareLink(share) {
  const url = shareUrl(share);
  const input = h('input', { type: 'text', readonly: true, class: 'mono-input', value: url, onfocus: (e) => e.target.select() });
  const copyBtn = h('button', { class: 'btn', type: 'button', onclick: () => copyText(url) }, icon('copy'), 'Copiar');
  const notes = [
    share.expiresAt ? `Caduca ${timeAgo(share.expiresAt).toLowerCase()}` : 'Sin caducidad',
    share.maxDownloads ? `máximo ${plural(share.maxDownloads, 'descarga', 'descargas')}` : null,
    share.hasPassword ? 'protegido con contraseña' : null,
  ].filter(Boolean).join(' · ');
  copyText(url);
  openDialog({
    title: 'Enlace listo', message: notes, confirm: 'Listo', cancel: null,
    body: h('div', { class: 'copy-row' }, input, copyBtn),
  });
}

async function renderSharedView() {
  setHeader(heading('Compartidos', 'Enlaces públicos de descarga'), [], null);
  setLoading(true);
  try {
    const { items } = await api('/api/shares');
    if (state.view !== 'shared') return;
    if (!items.length) return setContent(emptyState('share', 'No hay enlaces compartidos', 'Desde Archivos, abre el menú de un elemento y elige “Compartir enlace”.'));
    const rows = items.map((s) => {
      const status = !s.exists ? ['muted', 'No disponible'] : !s.active ? ['muted', 'Caducado'] : ['ok', 'Activo'];
      return h('tr', {},
        h('td', {}, h('div', { class: 'name-cell' }, typeBadge({ type: s.isDir ? 'dir' : 'file', name: s.name }),
          h('div', { class: 'name-stack' }, h('span', { class: 'name', text: s.name }), h('small', { text: `/${s.path}` })))),
        h('td', { class: 'col-status' }, h('span', { class: `badge ${status[0]}`, text: status[1] }), s.hasPassword && h('span', { class: 'badge', title: 'Protegido con contraseña' }, icon('lock'))),
        h('td', { class: 'col-date hide-mobile', text: s.expiresAt ? timeAgo(s.expiresAt) : 'Sin caducidad' }),
        h('td', { class: 'col-num hide-mobile', text: s.maxDownloads ? `${s.downloads} / ${s.maxDownloads}` : String(s.downloads) }),
        h('td', { class: 'col-by hide-mobile', text: s.createdBy }),
        h('td', { class: 'col-actions' }, h('div', { class: 'row-actions visible' },
          h('button', { class: 'icon-btn', type: 'button', title: 'Copiar enlace', onclick: () => copyText(shareUrl(s)) }, icon('copy')),
          h('a', { class: 'icon-btn', href: shareUrl(s), target: '_blank', rel: 'noopener', title: 'Abrir enlace' }, icon('globe')),
          h('button', {
            class: 'icon-btn danger', type: 'button', title: 'Eliminar enlace',
            onclick: async () => {
              if (!(await confirmDanger('¿Eliminar este enlace?', 'Quien lo tenga ya no podrá descargar el archivo.'))) return;
              try { await api(`/api/shares/${encodeURIComponent(s.token)}`, { method: 'DELETE' }); toast('Enlace eliminado'); refresh(); } catch (err) { reportError(err); }
            },
          }, icon('trash')))));
    });
    setContent(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Elemento' }), h('th', { class: 'col-status', text: 'Estado' }), h('th', { class: 'col-date hide-mobile', text: 'Caducidad' }), h('th', { class: 'col-num hide-mobile', text: 'Descargas' }), h('th', { class: 'col-by hide-mobile', text: 'Creado por' }), h('th', { class: 'col-actions' }))),
      h('tbody', {}, rows)));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

// ───────────────────────── Papelera ─────────────────────────

async function renderTrashView() {
  setHeader(heading('Papelera'), [], []);
  setLoading(true);
  try {
    const { items, days } = await api('/api/trash');
    if (state.view !== 'trash') return;
    $('#title').replaceChildren(heading('Papelera', `Los elementos se eliminan definitivamente tras ${days} días`));
    $('#toolbar').replaceChildren(
      h('div', { class: 'summary', text: items.length ? `${plural(items.length, 'elemento', 'elementos')} · ${fmtSize(items.reduce((s, i) => s + i.size, 0))}` : '' }),
      h('div', { class: 'toolbar-right' }, can('admin') && items.length && h('button', {
        class: 'btn btn-sm btn-danger', type: 'button',
        onclick: async () => {
          if (!(await confirmDanger('¿Vaciar la papelera?', `Se eliminarán definitivamente ${plural(items.length, 'elemento', 'elementos')}. No se puede deshacer.`, 'Vaciar papelera'))) return;
          try { await api('/api/trash/purge', { method: 'POST', json: { all: true } }); toast('Papelera vaciada'); refresh(); loadStats(); } catch (err) { reportError(err); }
        },
      }, icon('trash'), 'Vaciar papelera')));
    if (!items.length) return setContent(emptyState('trash', 'La papelera está vacía', 'Lo que elimines aparecerá aquí y podrás restaurarlo.'));
    const rows = items.map((t) => h('tr', {},
      h('td', {}, h('div', { class: 'name-cell' }, typeBadge({ type: t.isDir ? 'dir' : 'file', name: t.name }),
        h('div', { class: 'name-stack' }, h('span', { class: 'name', text: t.name }), h('small', { text: `/${parentOf(t.original)}` })))),
      h('td', { class: 'col-date hide-mobile' }, h('div', { class: 'name-stack' }, h('span', { text: timeAgo(t.deletedAt) }), h('small', { text: `por ${t.deletedBy}` }))),
      h('td', { class: 'col-size', text: fmtSize(t.size) }),
      h('td', { class: 'col-actions wide' }, h('div', { class: 'row-actions visible' },
        h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: async () => {
            try { await api('/api/trash/restore', { method: 'POST', json: { ids: [t.id] } }); toast(`“${t.name}” restaurado`); refresh(); loadStats(); } catch (err) { reportError(err); }
          },
        }, icon('restore'), h('span', { class: 'hide-mobile', text: 'Restaurar' })),
        can('admin') && h('button', {
          class: 'icon-btn danger', type: 'button', title: 'Eliminar definitivamente',
          onclick: async () => {
            if (!(await confirmDanger(`¿Eliminar “${t.name}” definitivamente?`, 'No se puede deshacer.'))) return;
            try { await api('/api/trash/purge', { method: 'POST', json: { ids: [t.id] } }); toast('Eliminado definitivamente'); refresh(); loadStats(); } catch (err) { reportError(err); }
          },
        }, icon('trash'))))));
    setContent(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Nombre' }), h('th', { class: 'col-date hide-mobile', text: 'Eliminado' }), h('th', { class: 'col-size', text: 'Tamaño' }), h('th', { class: 'col-actions wide' }))),
      h('tbody', {}, rows)));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

// ───────────────────────── Usuarios ─────────────────────────

function roleSelect(value) {
  const sel = h('select', {}, ...Object.keys(ROLE_LABEL).map((r) => h('option', { value: r, text: ROLE_LABEL[r] })));
  sel.value = value;
  return sel;
}

function userDialog() {
  const username = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', required: true, minlength: '3', maxlength: '32', placeholder: 'nombre.usuario' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const role = roleSelect('editor');
  const desc = h('small', { class: 'field-hint', text: ROLE_DESC.editor });
  role.addEventListener('change', () => { desc.textContent = ROLE_DESC[role.value]; });
  const body = h('div', { class: 'dform' },
    field('Usuario', username, 'Letras, números, punto o guion (3–32).'),
    field('Contraseña', pw), strengthMeter(pw),
    h('label', { class: 'dfield' }, h('span', { class: 'dfield-label', text: 'Rol' }), role, desc));
  openDialog({
    title: 'Nuevo usuario', body, confirm: 'Crear usuario',
    onConfirm: async () => {
      await api('/api/users', { method: 'POST', json: { username: username.value.trim(), password: pw.value, role: role.value } });
      toast(`Usuario “${username.value.trim()}” creado`);
      refresh();
    },
  });
}

function resetUserPassword(u) {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  openDialog({
    title: `Nueva contraseña para ${u.username}`, message: 'Se cerrarán sus sesiones abiertas.',
    body: h('div', { class: 'dform' }, field('Contraseña', pw), strengthMeter(pw)), confirm: 'Guardar',
    onConfirm: async () => {
      await api(`/api/users/${u.id}`, { method: 'PATCH', json: { password: pw.value } });
      toast('Contraseña actualizada');
    },
  });
}

async function renderUsersView() {
  setHeader(heading('Usuarios', 'Quién puede entrar y qué puede hacer'), [
    h('button', { class: 'btn btn-primary', type: 'button', onclick: userDialog }, icon('plus'), h('span', { text: 'Nuevo usuario' })),
  ], null);
  setLoading(true);
  try {
    const { items } = await api('/api/users');
    if (state.view !== 'users') return;
    const rows = items.map((u) => {
      const me = u.id === state.me.id;
      const sel = roleSelect(u.role);
      sel.classList.add('select-sm');
      sel.addEventListener('change', async () => {
        try {
          await api(`/api/users/${u.id}`, { method: 'PATCH', json: { role: sel.value } });
          toast(`${u.username} ahora es ${ROLE_LABEL[sel.value]}`);
          if (me) location.reload();
        } catch (err) { sel.value = u.role; reportError(err); }
      });
      return h('tr', {},
        h('td', {}, h('div', { class: 'name-cell' }, h('div', { class: 'avatar sm', text: u.username.charAt(0).toUpperCase() }),
          h('div', { class: 'name-stack' }, h('span', { class: 'name' }, u.username, me && h('span', { class: 'badge gold', text: 'Tú' })), h('small', { text: `Creado ${fmtDate(u.createdAt)}` })))),
        h('td', { class: 'col-role' }, sel),
        h('td', { class: 'col-date hide-mobile', text: u.lastLogin ? timeAgo(u.lastLogin) : 'Nunca' }),
        h('td', { class: 'col-actions' }, h('div', { class: 'row-actions visible' },
          h('button', { class: 'icon-btn', type: 'button', title: 'Cambiar contraseña', onclick: () => (me ? changePassword() : resetUserPassword(u)) }, icon('key')),
          !me && h('button', {
            class: 'icon-btn danger', type: 'button', title: 'Eliminar usuario',
            onclick: async () => {
              if (!(await confirmDanger(`¿Eliminar a ${u.username}?`, 'Perderá el acceso de inmediato. Sus archivos no se borran.'))) return;
              try { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('Usuario eliminado'); refresh(); } catch (err) { reportError(err); }
            },
          }, icon('trash')))));
    });
    setContent(
      h('div', { class: 'role-legend' }, ...Object.keys(ROLE_LABEL).map((r) => h('div', { class: 'role-card' }, h('strong', { text: ROLE_LABEL[r] }), h('span', { text: ROLE_DESC[r] })))),
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Usuario' }), h('th', { class: 'col-role', text: 'Rol' }), h('th', { class: 'col-date hide-mobile', text: 'Último acceso' }), h('th', { class: 'col-actions' }))),
        h('tbody', {}, rows)));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

// ───────────────────────── Actividad ─────────────────────────

const ACTIONS = {
  setup: ['shield', 'configuró el hosting', 'auth'],
  login: ['login', 'inició sesión', 'auth'],
  login_failed: ['alert', 'Intento de acceso fallido', 'auth'],
  logout: ['logout', 'cerró sesión', 'auth'],
  password_change: ['key', 'cambió su contraseña', 'auth'],
  upload: ['upload', 'subió', 'files'],
  download: ['download', 'descargó', 'files'],
  zip: ['archive', 'descargó', 'files'],
  mkdir: ['folder-plus', 'creó la carpeta', 'files'],
  rename: ['edit', 'renombró', 'files'],
  move: ['move', 'movió', 'files'],
  copy: ['copy', 'copió', 'files'],
  delete: ['trash', 'envió a la papelera', 'files'],
  restore: ['restore', 'restauró', 'files'],
  purge: ['trash', 'eliminó definitivamente', 'files'],
  empty_trash: ['trash', 'vació la papelera', 'files'],
  share_create: ['share', 'compartió', 'shares'],
  share_delete: ['share', 'eliminó el enlace de', 'shares'],
  share_download: ['globe', 'Descarga por enlace:', 'shares'],
  user_create: ['users', 'creó el usuario', 'users'],
  user_update: ['users', 'actualizó un usuario:', 'users'],
  user_delete: ['users', 'eliminó el usuario', 'users'],
  settings: ['settings', 'cambió los ajustes', 'users'],
  register: ['ticket', 'creó su cuenta', 'auth'],
  invite_create: ['ticket', 'generó el código de acceso', 'users'],
  invite_delete: ['ticket', 'revocó el código de acceso', 'users'],
  db_upload: ['database', 'subió la base de datos', 'files'],
  db_download: ['database', 'descargó la base de datos', 'files'],
  db_delete: ['database', 'eliminó la base de datos', 'files'],
  db_restore: ['restore', 'restauró la base de datos', 'files'],
  db_query: ['database', 'consultó', 'files'],
  project_add: ['code', 'añadió el proyecto', 'users'],
  project_remove: ['code', 'quitó el proyecto', 'users'],
  project_zip: ['code', 'descargó el código de', 'files'],
  storage_mode: ['server', 'cambió el almacenamiento a', 'users'],
  storage_migrate: ['copy', 'copió los archivos:', 'users'],
  agent_download: ['download', 'descargó la app de almacenamiento', 'users'],
  agent_pair: ['server', 'vinculó el PC de almacenamiento', 'users'],
  agent_remove: ['server', 'desvinculó el PC de almacenamiento', 'users'],
};

let activityFilter = 'all';
async function renderActivityView() {
  const filters = [['all', 'Todo'], ['auth', 'Accesos'], ['files', 'Archivos'], ['shares', 'Enlaces'], ['users', 'Administración']];
  const seg = h('div', { class: 'segmented text' }, ...filters.map(([v, t]) => h('button', {
    type: 'button', class: activityFilter === v ? 'active' : '', text: t,
    onclick: () => { activityFilter = v; renderActivityView(); },
  })));
  setHeader(heading('Actividad', 'Registro de lo que ocurre en el hosting'), [], [seg,
    h('div', { class: 'toolbar-right' }, h('button', { class: 'icon-btn', type: 'button', title: 'Actualizar', onclick: refresh }, icon('refresh')))]);
  setLoading(true);
  try {
    const { items } = await api('/api/activity');
    if (state.view !== 'activity') return;
    const list = items.filter((a) => activityFilter === 'all' || ACTIONS[a.action]?.[2] === activityFilter);
    if (!list.length) return setContent(emptyState('activity', 'Sin actividad', 'Aquí verás accesos, subidas, descargas y cambios.'));
    setContent(h('ul', { class: 'feed' }, list.map((a) => {
      const [ic, verb] = ACTIONS[a.action] || ['activity', a.action];
      const failed = a.action === 'login_failed';
      return h('li', { class: `feed-item${failed ? ' warn' : ''}` },
        h('span', { class: 'feed-icon' }, icon(ic)),
        h('div', { class: 'feed-body' },
          h('div', { class: 'feed-text' }, a.user && !failed && a.action !== 'share_download' ? h('strong', { text: a.user }) : null, ` ${verb} `, a.detail && h('span', { class: 'feed-detail', text: a.detail })),
          h('div', { class: 'feed-meta', text: [timeAgo(a.t), fmtDate(a.t), a.ip].filter(Boolean).join(' · ') })));
    })));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

// ───────────────────────── Ajustes ─────────────────────────

function card(title, ic, ...body) {
  return h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, icon(ic), h('h2', { text: title })), h('div', { class: 'panel-body' }, ...body));
}

function kv(label, value, extra) {
  return h('div', { class: 'kv' }, h('span', { class: 'kv-label', text: label }), h('span', { class: 'kv-value' }, value), extra);
}

function urlValue(url) {
  return h('div', { class: 'url-value' }, h('span', { class: 'mono', text: url }),
    h('button', { class: 'icon-btn sm', type: 'button', title: 'Copiar', onclick: () => copyText(url) }, icon('copy')));
}

async function renderSettingsView() {
  setHeader(heading('Ajustes', 'Tu cuenta, conexión y almacenamiento'), [], null);
  setLoading(true);
  try {
    const [s, stats] = await Promise.all([api('/api/settings'), api('/api/stats')]);
    if (state.view !== 'settings') return;
    state.settings = s;

    const account = card('Mi cuenta', 'user',
      h('div', { class: 'account-row' },
        h('div', { class: 'avatar lg', text: state.me.username.charAt(0).toUpperCase() }),
        h('div', { class: 'name-stack' }, h('strong', { text: state.me.username }), h('small', { text: `${ROLE_LABEL[state.me.role]} · ${ROLE_DESC[state.me.role]}` }))),
      h('div', { class: 'panel-actions' },
        h('button', { class: 'btn', type: 'button', onclick: changePassword }, icon('key'), 'Cambiar contraseña'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: logout }, icon('logout'), 'Cerrar sesión')));

    const connection = card('Conexión', 'globe',
      s.publicUrl ? kv('Desde internet', urlValue(s.publicUrl)) : kv('Desde internet', h('span', { class: 'muted', text: 'Túnel no activo (modo red local)' })),
      s.fixedUrl && kv('Enlace fijo', urlValue(s.fixedUrl)),
      ...s.lanUrls.map((u) => kv('Red local', urlValue(u))),
      kv('Equipo', s.host),
      h('p', { class: 'panel-note', text: 'La dirección de internet cambia cada vez que se reinicia el hosting.' }));

    const total = stats.used || 0;
    const kinds = Object.entries(stats.byKind || {}).sort((a, b) => b[1].size - a[1].size);
    const bar = h('div', { class: 'stack-bar' }, ...kinds.map(([k, v]) => {
      const seg = h('span', { title: `${KIND_INFO[k]?.label}: ${fmtSize(v.size)}` });
      seg.style.width = `${total ? Math.max(0.8, (v.size / total) * 100) : 0}%`;
      seg.style.background = KIND_INFO[k]?.color;
      return seg;
    }));
    const legend = h('div', { class: 'legend' }, ...kinds.map(([k, v]) => {
      const dot = h('span', { class: 'legend-dot' });
      dot.style.background = KIND_INFO[k]?.color;
      return h('div', { class: 'legend-item' }, dot, h('span', { text: KIND_INFO[k]?.label || k }), h('span', { class: 'muted', text: `${plural(v.count, 'archivo', 'archivos')} · ${fmtSize(v.size)}` }));
    }));
    const storage = card('Almacenamiento', 'pie',
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('strong', { text: fmtSize(total) }), h('span', { text: 'en el hosting' })),
        stats.disk && h('div', { class: 'stat' }, h('strong', { text: fmtSize(stats.disk.free) }), h('span', { text: 'libres en disco' })),
        h('div', { class: 'stat' }, h('strong', { text: String(stats.files) }), h('span', { text: 'archivos' })),
        h('div', { class: 'stat' }, h('strong', { text: String(stats.folders) }), h('span', { text: 'carpetas' }))),
      total ? bar : null,
      total ? legend : h('p', { class: 'panel-note', text: 'Aún no hay archivos.' }),
      can('admin') && kv('Carpeta', h('span', { class: 'mono small', text: s.storagePath })));

    let general = null;
    if (can('admin')) {
      const name = h('input', { type: 'text', maxlength: '40', required: true, value: s.studioName });
      const hours = h('input', { type: 'number', min: '1', max: '720', required: true, value: String(s.sessionHours) });
      const days = h('input', { type: 'number', min: '1', max: '365', required: true, value: String(s.trashDays) });
      const save = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), 'Guardar cambios');
      const err = h('p', { class: 'form-error' });
      general = card('General', 'settings',
        h('form', {
          class: 'dform',
          onsubmit: async (e) => {
            e.preventDefault();
            err.textContent = '';
            save.disabled = true;
            try {
              await api('/api/settings', { method: 'POST', json: { studioName: name.value.trim(), sessionHours: Number(hours.value), trashDays: Number(days.value) } });
              setStudio(name.value.trim());
              toast('Ajustes guardados');
            } catch (ex) { err.textContent = ex.message; } finally { save.disabled = false; }
          },
        },
        field('Nombre del estudio', name, 'Aparece en el panel, el inicio de sesión y los enlaces compartidos.'),
        h('div', { class: 'dform-row' }, field('Duración de la sesión (horas)', hours), field('Días en la papelera', days)),
        err,
        h('div', { class: 'panel-actions' }, save)));
    }

    const about = card('Acerca de', 'server',
      kv('Versión', `Noir Studio Hosting ${s.version}`),
      kv('Node.js', s.node),
      kv('En línea desde hace', fmtUptime(s.uptime)));

    const serverInfo = can('admin') && typeof serverCard === 'function' ? await serverCard() : null;
    setContent(h('div', { class: 'panels' }, h('div', { class: 'panels-col' }, account, general, serverInfo, about), h('div', { class: 'panels-col' }, connection, storage)));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

// Menú lateral en móvil
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').hidden = true; }
$('#menuBtn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').hidden = false; });
$('#scrim').addEventListener('click', closeSidebar);

// ───────────────────────── Vista previa ─────────────────────────

let previewIndex = -1;
const previewList = () => visibleItems().filter(previewKind);

function openPreview(item) {
  previewIndex = previewList().findIndex((i) => i.path === item.path);
  showPreview();
}

async function showPreview() {
  const list = previewList();
  const item = list[previewIndex];
  if (!item) return closePreview();
  const kind = previewKind(item);
  const body = $('#previewBody');
  $('#preview').hidden = false;
  $('#previewName').textContent = item.name;
  $('#previewMeta').textContent = `${fmtSize(item.size)} · ${fmtDate(item.mtime)}${list.length > 1 ? ` · ${previewIndex + 1} de ${list.length}` : ''}`;
  $('#previewDownload').href = fileUrl(item.path, true);
  $('#previewDownload').setAttribute('download', '');
  $('#previewPrev').hidden = $('#previewNext').hidden = list.length < 2;
  body.replaceChildren();

  const src = fileUrl(item.path);
  if (kind === 'image') body.append(h('img', { src, alt: item.name }));
  else if (kind === 'video') body.append(h('video', { src, controls: true, autoplay: true, playsInline: true }));
  else if (kind === 'audio') body.append(h('div', { class: 'audio-card' }, typeBadge(item), h('strong', { text: item.name }), h('audio', { src, controls: true, autoplay: true })));
  else if (kind === 'pdf') body.append(h('iframe', { src, title: item.name }));
  else if (kind === 'text') {
    body.append(h('div', { class: 'spinner' }));
    const limit = 1024 * 1024;
    try {
      const res = await fetch(src, { headers: item.size > limit ? { Range: `bytes=0-${limit - 1}` } : {} });
      if (!res.ok && res.status !== 206) throw new Error();
      let text = await res.text();
      if (item.size > limit) text += '\n\n… (vista previa limitada a 1 MB — descarga el archivo para verlo completo)';
      if (previewList()[previewIndex] === item) body.replaceChildren(h('pre', { text }));
    } catch {
      body.replaceChildren(h('p', { text: 'No se pudo cargar la vista previa.' }));
    }
  }
}

function closePreview() {
  $('#preview').hidden = true;
  $('#previewBody').replaceChildren();
}

function stepPreview(d) {
  const n = previewList().length;
  if (n < 2) return;
  previewIndex = (previewIndex + d + n) % n;
  showPreview();
}

$('#previewClose').addEventListener('click', closePreview);
$('#previewPrev').addEventListener('click', () => stepPreview(-1));
$('#previewNext').addEventListener('click', () => stepPreview(1));

// ───────────────────────── Subidas ─────────────────────────

const uploads = { tasks: [], active: 0, refreshTimer: null };

function enqueue(entries, { area = 'files' } = {}) {
  if (!entries.length) return;
  if (!can('editor')) return toast('Tu cuenta solo permite ver y descargar', 'error');
  const base = state.view === 'files' ? state.path : '';
  for (const { file, rel, name } of entries) {
    const t = { file, area, name: name || file.name, dir: area === 'db' ? '' : joinPath(base, rel), size: file.size, loaded: 0, status: 'queued', xhr: null, cancelled: false };
    t.el = buildUploadItem(t);
    $('#uploadsList').append(t.el);
    uploads.tasks.push(t);
  }
  $('#uploads').hidden = false;
  $('#uploads').classList.remove('collapsed');
  updateUploadsHeader();
  pump();
}

function pump() {
  while (uploads.active < PARALLEL) {
    const t = uploads.tasks.find((x) => x.status === 'queued');
    if (!t) break;
    uploads.active++;
    runUpload(t).finally(() => {
      uploads.active--;
      scheduleRefresh();
      pump();
      updateUploadsHeader();
    });
  }
}

function scheduleRefresh() {
  clearTimeout(uploads.refreshTimer);
  uploads.refreshTimer = setTimeout(() => {
    if (state.view === 'files' || state.view === 'db') refresh();
    loadStats();
  }, uploads.active ? 1500 : 200);
}

async function runUpload(t) {
  const qs = new URLSearchParams({ path: t.dir, name: t.name, size: String(t.size), area: t.area });
  t.status = 'uploading';
  t.started = performance.now();
  updateUploadItem(t);
  let retries = 0;
  try {
    let { offset } = await api(`/api/upload/status?${qs}`);
    t.startBytes = offset;
    t.loaded = offset;
    for (;;) {
      if (t.cancelled) throw new Error('cancelled');
      try {
        const r = await sendChunk(t, qs, offset, t.file.slice(offset, Math.min(offset + CHUNK, t.size)));
        retries = 0;
        if (r.done) { t.finalName = r.name; break; }
        offset = r.offset;
      } catch (err) {
        if (t.cancelled || err.fatal || ++retries > MAX_RETRIES) throw err;
        t.retrying = retries;
        updateUploadItem(t);
        await sleep(1500 * retries);
        ({ offset } = await api(`/api/upload/status?${qs}`));
        t.retrying = 0;
      }
    }
    t.status = 'done';
    t.loaded = t.size;
  } catch (err) {
    if (t.cancelled) {
      t.status = 'cancelled';
      api(`/api/upload?${qs}`, { method: 'DELETE' }).catch(() => {});
    } else {
      t.status = 'error';
      t.error = err.message;
    }
  }
  updateUploadItem(t);
}

function sendChunk(t, qs, offset, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('PUT', `/api/upload?${qs}&offset=${offset}`);
    xhr.setRequestHeader('X-Requested-With', 'noir');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { t.loaded = offset + e.loaded; updateUploadItem(t); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* sin cuerpo */ }
      if (xhr.status === 200) return resolve(data);
      if (xhr.status === 409 && typeof data?.offset === 'number') return resolve({ offset: data.offset, done: false });
      if (xhr.status === 401) { showAuth(); return reject(Object.assign(new Error('Sesión expirada'), { fatal: true })); }
      const fatal = [400, 403, 413].includes(xhr.status);
      reject(Object.assign(new Error(data?.error || `Error ${xhr.status}`), { fatal }));
    };
    xhr.onerror = () => reject(new Error('Conexión interrumpida'));
    xhr.onabort = () => reject(new Error('cancelled'));
    xhr.send(blob);
  });
}

function buildUploadItem(t) {
  return h('li', { class: 'up-item' },
    typeBadge({ type: 'file', name: t.name }),
    h('div', { class: 'up-info' },
      h('div', { class: 'up-name', text: t.name, title: joinPath(t.dir, t.name) }),
      h('div', { class: 'up-meta' }),
      h('div', { class: 'up-progress' }, h('div'))),
    h('div', { class: 'up-state' }));
}

function updateUploadItem(t) {
  const el = t.el;
  const pct = t.size ? (t.loaded / t.size) * 100 : t.status === 'done' ? 100 : 0;
  el.className = `up-item ${t.status}`;
  $('.up-progress div', el).style.width = `${pct}%`;
  const meta = $('.up-meta', el);
  const stateEl = $('.up-state', el);
  stateEl.replaceChildren();

  if (t.status === 'queued') meta.textContent = `En cola · ${fmtSize(t.size)}`;
  else if (t.status === 'uploading') {
    const secs = (performance.now() - t.started) / 1000;
    const speed = secs > 0.5 ? (t.loaded - t.startBytes) / secs : 0;
    const eta = speed ? fmtEta((t.size - t.loaded) / speed) : '';
    meta.textContent = t.retrying
      ? `Reintentando (${t.retrying}/${MAX_RETRIES})…`
      : `${Math.floor(pct)}% · ${fmtSize(t.loaded)} de ${fmtSize(t.size)}${speed ? ` · ${fmtSize(speed)}/s` : ''}${eta ? ` · ${eta}` : ''}`;
  } else if (t.status === 'done') {
    meta.textContent = t.finalName && t.finalName !== t.name ? `Guardado como ${t.finalName}` : `${fmtSize(t.size)} · Completado`;
    stateEl.append(icon('check'));
  } else if (t.status === 'error') {
    meta.textContent = t.error;
    stateEl.append(h('button', { class: 'icon-btn sm', type: 'button', title: 'Reintentar', onclick: () => retryUpload(t) }, icon('refresh')));
  } else if (t.status === 'cancelled') meta.textContent = 'Cancelada';

  if (t.status === 'queued' || t.status === 'uploading') {
    stateEl.append(h('button', { class: 'icon-btn sm', type: 'button', title: 'Cancelar', onclick: () => cancelUpload(t) }, icon('close')));
  }
  updateUploadsHeader();
}

function cancelUpload(t) {
  t.cancelled = true;
  if (t.status === 'queued') { t.status = 'cancelled'; updateUploadItem(t); return; }
  t.xhr?.abort();
}

function retryUpload(t) {
  t.status = 'queued';
  t.cancelled = false;
  t.error = null;
  updateUploadItem(t);
  pump();
}

let headerFrame = 0;
function updateUploadsHeader() {
  if (headerFrame) return;
  headerFrame = requestAnimationFrame(() => {
    headerFrame = 0;
    const tasks = uploads.tasks.filter((t) => t.status !== 'cancelled');
    const pending = tasks.filter((t) => t.status === 'queued' || t.status === 'uploading').length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const failed = tasks.filter((t) => t.status === 'error').length;
    const total = tasks.reduce((s, t) => s + t.size, 0);
    const loaded = tasks.reduce((s, t) => s + (t.status === 'done' ? t.size : t.loaded), 0);
    $('#uploadsBarFill').style.width = `${total ? (loaded / total) * 100 : pending ? 0 : 100}%`;
    $('#uploadsTitle').textContent = pending
      ? `Subiendo ${plural(pending, 'archivo', 'archivos')}`
      : failed ? `${failed} ${failed === 1 ? 'subida falló' : 'subidas fallaron'}` : 'Subidas completadas';
    $('#uploadsSub').textContent = `${done} de ${tasks.length} · ${fmtSize(loaded)} de ${fmtSize(total)}`;
  });
}

$('#uploadsCollapse').addEventListener('click', () => $('#uploads').classList.toggle('collapsed'));
$('#uploadsClose').addEventListener('click', () => {
  const pending = uploads.tasks.some((t) => t.status === 'queued' || t.status === 'uploading');
  if (pending) return $('#uploads').classList.add('collapsed');
  uploads.tasks = [];
  $('#uploadsList').replaceChildren();
  $('#uploads').hidden = true;
});

window.addEventListener('beforeunload', (e) => {
  if (uploads.tasks.some((t) => t.status === 'uploading' || t.status === 'queued')) e.preventDefault();
});

$('#fileInput').addEventListener('change', (e) => {
  enqueue([...e.target.files].map((file) => ({ file, rel: '' })));
  e.target.value = '';
});
$('#folderInput').addEventListener('change', (e) => {
  enqueue([...e.target.files].map((file) => {
    const parts = (file.webkitRelativePath || file.name).split('/');
    return { file, rel: parts.slice(0, -1).join('/') };
  }));
  e.target.value = '';
});

// Arrastrar y soltar archivos desde el equipo (incluye carpetas)
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const canDrop = () => state.me && can('editor') && (state.view === 'files' || (state.view === 'db' && !state.sub));

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !canDrop()) return;
  e.preventDefault();
  dragDepth++;
  if (state.view === 'db') $('#dropTarget').textContent = 'en Bases de datos';
  $('#dropzone').hidden = false;
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; }
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  if (!canDrop()) return;
  if (state.view === 'db') return enqueue([...e.dataTransfer.files].map((file) => ({ file, rel: '' })), { area: 'db' });
  const entries = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const fallback = [...e.dataTransfer.files];
  try {
    enqueue(entries.length ? await collectEntries(entries) : fallback.map((file) => ({ file, rel: '' })));
  } catch (err) { reportError(err); }
});

async function collectEntries(entries) {
  const out = [];
  async function walk(entry, rel) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const childRel = joinPath(rel, entry.name);
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, childRel);
      }
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

// ───────────────────────── Teclado ─────────────────────────

document.addEventListener('keydown', (e) => {
  if (!state.me || $('#app').hidden || $('#dialog').open || !$('#menu').hidden) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox';

  if (!$('#preview').hidden) {
    if (e.key === 'Escape') closePreview();
    else if (e.key === 'ArrowLeft') stepPreview(-1);
    else if (e.key === 'ArrowRight') stepPreview(1);
    return;
  }
  if (typing) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  const fileView = state.view === 'files' || state.view === 'search';
  if (e.key === '/' && fileView) { e.preventDefault(); $('#search')?.focus(); }
  else if (!fileView) return;
  else if (e.key === 'Escape' && state.selected.size) { state.selected.clear(); renderFilesToolbar(); renderFileList(); }
  else if (e.key === 'Delete' && state.selected.size && can('editor')) deleteItems(selectedItems());
  else if (e.key === 'F2' && state.selected.size === 1 && can('editor')) renameItem(selectedItems()[0]);
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    for (const i of visibleItems()) state.selected.add(i.path);
    renderFilesToolbar();
    renderFileList();
  } else if (e.key === 'Backspace' && state.view === 'files' && state.path) navigate(parentOf(state.path));
});

// ───────────────────────── Inicio ─────────────────────────

// Espera a que carguen todos los scripts (modules.js registra vistas adicionales).
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const s = await api('/api/session', { allow401: true });
    setStudio(s.studio);
    if (s.authenticated) enterApp(s.user);
    else showAuth();
  } catch {
    showAuth();
  }
});
