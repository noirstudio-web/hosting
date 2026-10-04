'use strict';
/* Noir Studio · Vistas de desarrollo y administración: código, bases de datos y códigos de acceso. */

const publicBase = () => window.NOIR_PAGES?.replace(/\/$/, '') || state.settings?.publicUrl || location.origin;
const segHash = (...parts) => parts.flatMap((p) => String(p || '').split('/')).filter(Boolean).map(encodeURIComponent).join('/');

function tabs(items, active, onSelect) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map(([id, label, ic]) => h('button', {
    type: 'button', role: 'tab', class: `tab${id === active ? ' active' : ''}`, 'aria-selected': String(id === active),
    onclick: () => onSelect(id),
  }, ic && icon(ic), label)));
}

function dataGrid(columns, rows) {
  if (!columns.length) return h('div', { class: 'grid-empty', text: 'La consulta no devolvió columnas.' });
  return h('div', { class: 'grid-wrap' }, h('table', { class: 'data-grid' },
    h('thead', {}, h('tr', {}, h('th', { class: 'rownum', text: '#' }), columns.map((c) => h('th', { text: c, title: c })))),
    h('tbody', {}, rows.length
      ? rows.map((r, i) => h('tr', {}, h('td', { class: 'rownum', text: String(i + 1) }), r.map((v) => {
        if (v === null) return h('td', { class: 'null', text: 'NULL' });
        const isNum = typeof v === 'number';
        return h('td', { class: isNum ? 'num' : '', text: String(v), title: String(v).length > 60 ? String(v) : null });
      })))
      : h('tr', {}, h('td', { class: 'grid-empty', colspan: String(columns.length + 1), text: 'Sin filas' })))));
}

function codeBlock(text, lang) {
  const lines = text.split('\n').length;
  const gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' });
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  const code = h('code');
  code.append(highlight(text, lang));
  return h('div', { class: 'code-view' }, gutter, h('pre', { class: 'code-pre' }, code));
}

// ═════════════════════════ Códigos de acceso ═════════════════════════

const inviteLink = (code) => `${publicBase()}/#/invite/${code}`;

function inviteMessage(inv) {
  return `Te invito a ${state.studio}. Crea tu cuenta aquí: ${inviteLink(inv.code)}\n(o entra en ${publicBase()} y usa el código ${inv.code})`;
}

function showInvite(inv) {
  const body = h('div', { class: 'invite-show' },
    h('div', { class: 'invite-code', text: inv.code }),
    h('div', { class: 'invite-meta', text: [ROLE_LABEL[inv.role], inv.expiresAt ? `caduca ${timeAgo(inv.expiresAt).toLowerCase()}` : 'sin caducidad', inv.maxUses ? plural(inv.maxUses, 'uso', 'usos') : 'usos ilimitados'].join(' · ') }),
    h('div', { class: 'copy-row' }, h('input', { type: 'text', readonly: true, class: 'mono-input', value: inviteLink(inv.code), onfocus: (e) => e.target.select() }),
      h('button', { class: 'btn', type: 'button', onclick: () => copyText(inviteLink(inv.code)) }, icon('copy'), 'Enlace')),
    h('div', { class: 'panel-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => copyText(inv.code) }, icon('ticket'), 'Copiar código'),
      h('button', { class: 'btn', type: 'button', onclick: () => copyText(inviteMessage(inv)) }, icon('copy'), 'Copiar mensaje de invitación')));
  openDialog({ title: 'Código de acceso listo', message: 'Compártelo con la persona que quieras invitar. Con él creará su propia cuenta.', body, confirm: 'Listo', cancel: null });
}

function inviteDialog() {
  const role = roleSelect('editor');
  const desc = h('small', { class: 'field-hint', text: ROLE_DESC.editor });
  role.addEventListener('change', () => { desc.textContent = ROLE_DESC[role.value]; });
  const hours = h('select', {}, ...[['24', '1 día'], ['168', '7 días'], ['720', '30 días'], ['0', 'Sin caducidad']].map(([v, t]) => h('option', { value: v, text: t })));
  hours.value = '168';
  const uses = h('input', { type: 'number', min: '0', step: '1', value: '1' });
  const note = h('input', { type: 'text', maxlength: '80', placeholder: 'Ej.: Para Carlos (mezcla)' });
  const body = h('div', { class: 'dform' },
    h('label', { class: 'dfield' }, h('span', { class: 'dfield-label', text: 'Rol de la nueva cuenta' }), role, desc),
    h('div', { class: 'dform-row' }, field('Válido durante', hours), field('Número de usos', uses, '0 = ilimitado')),
    field('Nota (opcional)', note));
  openDialog({
    title: 'Generar código de acceso', body, confirm: 'Generar código',
    onConfirm: async () => (await api('/api/invites', { method: 'POST', json: { role: role.value, hours: Number(hours.value), uses: Number(uses.value), note: note.value } })).invite,
  }).then((inv) => { if (inv) { showInvite(inv); refresh(); } });
}

async function renderInvitesView() {
  setHeader(heading('Códigos de acceso', 'Invita a personas a crear su propia cuenta'), [
    h('button', { class: 'btn btn-primary', type: 'button', onclick: inviteDialog }, icon('plus'), h('span', { text: 'Generar código' })),
  ], null);
  setLoading(true);
  try {
    const { items } = await api('/api/invites');
    if (state.view !== 'invites') return;
    const steps = h('div', { class: 'steps-strip' },
      ...[['ticket', 'Genera un código', 'Elige el rol, cuánto dura y cuántas veces se puede usar.'],
        ['share', 'Compártelo', 'Envía el código o el enlace de invitación.'],
        ['user', 'La persona crea su cuenta', 'Entra, pulsa “Tengo un código” y elige usuario y contraseña.']]
        .map(([ic, t, d], i) => h('div', { class: 'step-card' }, h('span', { class: 'step-num', text: String(i + 1) }), h('div', {}, h('strong', {}, icon(ic), t), h('span', { text: d })))));
    if (!items.length) return setContent(steps, emptyState('ticket', 'Aún no hay códigos', 'Genera un código para que alguien pueda crear su cuenta.', h('button', { class: 'btn btn-primary', type: 'button', onclick: inviteDialog }, icon('plus'), 'Generar código')));
    const rows = items.map((inv) => {
      const exhausted = inv.maxUses && inv.uses >= inv.maxUses;
      const status = inv.active ? ['ok', 'Activo'] : exhausted ? ['muted', 'Agotado'] : ['muted', 'Caducado'];
      return h('tr', {},
        h('td', {}, h('div', { class: 'name-stack' }, h('span', { class: 'invite-inline', text: inv.code }), h('small', { text: inv.note || `Creado ${timeAgo(inv.createdAt).toLowerCase()} por ${inv.createdBy}` }))),
        h('td', { class: 'col-role' }, h('span', { class: 'badge', text: ROLE_LABEL[inv.role] })),
        h('td', { class: 'col-status' }, h('span', { class: `badge ${status[0]}`, text: status[1] })),
        h('td', { class: 'col-num hide-mobile', title: inv.usedBy.map((u) => u.username).join(', ') || null, text: `${inv.uses} / ${inv.maxUses || '∞'}` }),
        h('td', { class: 'col-date hide-mobile', text: inv.expiresAt ? timeAgo(inv.expiresAt) : 'Sin caducidad' }),
        h('td', { class: 'col-actions' }, h('div', { class: 'row-actions visible' },
          inv.active && h('button', { class: 'icon-btn', type: 'button', title: 'Ver y compartir', onclick: () => showInvite(inv) }, icon('share')),
          inv.active && h('button', { class: 'icon-btn hide-mobile', type: 'button', title: 'Copiar código', onclick: () => copyText(inv.code) }, icon('copy')),
          h('button', {
            class: 'icon-btn danger', type: 'button', title: 'Revocar código',
            onclick: async () => {
              if (!(await confirmDanger(`¿Revocar el código ${inv.code}?`, 'Ya no se podrá usar para crear cuentas. Las cuentas creadas con él no se ven afectadas.', 'Revocar'))) return;
              try { await api(`/api/invites/${encodeURIComponent(inv.code)}`, { method: 'DELETE' }); toast('Código revocado'); refresh(); } catch (err) { reportError(err); }
            },
          }, icon('trash')))));
    });
    setContent(steps, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Código' }), h('th', { class: 'col-role', text: 'Rol' }), h('th', { class: 'col-status', text: 'Estado' }), h('th', { class: 'col-num hide-mobile', text: 'Usos' }), h('th', { class: 'col-date hide-mobile', text: 'Caducidad' }), h('th', { class: 'col-actions' }))),
      h('tbody', {}, rows)));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

// ═════════════════════════ Código ═════════════════════════

const codeCache = {}; // id -> { children: Map(path -> items), expanded: Set }

// Al subir un proyecto no se envían dependencias, cachés ni archivos de claves.
const PROJECT_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.idea', '.vs', '.gradle', '.parcel-cache', '.turbo']);
const PROJECT_SECRET = /^(\.env(\..+)?|.+\.(pem|key|pfx|p12|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

// entries: [{ file, rel }] donde rel es la carpeta del archivo incluyendo la carpeta raíz elegida.
function prepareProjectFiles(entries) {
  const top = (entries.find((e) => e.rel)?.rel || '').split('/')[0];
  const list = [];
  let skipped = 0;
  for (const { file, rel } of entries) {
    const inner = top && (rel === top || rel.startsWith(`${top}/`)) ? rel.slice(top.length + 1) : rel;
    const parts = [...inner.split('/').filter(Boolean), file.name];
    if (parts.some((p) => PROJECT_SKIP_DIRS.has(p)) || PROJECT_SECRET.test(file.name)) { skipped++; continue; }
    list.push({ file, rel: inner });
  }
  return { top, list, skipped };
}

function pickFolder() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true });
    input.addEventListener('change', () => {
      resolve([...input.files].map((file) => ({ file, rel: (file.webkitRelativePath || file.name).split('/').slice(0, -1).join('/') })));
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

async function uploadProjectFolder(entries, existing = null) {
  if (!entries?.length) return;
  const { top, list, skipped } = prepareProjectFiles(entries);
  if (!list.length) return toast('La carpeta no tiene archivos para subir (solo dependencias o claves)', 'error');
  const size = list.reduce((s, e) => s + e.file.size, 0);
  const summary = `${plural(list.length, 'archivo', 'archivos')} · ${fmtSize(size)}${skipped ? ` · ${skipped} omitidos (dependencias, .git o claves)` : ''}`;
  let project = existing;
  if (existing) {
    if (!(await openDialog({ title: `¿Actualizar «${existing.name}»?`, message: `Se reemplazarán sus archivos por los de la carpeta elegida (${summary}).`, confirm: 'Actualizar' }))) return;
    await api(`/api/projects/${existing.id}/clear`, { method: 'POST' });
  } else {
    const name = h('input', { type: 'text', required: true, maxlength: '60', value: top || 'Proyecto' });
    project = await openDialog({
      title: 'Subir proyecto', message: summary,
      body: field('Nombre del proyecto', name), confirm: 'Subir',
      onConfirm: async () => (await api('/api/projects/upload', { method: 'POST', json: { name: name.value.trim() } })).project,
    });
    if (!project) return;
  }
  delete codeCache[project.id];
  const tasks = enqueue(list, { area: 'project', project: project.id });
  toast(`Subiendo ${plural(list.length, 'archivo', 'archivos')} de «${project.name}»…`);
  const wait = setInterval(async () => {
    if (tasks.some((t) => t.status === 'queued' || t.status === 'uploading')) return;
    clearInterval(wait);
    const done = tasks.filter((t) => t.status === 'done').length;
    try { await api(`/api/projects/${project.id}/uploaded`, { method: 'POST', json: { files: done, skipped } }); } catch { /* no crítico */ }
    delete codeCache[project.id];
    toast(done === tasks.length ? `Proyecto «${project.name}» listo` : `«${project.name}»: ${done} de ${tasks.length} archivos subidos`, done === tasks.length ? 'ok' : 'error');
    if (location.hash === `#/code/${project.id}`) refresh(); else location.hash = `#/code/${project.id}`;
  }, 1000);
}

// Soltar una carpeta en Código (lo llama app.js): en la lista crea un proyecto; dentro de uno propio lo actualiza.
function codeDrop(entries) {
  const id = state.sub ? state.sub.split('/')[0] : null;
  if (!id) return uploadProjectFolder(entries);
  const p = codeCache[id]?.info?.project;
  if (!p || p.kind !== 'upload') return toast('Este proyecto no se puede actualizar arrastrando', 'error');
  if (!p.canManage) return toast(`Solo ${p.createdBy} o un administrador pueden actualizar este proyecto`, 'error');
  uploadProjectFolder(entries, p);
}

function codeDropZone(title, text) {
  return h('div', { class: 'code-drop' }, h('span', { class: 'code-drop-icon' }, icon('upload')), h('strong', { text: title }), h('span', { text }));
}

function projectDialog() {
  const name = h('input', { type: 'text', required: true, maxlength: '60', placeholder: 'Mi app' });
  const dir = h('input', { type: 'text', required: true, spellcheck: 'false', placeholder: 'C:\\Users\\Usuario\\Desktop\\mi-app', class: 'mono-input' });
  const exclude = h('input', { type: 'text', spellcheck: 'false', placeholder: 'dist, build, .env.local' });
  openDialog({
    title: 'Añadir proyecto', wide: true,
    message: 'Elige una carpeta de este equipo. Se mostrará en solo lectura; las dependencias, .git y los archivos de claves (.env, .pem…) se ocultan siempre.',
    body: h('div', { class: 'dform' }, field('Nombre', name), field('Ruta de la carpeta', dir, 'Copia la ruta desde la barra del Explorador de Windows.'), field('Excluir (opcional)', exclude, 'Carpetas o archivos separados por comas, relativos al proyecto.')),
    confirm: 'Añadir proyecto',
    onConfirm: async () => {
      const r = await api('/api/projects', { method: 'POST', json: { name: name.value, path: dir.value, exclude: exclude.value } });
      toast(`Proyecto “${r.project.name}” añadido`);
      location.hash = `#/code/${r.project.id}`;
    },
  });
}

async function renderCodeView() {
  const [id, ...rest] = state.sub ? state.sub.split('/') : [];
  if (!id) return renderProjectList();
  return renderProject(id, rest.join('/'));
}

const pathProjectBtn = () => h('button', { class: 'btn', type: 'button', onclick: projectDialog, title: 'Mostrar una carpeta que ya está en el PC servidor' }, icon('folder'), h('span', { text: 'Carpeta del servidor' }));

async function renderProjectList() {
  setHeader(heading('Código', 'Proyectos del equipo'), can('admin') ? [pathProjectBtn()] : [], null);
  setLoading(true);
  try {
    const { items } = await api('/api/projects');
    if (state.view !== 'code') return;
    const zone = codeDropZone('Arrastra aquí la carpeta de tu proyecto', 'Se sube al hosting sin node_modules, .git ni archivos de claves. Para actualizarlo después, arrastra la carpeta dentro del proyecto.');
    if (!items.length) return setContent(zone);
    setContent(zone, h('div', { class: 'project-grid' }, items.map((p) => h('a', { class: `project-card${p.exists ? '' : ' missing'}`, href: `#/code/${p.id}` },
      h('div', { class: 'project-top' }, h('span', { class: 'ftype code' }, icon('code')),
        p.kind === 'upload' ? h('span', { class: 'badge', title: 'Subido al hosting' }, icon('upload'), 'Subido') : p.branch && h('span', { class: 'badge' }, icon('branch'), p.branch)),
      h('strong', { text: p.name }),
      h('span', { class: 'project-path', text: p.kind === 'upload' ? `${p.createdBy} · ${timeAgo(p.updatedAt || p.createdAt).toLowerCase()}` : p.path, title: p.path || '' }),
      !p.exists && h('span', { class: 'badge muted', text: p.kind === 'upload' ? 'Sin archivos' : 'Carpeta no encontrada' })))));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

async function loadChildren(id, dir) {
  const c = codeCache[id];
  if (!c.children.has(dir)) c.children.set(dir, (await api(`/api/projects/${id}/tree?path=${encodeURIComponent(dir)}`)).items);
  return c.children.get(dir);
}

async function renderProject(id, filePath) {
  codeCache[id] ||= { children: new Map(), expanded: new Set(), info: null, search: '' };
  const c = codeCache[id];
  const parts = filePath ? filePath.split('/') : [];
  for (let i = 1; i < parts.length; i++) c.expanded.add(parts.slice(0, i).join('/'));

  const searchInput = h('input', { type: 'search', placeholder: 'Buscar archivo… (Enter)', value: c.search });
  const inContent = h('input', { type: 'checkbox', class: 'check' });
  const runSearch = () => { c.search = searchInput.value.trim(); if (c.search.length >= 2) showSearch(id, c.search, inContent.checked); };
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  const tree = h('nav', { class: 'tree', 'aria-label': 'Archivos del proyecto' });
  const viewer = h('section', { class: 'viewer' }, h('div', { class: 'viewer-loading' }, h('span', { class: 'spinner' })));
  setContent(h('div', { class: 'code-layout' }, h('aside', { class: 'tree-pane' }, tree), viewer));

  setLoading(true);
  try {
    c.info ||= await api(`/api/projects/${id}`);
    if (state.view !== 'code') return;
    const p = c.info.project;
    const crumbs = h('nav', { class: 'crumbs-nav' },
      h('a', { class: 'crumb', href: '#/code', text: 'Código' }), icon('chevron', 'crumb-sep'),
      h('a', { class: `crumb${parts.length ? '' : ' current'}`, href: `#/code/${id}`, text: p.name }),
      ...parts.flatMap((s, i) => [icon('chevron', 'crumb-sep'), h('a', { class: `crumb${i === parts.length - 1 ? ' current' : ''}`, href: `#/code/${id}/${segHash(parts.slice(0, i + 1).join('/'))}`, text: s })]));
    setHeader(crumbs, [
      h('label', { class: 'search' }, icon('search'), searchInput, h('label', { class: 'search-opt', title: 'Buscar también dentro de los archivos' }, inContent, h('span', { text: 'contenido' }))),
      h('a', { class: 'btn', href: link(`/api/projects/${id}/zip`), download: '', title: 'Descargar el proyecto en ZIP' }, icon('download'), h('span', { text: 'ZIP' })),
      p.canManage && h('button', {
        class: 'icon-btn', type: 'button', title: p.kind === 'upload' ? 'Eliminar proyecto' : 'Quitar proyecto de la lista',
        onclick: async () => {
          const msg = p.kind === 'upload' ? 'Se borrarán sus archivos del hosting. Tu carpeta original no se toca.' : 'Solo se quita de la lista. La carpeta y sus archivos no se tocan.';
          if (!(await confirmDanger(`¿${p.kind === 'upload' ? 'Eliminar' : 'Quitar'} “${p.name}”?`, msg, p.kind === 'upload' ? 'Eliminar' : 'Quitar'))) return;
          try { await api(`/api/projects/${id}`, { method: 'DELETE' }); delete codeCache[id]; toast('Proyecto quitado'); location.hash = '#/code'; } catch (err) { reportError(err); }
        },
      }, icon('trash')),
    ], null);
    await renderTree(id, tree, filePath);
    if (filePath) await showFile(id, filePath, viewer);
    else showOverview(c.info, viewer, id);
  } catch (err) {
    reportError(err);
    viewer.replaceChildren(emptyState('alert', 'No se pudo abrir', err.message));
  } finally {
    setLoading(false);
  }
}

async function renderTree(id, el, active) {
  const c = codeCache[id];
  async function branch(dir, depth) {
    const items = await loadChildren(id, dir);
    const ul = h('ul', { class: 'tree-list' });
    for (const it of items) {
      const open = c.expanded.has(it.path);
      const row = h('a', {
        class: `tree-row${it.path === active ? ' active' : ''}`,
        href: it.type === 'file' ? `#/code/${id}/${segHash(it.path)}` : null,
        style: null,
        title: it.name,
        onclick: it.type === 'dir' ? async (e) => {
          e.preventDefault();
          open ? c.expanded.delete(it.path) : c.expanded.add(it.path);
          await renderTree(id, el, active);
        } : null,
      },
      it.type === 'dir' ? icon(open ? 'chevron' : 'chevron', `tree-caret${open ? ' open' : ''}`) : h('span', { class: 'tree-caret-space' }),
      icon(it.type === 'dir' ? 'folder' : GROUP_ICON[kindOf(it)] || 'file', `tree-icon ${it.type === 'dir' ? 'dir' : kindOf(it)}`),
      h('span', { class: 'tree-name', text: it.name }));
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const li = h('li', {}, row);
      if (it.type === 'dir' && open) li.append(await branch(it.path, depth + 1));
      ul.append(li);
    }
    if (!items.length && depth === 0) ul.append(h('li', { class: 'tree-empty', text: 'Carpeta vacía' }));
    return ul;
  }
  const scroll = el.parentElement?.scrollTop || 0;
  el.replaceChildren(await branch('', 0));
  if (el.parentElement) el.parentElement.scrollTop = scroll;
}

function showOverview(info, viewer, id) {
  const { project, stats, git } = info;
  const langs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]);
  const top = langs.slice(0, 8);
  const maxCount = top[0]?.[1] || 1;
  const readme = codeCache[id].children.get('')?.find((i) => /^readme(\.md|\.txt)?$/i.test(i.name));
  const body = h('div', { class: 'overview' },
    project.kind === 'upload' && project.canManage && h('div', { class: 'code-drop small' }, h('span', { class: 'code-drop-icon' }, icon('refresh')),
      h('strong', { text: 'Para actualizar este proyecto, arrastra aquí su carpeta' }), h('span', { text: 'Se reemplazan sus archivos por los de la carpeta nueva.' })),
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat' }, h('strong', { text: stats.files.toLocaleString('es') + (stats.truncated ? '+' : '') }), h('span', { text: 'archivos' })),
      h('div', { class: 'stat' }, h('strong', { text: fmtSize(stats.size) }), h('span', { text: 'tamaño' })),
      h('div', { class: 'stat' }, h('strong', { text: stats.lastModified ? timeAgo(stats.lastModified) : '—' }), h('span', { text: 'último cambio' })),
      h('div', { class: 'stat' }, h('strong', { text: git?.branch || '—' }), h('span', { text: 'rama Git' }))),
    h('div', { class: 'overview-cols' },
      card('Tipos de archivo', 'pie', h('div', { class: 'lang-bars' }, top.map(([ext, n]) => {
        const bar = h('span', { class: 'lang-fill' });
        bar.style.width = `${(n / maxCount) * 100}%`;
        return h('div', { class: 'lang-row' }, h('span', { class: 'mono', text: `.${ext}`.replace('.(sin ext.)', 'sin extensión') }), h('div', { class: 'lang-bar' }, bar), h('span', { class: 'muted', text: String(n) }));
      }))),
      card('Últimos cambios (Git)', 'branch', git?.commits?.length
        ? h('ul', { class: 'commits' }, git.commits.map((cm) => h('li', {}, h('span', { class: 'mono commit-hash', text: cm.hash }), h('div', { class: 'name-stack' }, h('span', { text: cm.subject }), h('small', { text: `${cm.author} · ${timeAgo(cm.at)}` })))))
        : h('p', { class: 'panel-note', text: git ? 'Sin commits todavía.' : 'Este proyecto no usa Git.' }))),
    h('p', { class: 'panel-note mono', text: project.kind === 'upload' ? `Subido al hosting · actualizado ${timeAgo(project.updatedAt || project.createdAt).toLowerCase()}` : project.path }));
  viewer.replaceChildren(body);
  if (readme) {
    api(`/api/projects/${id}/file?path=${encodeURIComponent(readme.path)}`).then((f) => {
      if (f.text && viewer.isConnected) body.append(h('div', { class: 'file-card' }, h('header', { class: 'file-head' }, icon('doc'), h('strong', { text: readme.name })), codeBlock(f.text, 'md')));
    }).catch(() => {});
  }
}

async function showFile(id, filePath, viewer) {
  const f = await api(`/api/projects/${id}/file?path=${encodeURIComponent(filePath)}`);
  const raw = link(`/api/projects/${id}/raw?path=${encodeURIComponent(filePath)}`);
  const lang = hlLangFor(f.name);
  const head = h('header', { class: 'file-head' },
    icon(GROUP_ICON[kindOf({ type: 'file', name: f.name })] || 'file'),
    h('div', { class: 'name-stack' }, h('strong', { text: f.name }),
      h('small', { text: [fmtSize(f.size), f.lines ? plural(f.lines, 'línea', 'líneas') : null, lang ? HL_LANG_LABEL[lang] : null, `modificado ${timeAgo(f.mtime).toLowerCase()}`].filter(Boolean).join(' · ') })),
    h('div', { class: 'file-actions' },
      f.text != null && h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(f.text) }, icon('copy'), h('span', { class: 'hide-mobile', text: 'Copiar' })),
      h('a', { class: 'btn btn-sm', href: raw, target: '_blank', rel: 'noopener', title: 'Abrir sin formato' }, icon('external'), h('span', { class: 'hide-mobile', text: 'Raw' })),
      h('a', { class: 'btn btn-sm', href: `${raw}&dl=1`, download: '' }, icon('download'))));
  let body;
  if (f.text != null) body = codeBlock(f.text, lang);
  else if (kindOf({ type: 'file', name: f.name }) === 'image') body = h('div', { class: 'file-image' }, h('img', { src: raw, alt: f.name }));
  else body = emptyState('file', f.tooLarge ? 'Archivo demasiado grande' : 'Archivo binario', f.tooLarge ? 'Supera los 2 MB; descárgalo para verlo.' : 'No es un archivo de texto; descárgalo para abrirlo.', h('a', { class: 'btn btn-primary', href: `${raw}&dl=1`, download: '' }, icon('download'), 'Descargar'));
  viewer.replaceChildren(h('div', { class: 'file-card' }, head, body));
}

async function showSearch(id, q, inContent) {
  const viewer = $('.viewer');
  if (!viewer) return;
  viewer.replaceChildren(h('div', { class: 'viewer-loading' }, h('span', { class: 'spinner' })));
  try {
    const { results, truncated } = await api(`/api/projects/${id}/search?q=${encodeURIComponent(q)}${inContent ? '&content=1' : ''}`);
    viewer.replaceChildren(h('div', { class: 'file-card' },
      h('header', { class: 'file-head' }, icon('search'), h('div', { class: 'name-stack' }, h('strong', { text: `Resultados para “${q}”` }), h('small', { text: `${plural(results.length, 'archivo', 'archivos')}${truncated ? ' (primeros 200)' : ''}${inContent ? ' · en el contenido' : ' · en nombres'}` }))),
      results.length
        ? h('ul', { class: 'search-results' }, results.map((r) => h('li', {},
          h('a', { class: 'result-path', href: `#/code/${id}/${segHash(r.path)}` }, icon(GROUP_ICON[kindOf({ type: 'file', name: r.path })] || 'file'), h('span', { text: r.path })),
          r.matches && h('ul', { class: 'result-lines' }, r.matches.map((m) => h('li', {}, h('span', { class: 'mono muted', text: String(m.line) }), h('code', { text: m.text })))))))
        : h('div', { class: 'grid-empty', text: 'No se encontró nada.' })));
  } catch (err) {
    reportError(err);
  }
}

// ═════════════════════════ Bases de datos ═════════════════════════

const DB_TYPE = { sqlite: ['SQLite', 'database'], sql: ['Volcado SQL', 'code'], csv: ['CSV', 'table'], json: ['JSON', 'code'], other: ['Archivo', 'file'] };
const dbUi = { tab: {}, table: {}, offset: 0, query: {} };

const DB_EXT = /\.(db|sqlite|sqlite3|db3|sql|csv|tsv|json|dump|bak)$/i;
const DB_ACCEPT = '.db,.sqlite,.sqlite3,.db3,.sql,.csv,.tsv,.json,.dump,.bak';

// Nueva versión de una base concreta (un solo archivo, se guarda con el nombre de esa base).
function pickDbFile(targetName) {
  const input = h('input', { type: 'file' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    if (file.name !== targetName) toast(`Se guardará como nueva versión de “${targetName}”`);
    enqueue([{ file, rel: '', name: targetName }], { area: 'db' });
  });
  input.click();
}

function pickDbFiles() {
  const input = h('input', { type: 'file', multiple: true, accept: DB_ACCEPT });
  input.addEventListener('change', () => uploadDbEntries([...input.files].map((file) => ({ file, rel: '' }))));
  input.click();
}

// Sube varias bases a la vez (archivos sueltos o el contenido de una carpeta, incluidas subcarpetas).
async function uploadDbEntries(entries) {
  if (!entries?.length) return;
  const valid = entries.filter((e) => DB_EXT.test(e.file.name));
  const skipped = entries.length - valid.length;
  if (!valid.length) return toast('No hay archivos de base de datos (.db, .sqlite, .sql, .csv, .json…) en lo que elegiste', 'error');
  // Si dos archivos se llaman igual en subcarpetas distintas, se distinguen con el nombre de su carpeta.
  const counts = {};
  for (const e of valid) counts[e.file.name.toLowerCase()] = (counts[e.file.name.toLowerCase()] || 0) + 1;
  const list = valid.map((e) => {
    const parent = e.rel.split('/').filter(Boolean).pop();
    const name = counts[e.file.name.toLowerCase()] > 1 && parent ? `${parent}_${e.file.name}` : e.file.name;
    return { file: e.file, rel: '', name: name.replace(/[\\/:*?"<>|]/g, '_') };
  });
  if (list.length > 1 || skipped) {
    const size = list.reduce((s, e) => s + e.file.size, 0);
    const ok = await openDialog({
      title: `¿Subir ${plural(list.length, 'base de datos', 'bases de datos')}?`,
      message: `${list.map((e) => e.name).slice(0, 6).join(', ')}${list.length > 6 ? '…' : ''} · ${fmtSize(size)}${skipped ? ` · ${plural(skipped, 'archivo omitido', 'archivos omitidos')} (no son bases de datos)` : ''}. Si alguna ya existe, la anterior se guarda en su historial.`,
      confirm: 'Subir',
    });
    if (!ok) return;
  }
  enqueue(list, { area: 'db' });
}

// Soltar archivos o carpetas en la lista de bases de datos (lo llama app.js).
function dbDrop(entries) {
  uploadDbEntries(entries);
}

const dbFolderBtn = (cls = 'btn btn-primary') => h('button', { class: cls, type: 'button', onclick: async () => uploadDbEntries(await pickFolder()) }, icon('upload'), h('span', { text: 'Subir carpeta' }));
const dbFilesBtn = (cls = 'btn') => h('button', { class: cls, type: 'button', onclick: pickDbFiles }, icon('file'), h('span', { text: 'Subir archivos' }));

async function renderDbView() {
  if (state.sub) return renderDbDetail(state.sub);
  setHeader(heading('Bases de datos', 'SQLite, volcados SQL, CSV y JSON con historial de versiones'), [dbFilesBtn(), dbFolderBtn()], null);
  setLoading(true);
  try {
    const { items, sqlite } = await api('/api/databases');
    if (state.view !== 'db' || state.sub) return;
    const note = !sqlite && h('p', { class: 'panel-note', text: 'Aviso: esta versión de Node.js no incluye SQLite; las bases .db se guardan pero no se pueden explorar.' });
    if (!items.length) {
      return setContent(note, emptyState('database', 'No hay bases de datos', 'Sube archivos .db / .sqlite, volcados .sql, CSV o JSON, o una carpeta entera (o arrástrala aquí). Si subes otro con el mismo nombre, la versión anterior se guarda en el historial.',
        h('div', { class: 'empty-actions' }, dbFolderBtn(), dbFilesBtn())));
    }
    const rows = items.map((d) => h('tr', { onclick: () => { location.hash = `#/db/${encodeURIComponent(d.name)}`; } },
      h('td', {}, h('div', { class: 'name-cell' }, h('span', { class: `ftype db-${d.type}` }, icon(DB_TYPE[d.type][1])), h('div', { class: 'name-stack' }, h('span', { class: 'name', text: d.name }), h('small', { text: DB_TYPE[d.type][0] })))),
      h('td', { class: 'col-size', text: fmtSize(d.size) }),
      h('td', { class: 'col-date hide-mobile', text: timeAgo(d.mtime) }),
      h('td', { class: 'col-num hide-mobile', text: d.versions ? plural(d.versions, 'versión', 'versiones') : '—' }),
      h('td', { class: 'col-actions' }, h('div', { class: 'row-actions visible' },
        h('a', { class: 'icon-btn', href: link(`/api/databases/${encodeURIComponent(d.name)}/file`), download: '', title: 'Descargar', onclick: (e) => e.stopPropagation() }, icon('download')),
        h('button', { class: 'icon-btn danger', type: 'button', title: 'Eliminar', onclick: (e) => { e.stopPropagation(); deleteDb(d.name); } }, icon('trash'))))));
    setContent(note, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Base de datos' }), h('th', { class: 'col-size', text: 'Tamaño' }), h('th', { class: 'col-date hide-mobile', text: 'Actualizada' }), h('th', { class: 'col-num hide-mobile', text: 'Historial' }), h('th', { class: 'col-actions' }))),
      h('tbody', {}, rows)));
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

async function deleteDb(name) {
  if (!(await confirmDanger(`¿Eliminar “${name}”?`, 'Se borrarán el archivo y todo su historial de versiones. No se puede deshacer.'))) return;
  try {
    await api(`/api/databases/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast('Base de datos eliminada');
    location.hash = '#/db';
    if (!state.sub) refresh();
  } catch (err) { reportError(err); }
}

async function renderDbDetail(name) {
  const enc = encodeURIComponent(name);
  setHeader(h('nav', { class: 'crumbs-nav' }, h('a', { class: 'crumb', href: '#/db', text: 'Bases de datos' }), icon('chevron', 'crumb-sep'), h('span', { class: 'crumb current', text: name })), [
    h('button', { class: 'btn', type: 'button', onclick: () => pickDbFile(name), title: 'Sube un archivo para reemplazarla; la actual pasa al historial' }, icon('upload'), h('span', { text: 'Nueva versión' })),
    h('a', { class: 'btn', href: link(`/api/databases/${enc}/file`), download: '' }, icon('download'), h('span', { text: 'Descargar' })),
    h('button', { class: 'icon-btn', type: 'button', title: 'Eliminar', onclick: () => deleteDb(name) }, icon('trash')),
  ], null);
  setLoading(true);
  try {
    const info = await api(`/api/databases/${enc}/inspect`);
    if (state.view !== 'db' || state.sub !== name) return;
    const available = {
      sqlite: [['tables', 'Tablas', 'table'], ['query', 'Consulta SQL', 'play'], ['versions', 'Versiones', 'history']],
      sql: [['content', 'Contenido', 'code'], ['versions', 'Versiones', 'history']],
      json: [['content', 'Contenido', 'code'], ['versions', 'Versiones', 'history']],
      csv: [['preview', 'Vista previa', 'table'], ['versions', 'Versiones', 'history']],
      other: [['versions', 'Versiones', 'history']],
    }[info.type];
    let tab = dbUi.tab[name];
    if (!available.some(([id]) => id === tab)) tab = available[0][0];
    const pane = h('div', { class: 'db-pane' });
    const select = (id) => { dbUi.tab[name] = id; renderDbDetail(name); };
    const summary = h('div', { class: 'db-summary' },
      h('span', { class: `ftype db-${info.type}` }, icon(DB_TYPE[info.type][1])),
      h('div', { class: 'name-stack' }, h('strong', { text: name }), h('small', { text: [DB_TYPE[info.type][0], fmtSize(info.size), `actualizada ${timeAgo(info.mtime).toLowerCase()}`, info.tables && info.type === 'sqlite' ? plural(info.tables.length, 'tabla', 'tablas') : null].filter(Boolean).join(' · ') })));
    setContent(summary, tabs(available, tab, select), pane);

    if (tab === 'tables') renderDbTables(name, info, pane);
    else if (tab === 'query') renderDbQuery(name, info, pane);
    else if (tab === 'versions') renderDbVersions(name, pane);
    else if (tab === 'preview') {
      pane.append(info.truncated ? h('p', { class: 'panel-note', text: 'Vista previa de las primeras 200 filas.' }) : null, dataGrid(info.columns, info.rows));
    } else if (tab === 'content') {
      if (info.tables?.length) pane.append(h('div', { class: 'chips' }, h('span', { class: 'muted', text: 'Tablas definidas:' }), info.tables.map((t) => h('span', { class: 'chip', text: t }))));
      if (info.truncated) pane.append(h('p', { class: 'panel-note', text: 'Mostrando los primeros 512 KB. Descarga el archivo para verlo completo.' }));
      pane.append(h('div', { class: 'file-card' }, codeBlock(info.text, info.type === 'sql' ? 'sql' : 'json')));
    } else if (info.type === 'other') {
      pane.append(h('p', { class: 'panel-note', text: 'Este formato no se puede explorar, pero se guarda con historial de versiones.' }));
    }
  } catch (err) {
    reportError(err);
    if (err.status === 404) location.hash = '#/db';
  } finally {
    setLoading(false);
  }
}

async function renderDbTables(name, info, pane) {
  if (!info.tables.length) return pane.append(emptyState('table', 'Sin tablas', 'Esta base de datos no tiene tablas.'));
  let current = dbUi.table[name];
  if (!info.tables.some((t) => t.name === current)) current = info.tables[0].name;
  const list = h('ul', { class: 'table-list' }, info.tables.map((t) => h('li', {}, h('button', {
    type: 'button', class: `table-item${t.name === current ? ' active' : ''}`,
    onclick: () => { dbUi.table[name] = t.name; dbUi.offset = 0; pane.replaceChildren(); renderDbTables(name, info, pane); },
  }, icon(t.kind === 'view' ? 'eye' : 'table'), h('span', { class: 'table-name', text: t.name }), h('span', { class: 'muted', text: t.rows == null ? '' : t.rows.toLocaleString('es') })))));
  const meta = info.tables.find((t) => t.name === current);
  const right = h('div', { class: 'table-main' },
    h('div', { class: 'chips' }, meta.columns.map((c) => h('span', { class: `chip${c.pk ? ' pk' : ''}`, title: `${c.type || 'sin tipo'}${c.pk ? ' · clave primaria' : ''}${c.notnull ? ' · NOT NULL' : ''}` }, c.pk && icon('key'), c.name, h('small', { text: c.type || '' })))),
    h('div', { class: 'viewer-loading' }, h('span', { class: 'spinner' })));
  pane.append(h('div', { class: 'db-tables' }, list, right));
  try {
    const limit = 100;
    const r = await api(`/api/databases/${encodeURIComponent(name)}/table?t=${encodeURIComponent(current)}&limit=${limit}&offset=${dbUi.offset}`);
    const pager = h('div', { class: 'pager' },
      h('span', { class: 'muted', text: r.total ? `${(r.offset + 1).toLocaleString('es')}–${Math.min(r.offset + limit, r.total).toLocaleString('es')} de ${r.total.toLocaleString('es')}` : '0 filas' }),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: r.offset === 0, onclick: () => { dbUi.offset = Math.max(0, r.offset - limit); pane.replaceChildren(); renderDbTables(name, info, pane); } }, icon('chevron-left'), 'Anterior'),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: r.offset + limit >= r.total, onclick: () => { dbUi.offset = r.offset + limit; pane.replaceChildren(); renderDbTables(name, info, pane); } }, 'Siguiente', icon('chevron')));
    right.lastChild.replaceWith(dataGrid(r.columns, r.rows), pager);
  } catch (err) {
    right.lastChild.replaceWith(h('p', { class: 'form-error', text: err.message }));
  }
}

function renderDbQuery(name, info, pane) {
  const first = info.tables[0]?.name;
  const ta = h('textarea', { class: 'sql-input', spellcheck: 'false', rows: '6' });
  ta.value = dbUi.query[name] || (first ? `SELECT *\nFROM "${first}"\nLIMIT 50;` : 'SELECT sqlite_version();');
  const result = h('div', { class: 'query-result' });
  const run = async () => {
    dbUi.query[name] = ta.value;
    btn.disabled = true;
    result.replaceChildren(h('div', { class: 'viewer-loading' }, h('span', { class: 'spinner' })));
    try {
      const r = await api(`/api/databases/${encodeURIComponent(name)}/query`, { method: 'POST', json: { sql: ta.value } });
      result.replaceChildren(h('p', { class: 'panel-note', text: `${plural(r.rows.length, 'fila', 'filas')}${r.more ? ' (límite de 500 alcanzado)' : ''} · ${r.ms} ms` }), dataGrid(r.columns, r.rows));
    } catch (err) {
      result.replaceChildren(h('div', { class: 'query-error' }, icon('alert'), h('span', { text: err.message })));
    } finally {
      btn.disabled = false;
    }
  };
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  const btn = h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, icon('play'), 'Ejecutar');
  pane.append(
    h('div', { class: 'query-box' }, ta,
      h('div', { class: 'query-bar' },
        h('div', { class: 'chips' }, h('span', { class: 'muted', text: 'Tablas:' }), info.tables.map((t) => h('button', { type: 'button', class: 'chip', text: t.name, onclick: () => { ta.setRangeText(`"${t.name}"`, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus(); } }))),
        h('div', { class: 'query-actions' }, h('span', { class: 'muted small', text: 'Solo lectura · Ctrl+Enter' }), btn))),
    result);
  setTimeout(() => ta.focus(), 50);
}

async function renderDbVersions(name, pane) {
  const enc = encodeURIComponent(name);
  try {
    const { items } = await api(`/api/databases/${enc}/versions`);
    if (!items.length) return pane.append(emptyState('history', 'Sin versiones anteriores', 'Cuando subas una nueva versión con “Nueva versión”, la actual se guardará aquí (se conservan las últimas 10).'));
    pane.append(h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Versión guardada' }), h('th', { class: 'col-size', text: 'Tamaño' }), h('th', { class: 'col-actions wide' }))),
      h('tbody', {}, items.map((v) => h('tr', {},
        h('td', {}, h('div', { class: 'name-stack' }, h('span', { text: fmtDate(v.savedAt) }), h('small', { text: timeAgo(v.savedAt) }))),
        h('td', { class: 'col-size', text: fmtSize(v.size) }),
        h('td', { class: 'col-actions wide' }, h('div', { class: 'row-actions visible' },
          h('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: async () => {
              if (!(await openDialog({ title: '¿Restaurar esta versión?', message: 'La versión actual se guardará en el historial antes de restaurar.', confirm: 'Restaurar' }))) return;
              try { await api(`/api/databases/${enc}/versions/${encodeURIComponent(v.id)}/restore`, { method: 'POST' }); toast('Versión restaurada'); refresh(); } catch (err) { reportError(err); }
            },
          }, icon('restore'), h('span', { class: 'hide-mobile', text: 'Restaurar' })),
          h('a', { class: 'icon-btn', href: link(`/api/databases/${enc}/versions/${encodeURIComponent(v.id)}`), download: '', title: 'Descargar esta versión' }, icon('download')))))))));
  } catch (err) {
    reportError(err);
  }
}

// ═════════════════════════ Almacenamiento ═════════════════════════

let storagePoll = null;

function diskBar(disk) {
  if (!disk?.total) return null;
  const used = disk.total - disk.free;
  const fill = h('div', { class: 'meter-fill' });
  fill.style.width = `${Math.max(2, (used / disk.total) * 100).toFixed(1)}%`;
  return h('div', { class: 'disk-info' }, h('div', { class: 'meter' }, fill), h('div', { class: 'meter-row' }, h('span', { text: `${fmtSize(disk.free)} libres` }), h('span', { text: `de ${fmtSize(disk.total)}` })));
}

async function useStorage(mode, label) {
  if (!(await openDialog({
    title: `¿Guardar los archivos en ${label}?`,
    message: 'A partir de ahora, lo que subas y veas en Archivos estará en ese disco. Los archivos del almacenamiento anterior no se borran: puedes volver a cambiar cuando quieras.',
    confirm: 'Cambiar almacenamiento',
  }))) return;
  try {
    await api('/api/storage/mode', { method: 'POST', json: { mode } });
    toast(`Ahora los archivos se guardan en ${label}`);
    loadStats();
    refresh();
  } catch (err) { reportError(err); }
}

async function renderStorageView() {
  clearInterval(storagePoll);
  setHeader(heading('Almacenamiento', 'Dónde se guardan los archivos del hosting'), [], null);
  setLoading(true);
  try {
    const s = await api('/api/storage');
    if (state.view !== 'storage') return;
    const downloadBtn = (cls = 'btn btn-primary') => (s.agentAvailable
      ? h('a', { class: cls, href: link('/api/storage/agent-download'), download: 'NoirAlmacenamiento.exe', onclick: () => toast('Descargando la app (≈ 90 MB)…') }, icon('download'), h('span', { text: 'Descargar app' }))
      : h('span', { class: 'badge muted', text: 'App de almacenamiento no disponible en este servidor' }));
    $('#actions').replaceChildren(downloadBtn());

    const cur = s.current;
    const remote = cur.kind === 'remote';
    const hero = h('section', { class: 'storage-hero' },
      h('span', { class: `storage-icon${remote ? ' remote' : ''}` }, icon(remote ? 'server' : 'folder')),
      h('div', { class: 'storage-main' },
        h('span', { class: 'muted small', text: 'Los archivos se guardan en' }),
        h('strong', { text: remote ? cur.name : `Este equipo · ${cur.name}` }),
        h('span', { class: 'mono small muted', text: cur.root || '' }),
        remote && h('div', {}, cur.online ? h('span', { class: 'badge ok', text: cur.lan ? 'Conectado · red local' : 'Conectado · internet' }) : h('span', { class: 'badge err', text: `Desconectado · visto ${timeAgo(cur.lastSeen).toLowerCase()}` }))),
      h('div', { class: 'storage-disk' }, diskBar(cur.disk)));

    const agentCards = s.agents.map((a) => {
      const active = s.mode === `agent:${a.id}`;
      return h('div', { class: `agent-card${active ? ' active' : ''}` },
        h('div', { class: 'agent-top' },
          h('span', { class: 'ftype' }, icon('server')),
          h('div', { class: 'name-stack' }, h('strong', { text: a.name }), h('small', { text: a.online ? `Conectado · ${a.lan ? 'red local' : 'internet'}` : `Desconectado · visto ${timeAgo(a.lastSeen).toLowerCase()}` })),
          active ? h('span', { class: 'badge gold', text: 'En uso' }) : h('span', { class: `badge ${a.online ? 'ok' : 'muted'}`, text: a.online ? 'En línea' : 'Fuera de línea' })),
        h('span', { class: 'mono small muted agent-root', text: a.root || '' }),
        diskBar(a.disk),
        h('div', { class: 'panel-actions' },
          !active && h('button', { class: 'btn btn-sm', type: 'button', disabled: !a.online, title: a.online ? '' : 'Abre la app en ese PC primero', onclick: () => useStorage(`agent:${a.id}`, a.name) }, icon('check'), 'Usar este PC'),
          h('button', {
            class: 'btn btn-sm btn-ghost btn-danger', type: 'button',
            onclick: async () => {
              if (!(await confirmDanger(`¿Desvincular «${a.name}»?`, 'El hosting dejará de usar ese PC. Los archivos que tiene guardados no se borran de su disco.', 'Desvincular'))) return;
              try { await api(`/api/storage/agents/${a.id}`, { method: 'DELETE' }); toast('PC desvinculado'); loadStats(); refresh(); } catch (err) { reportError(err); }
            },
          }, 'Desvincular')));
    });
    const localCard = h('div', { class: `agent-card${remote ? '' : ' active'}` },
      h('div', { class: 'agent-top' },
        h('span', { class: 'ftype dir' }, icon('folder')),
        h('div', { class: 'name-stack' }, h('strong', { text: `Este equipo · ${s.local.name}` }), h('small', { text: 'Donde está el panel' })),
        remote ? h('span', { class: 'badge', text: 'Disponible' }) : h('span', { class: 'badge gold', text: 'En uso' })),
      h('span', { class: 'mono small muted agent-root', text: s.local.root }),
      diskBar(s.local.disk),
      remote && h('div', { class: 'panel-actions' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => useStorage('local', 'este equipo') }, icon('check'), 'Usar este PC')));

    const m = s.migration;
    let migrate = null;
    if (remote) {
      const pct = m?.total ? Math.round((m.done / m.total) * 100) : 0;
      const bar = h('div', { class: 'meter' }, h('div', { class: 'meter-fill' }));
      bar.firstChild.style.width = `${m?.running ? pct : m ? 100 : 0}%`;
      migrate = card('Pasar archivos de este equipo', 'move',
        h('p', { class: 'panel-note', text: `Copia los archivos que hay en este PC a «${cur.name}». Los originales no se borran.` }),
        m && h('div', { class: 'disk-info' }, bar, h('div', { class: 'meter-row' },
          h('span', { text: m.running ? `Copiando… ${m.done} de ${m.total}` : `Terminado: ${m.done - m.errors} de ${m.total} copiados${m.errors ? ` · ${m.errors} con error` : ''}` }),
          h('span', { text: `${fmtSize(m.bytesDone)} de ${fmtSize(m.bytes)}` }))),
        h('div', { class: 'panel-actions' }, h('button', {
          class: 'btn', type: 'button', disabled: Boolean(m?.running) || !cur.online,
          onclick: async () => { try { await api('/api/storage/migrate', { method: 'POST' }); toast('Copia iniciada'); refresh(); } catch (err) { reportError(err); } },
        }, icon('copy'), m?.running ? 'Copiando…' : 'Copiar archivos ahora')));
    }

    const steps = card('Añadir un PC de almacenamiento', 'plus',
      h('ol', { class: 'wizard' },
        h('li', { class: 'wizard-step' }, h('span', { class: 'step-num', text: '1' }), h('div', { class: 'wizard-body' }, h('strong', { text: 'Descarga la app' }), h('p', { class: 'panel-note', text: 'Hazlo desde el otro PC entrando a este panel, o descárgala aquí y cópiala con una memoria USB. Cada descarga lleva su propio código de vinculación (válido 48 horas).' }), downloadBtn('btn'))),
        h('li', { class: 'wizard-step' }, h('span', { class: 'step-num', text: '2' }), h('div', { class: 'wizard-body' }, h('strong', { text: 'Ábrela en el otro PC' }), h('p', { class: 'panel-note', text: 'Doble clic en NoirAlmacenamiento.exe. Si Windows muestra «Windows protegió su PC», pulsa «Más información» → «Ejecutar de todas formas». Si pregunta por el firewall, pulsa «Permitir».' }))),
        h('li', { class: 'wizard-step' }, h('span', { class: 'step-num', text: '3' }), h('div', { class: 'wizard-body' }, h('strong', { text: 'Listo' }), h('p', { class: 'panel-note', text: 'Se vincula sola, elige el disco con más espacio y arranca con Windows. Si es el primer PC que vinculas, pasa a ser el almacenamiento del hosting automáticamente.' })))));

    setContent(hero, h('div', { class: 'panels' },
      h('div', { class: 'panels-col' }, card('Discos disponibles', 'server', h('div', { class: 'agent-list' }, localCard, agentCards)), migrate),
      h('div', { class: 'panels-col' }, steps)));
    storagePoll = setInterval(() => { if (state.view === 'storage' && !$('#dialog').open) refresh(); else if (state.view !== 'storage') clearInterval(storagePoll); }, m?.running ? 2500 : 15000);
  } catch (err) {
    reportError(err);
  } finally {
    setLoading(false);
  }
}

// ═════════════════════════ Servidor y actualizaciones (tarjeta de Ajustes) ═════════════════════════

async function serverCard() {
  let u;
  try { u = await api('/api/update'); } catch { return null; }
  if (!u.supervised) {
    const exeUrl = `https://github.com/${u.repo}/releases/latest/download/NoirStudioServidor.exe`;
    return card('Mudanza al PC servidor', 'server',
      h('p', { class: 'panel-note', text: 'Para que otro PC sea el servidor (siempre encendido) y este quede solo para desarrollar y publicar actualizaciones:' }),
      h('ol', { class: 'wizard' },
        h('li', { class: 'wizard-step' }, h('span', { class: 'step-num', text: '1' }), h('div', { class: 'wizard-body' }, h('strong', { text: 'En el otro PC, descarga los dos archivos' }),
          h('div', { class: 'panel-actions' },
            h('a', { class: 'btn btn-primary', href: exeUrl }, icon('download'), 'Servidor (NoirStudioServidor.exe)'),
            h('a', { class: 'btn', href: link('/api/migrate/package'), download: '' }, icon('archive'), 'Paquete de mudanza (tus datos)')))),
        h('li', { class: 'wizard-step' }, h('span', { class: 'step-num', text: '2' }), h('div', { class: 'wizard-body' }, h('strong', { text: 'Abre NoirStudioServidor.exe' }), h('p', { class: 'panel-note', text: 'Acepta el permiso de administrador. Importa el paquete solo, queda arrancando al encender el equipo y el enlace fijo pasa a apuntar a él.' }))),
        h('li', { class: 'wizard-step' }, h('span', { class: 'step-num', text: '3' }), h('div', { class: 'wizard-body' }, h('strong', { text: 'Desde este PC, publica actualizaciones' }), h('p', { class: 'panel-note', text: 'Doble clic en PUBLICAR ACTUALIZACION.bat: el servidor se actualiza solo.' })))));
  }
  const status = h('div', { class: 'verify' });
  const autoBox = h('input', { type: 'checkbox', class: 'check', checked: u.autoUpdate });
  autoBox.addEventListener('change', async () => {
    try { await api('/api/update/auto', { method: 'POST', json: { enabled: autoBox.checked } }); toast(autoBox.checked ? 'Actualizaciones automáticas activadas' : 'Actualizaciones automáticas desactivadas'); } catch (err) { reportError(err); }
  });
  const show = (v) => {
    status.replaceChildren(
      kv('Versión instalada', v.current),
      kv('Última publicada', v.latest ? `${v.latest.version}${v.latest.publishedAt ? ` · ${timeAgo(Date.parse(v.latest.publishedAt)).toLowerCase()}` : ''}` : (v.checkedAt ? 'Sin publicaciones' : '—')),
      v.applying && h('p', { class: 'panel-note', text: `Actualizando… ${v.progress ?? 0}% (el servidor se reiniciará solo)` }),
      v.error && h('p', { class: 'form-error', text: v.error }),
      v.available && !v.applying && h('div', { class: 'panel-actions' }, h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: async () => {
          try {
            show(await api('/api/update/apply', { method: 'POST' }));
            const from = v.current;
            const poll = setInterval(async () => {
              try {
                const s = await api('/api/session', { allow401: true });
                if (s.version !== from) { clearInterval(poll); toast(`Actualizado a la versión ${s.version}`); setTimeout(() => location.reload(), 800); }
              } catch { /* reiniciando */ }
              try { const nv = await api('/api/update'); if (nv.applying || nv.error) show(nv); } catch { /* reiniciando */ }
            }, 2000);
          } catch (err) { reportError(err); }
        },
      }, icon('download'), `Actualizar a la ${v.latest.version}`)));
  };
  show(u);
  return card('Servidor y actualizaciones', 'server', status,
    h('div', { class: 'panel-actions' },
      h('button', { class: 'btn', type: 'button', onclick: async () => { try { show(await api('/api/update/check', { method: 'POST' })); } catch (err) { reportError(err); } } }, icon('refresh'), 'Buscar actualizaciones'),
      h('label', { class: 'search-opt' }, autoBox, h('span', { text: 'Actualizar automáticamente' }))));
}

// Registro de vistas
Object.assign(VIEWS, {
  code: { render: renderCodeView, min: 'editor' },
  db: { render: renderDbView, min: 'editor' },
  invites: { render: renderInvitesView, min: 'admin' },
  storage: { render: renderStorageView, min: 'admin' },
});
