'use strict';
/* Noir Studio · Vistas de desarrollo y administración: código, bases de datos y códigos de acceso. */

const publicBase = () => state.settings?.publicUrl || location.origin;
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

async function renderProjectList() {
  setHeader(heading('Código', 'Proyectos de desarrollo de este equipo'), [
    can('admin') && h('button', { class: 'btn btn-primary', type: 'button', onclick: projectDialog }, icon('plus'), h('span', { text: 'Añadir proyecto' })),
  ], null);
  setLoading(true);
  try {
    const { items } = await api('/api/projects');
    if (state.view !== 'code') return;
    if (!items.length) return setContent(emptyState('code', 'No hay proyectos', 'Añade la carpeta de un proyecto para ver su código desde cualquier lugar.', can('admin') && h('button', { class: 'btn btn-primary', type: 'button', onclick: projectDialog }, icon('plus'), 'Añadir proyecto')));
    setContent(h('div', { class: 'project-grid' }, items.map((p) => h('a', { class: `project-card${p.exists ? '' : ' missing'}`, href: `#/code/${p.id}` },
      h('div', { class: 'project-top' }, h('span', { class: 'ftype code' }, icon('code')), p.branch && h('span', { class: 'badge' }, icon('branch'), p.branch)),
      h('strong', { text: p.name }),
      h('span', { class: 'project-path', text: p.path, title: p.path }),
      !p.exists && h('span', { class: 'badge muted', text: 'Carpeta no encontrada' })))));
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
      h('a', { class: 'btn', href: `/api/projects/${id}/zip`, download: '', title: 'Descargar el proyecto en ZIP' }, icon('download'), h('span', { text: 'ZIP' })),
      can('admin') && h('button', {
        class: 'icon-btn', type: 'button', title: 'Quitar proyecto de la lista',
        onclick: async () => {
          if (!(await confirmDanger(`¿Quitar “${p.name}”?`, 'Solo se quita de la lista. La carpeta y sus archivos no se tocan.', 'Quitar'))) return;
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
    h('p', { class: 'panel-note mono', text: project.path }));
  viewer.replaceChildren(body);
  if (readme) {
    api(`/api/projects/${id}/file?path=${encodeURIComponent(readme.path)}`).then((f) => {
      if (f.text && viewer.isConnected) body.append(h('div', { class: 'file-card' }, h('header', { class: 'file-head' }, icon('doc'), h('strong', { text: readme.name })), codeBlock(f.text, 'md')));
    }).catch(() => {});
  }
}

async function showFile(id, filePath, viewer) {
  const f = await api(`/api/projects/${id}/file?path=${encodeURIComponent(filePath)}`);
  const raw = `/api/projects/${id}/raw?path=${encodeURIComponent(filePath)}`;
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

function pickDbFile(targetName) {
  const input = h('input', { type: 'file', accept: targetName ? null : '.db,.sqlite,.sqlite3,.db3,.sql,.csv,.tsv,.json,.dump,.bak' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    if (targetName && file.name !== targetName) toast(`Se guardará como nueva versión de “${targetName}”`);
    enqueue([{ file, rel: '', name: targetName || file.name }], { area: 'db' });
  });
  input.click();
}

async function renderDbView() {
  if (state.sub) return renderDbDetail(state.sub);
  setHeader(heading('Bases de datos', 'SQLite, volcados SQL, CSV y JSON con historial de versiones'), [
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => pickDbFile() }, icon('upload'), h('span', { text: 'Subir base de datos' })),
  ], null);
  setLoading(true);
  try {
    const { items, sqlite } = await api('/api/databases');
    if (state.view !== 'db' || state.sub) return;
    const note = !sqlite && h('p', { class: 'panel-note', text: 'Aviso: esta versión de Node.js no incluye SQLite; las bases .db se guardan pero no se pueden explorar.' });
    if (!items.length) return setContent(note, emptyState('database', 'No hay bases de datos', 'Sube un archivo .db / .sqlite, un volcado .sql, un CSV o un JSON. Si subes otro con el mismo nombre, la versión anterior se guarda en el historial.', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => pickDbFile() }, icon('upload'), 'Subir base de datos')));
    const rows = items.map((d) => h('tr', { onclick: () => { location.hash = `#/db/${encodeURIComponent(d.name)}`; } },
      h('td', {}, h('div', { class: 'name-cell' }, h('span', { class: `ftype db-${d.type}` }, icon(DB_TYPE[d.type][1])), h('div', { class: 'name-stack' }, h('span', { class: 'name', text: d.name }), h('small', { text: DB_TYPE[d.type][0] })))),
      h('td', { class: 'col-size', text: fmtSize(d.size) }),
      h('td', { class: 'col-date hide-mobile', text: timeAgo(d.mtime) }),
      h('td', { class: 'col-num hide-mobile', text: d.versions ? plural(d.versions, 'versión', 'versiones') : '—' }),
      h('td', { class: 'col-actions' }, h('div', { class: 'row-actions visible' },
        h('a', { class: 'icon-btn', href: `/api/databases/${encodeURIComponent(d.name)}/file`, download: '', title: 'Descargar', onclick: (e) => e.stopPropagation() }, icon('download')),
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
    h('a', { class: 'btn', href: `/api/databases/${enc}/file`, download: '' }, icon('download'), h('span', { text: 'Descargar' })),
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
          h('a', { class: 'icon-btn', href: `/api/databases/${enc}/versions/${encodeURIComponent(v.id)}`, download: '', title: 'Descargar esta versión' }, icon('download')))))))));
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
      ? h('a', { class: cls, href: '/api/storage/agent-download', download: 'NoirAlmacenamiento.exe', onclick: () => toast('Descargando la app (≈ 90 MB)…') }, icon('download'), h('span', { text: 'Descargar app' }))
      : h('span', { class: 'badge muted', text: 'Ejecuta CONSTRUIR APP ALMACENAMIENTO.bat en este PC' }));
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

// Registro de vistas
Object.assign(VIEWS, {
  code: { render: renderCodeView, min: 'editor' },
  db: { render: renderDbView, min: 'editor' },
  invites: { render: renderInvitesView, min: 'admin' },
  storage: { render: renderStorageView, min: 'admin' },
});
