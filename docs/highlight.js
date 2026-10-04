'use strict';
/* Noir Studio · Resaltado de sintaxis ligero (sin dependencias). Genera nodos DOM, nunca HTML. */

const HL_LANGS = (() => {
  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
  const cLike = 'auto break case catch char class const continue default delete do double else enum extern final finally float for goto if implements import inline int interface long namespace new operator package private protected public register return short signed sizeof static struct super switch template this throw try typedef union unsigned using virtual void volatile while true false null nullptr bool string var let fn func go defer chan map range type impl trait pub mod use crate self mut match loop where async await yield readonly override abstract sealed internal object val when fun lateinit echo function foreach elseif endif array';
  return {
    js: { kw: words('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield null undefined true false NaN Infinity type interface enum implements declare readonly as keyof namespace abstract private public protected'), line: '//', block: ['/*', '*/'], str: ['`', '"', "'"], regex: true },
    py: { kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self cls match case'), line: '#', str: ['"""', "'''", '"', "'"] },
    c: { kw: words(cLike), line: '//', block: ['/*', '*/'], str: ['"', "'", '`'] },
    css: { kw: words('important media import supports keyframes font-face root hover focus active before after not nth-child var calc rgba rgb hsl url from to inherit initial none auto'), block: ['/*', '*/'], str: ['"', "'"], css: true },
    sql: { kw: words('select from where insert into values update set delete create table drop alter add column primary key foreign references not null unique default index view join left right inner outer full cross on and or as order by group having limit offset distinct union all case when then else end if exists integer int bigint smallint text varchar char boolean bool date datetime timestamp time real float double decimal numeric blob begin commit rollback transaction autoincrement auto_increment engine charset collate like in between is asc desc count sum avg min max cascade constraint check trigger returning with recursive replace pragma database schema use show grant revoke'), ci: true, line: '--', block: ['/*', '*/'], str: ["'", '"', '`'] },
    sh: { kw: words('if then else elif fi for while until do done case esac function in return export local readonly echo exit set unset source alias cd sudo'), line: '#', str: ['"', "'"] },
    ps: { kw: words('function param if else elseif foreach for while do until switch return try catch finally throw begin process end break continue exit in filter trap class enum using'), ci: true, line: '#', block: ['<#', '#>'], str: ['"', "'"] },
    bat: { kw: words('echo off on set if else goto call exit not exist defined errorlevel for in do rem setlocal endlocal pause cd title start shift'), ci: true, line: 'rem ', str: ['"'] },
    json: { kw: words('true false null'), str: ['"'] },
    yaml: { kw: words('true false null yes no on off'), line: '#', str: ['"', "'"] },
    ini: { kw: words('true false yes no on off'), line: ';', str: ['"'] },
    html: { markup: true },
    md: { md: true },
  };
})();

const HL_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', vue: 'html', svelte: 'html',
  py: 'py', pyw: 'py',
  c: 'c', h: 'c', cpp: 'c', hpp: 'c', cc: 'c', cs: 'c', java: 'c', kt: 'c', go: 'c', rs: 'c', php: 'c', swift: 'c', dart: 'c', scala: 'c',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  sql: 'sql',
  sh: 'sh', bash: 'sh', zsh: 'sh', env: 'sh', gitignore: 'sh', dockerfile: 'sh',
  ps1: 'ps', psm1: 'ps',
  bat: 'bat', cmd: 'bat',
  json: 'json', jsonc: 'js',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', xaml: 'html',
  md: 'md', markdown: 'md',
};

function hlLangFor(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return 'sh';
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  return HL_EXT[ext] || null;
}

const HL_LANG_LABEL = { js: 'JavaScript / TypeScript', py: 'Python', c: 'C / Java / C# / Go', css: 'CSS', sql: 'SQL', sh: 'Shell', ps: 'PowerShell', bat: 'Batch', json: 'JSON', yaml: 'YAML', ini: 'Configuración', html: 'HTML / XML', md: 'Markdown' };

function hlTokenize(text, lang) {
  const def = HL_LANGS[lang];
  const out = [];
  let plain = '';
  const push = (type, value) => {
    if (!value) return;
    if (!type) { plain += value; return; }
    if (plain) { out.push(['', plain]); plain = ''; }
    out.push([type, value]);
  };
  const flush = () => { if (plain) out.push(['', plain]); plain = ''; };
  if (!def) return [['', text]];

  if (def.markup) {
    const re = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][\w:.-]*|\/?>|("[^"]*"|'[^']*')|([A-Za-z_:][\w:.-]*)(?==)|&[#\w]+;/y;
    let i = 0;
    let inTag = false;
    while (i < text.length) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m.index === i) {
        const v = m[0];
        if (v.startsWith('<!--')) push('com', v);
        else if (v.startsWith('<')) { push('tag', v); inTag = true; }
        else if (v === '>' || v === '/>') { push('tag', v); inTag = false; }
        else if (m[1] && inTag) push('str', v);
        else if (m[2] && inTag) push('attr', v);
        else if (v.startsWith('&')) push('num', v);
        else push('', v);
        i += v.length;
      } else {
        push('', text[i]);
        i++;
      }
    }
    flush();
    return out;
  }

  if (def.md) {
    for (const line of text.split(/(\n)/)) {
      if (line === '\n') push('', line);
      else if (/^#{1,6}\s/.test(line)) push('kw', line);
      else if (/^\s*```/.test(line)) push('com', line);
      else if (/^\s*>/.test(line)) push('com', line);
      else {
        const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|^\s*(?:[-*+]|\d+\.)\s)/);
        for (const p of parts) {
          if (!p) continue;
          if (p.startsWith('`')) push('str', p);
          else if (p.startsWith('**')) push('fn', p);
          else if (p.startsWith('[')) push('attr', p);
          else if (/^\s*(?:[-*+]|\d+\.)\s$/.test(p)) push('num', p);
          else push('', p);
        }
      }
    }
    flush();
    return out;
  }

  const ident = /[A-Za-z_$][\w$]*/y;
  const num = /(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
  const delims = [...(def.str || [])].sort((a, b) => b.length - a.length);
  let i = 0;
  let prevSignificant = '';
  while (i < text.length) {
    const c = text[i];
    if (def.block && text.startsWith(def.block[0], i)) {
      const end = text.indexOf(def.block[1], i + def.block[0].length);
      const stop = end === -1 ? text.length : end + def.block[1].length;
      push('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (def.line && (def.ci ? text.slice(i, i + def.line.length).toLowerCase() === def.line : text.startsWith(def.line, i)) && (def.line !== 'rem ' || i === 0 || text[i - 1] === '\n')) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      push('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    const d = delims.find((q) => text.startsWith(q, i));
    if (d) {
      let j = i + d.length;
      while (j < text.length) {
        if (text[j] === '\\' && lang !== 'sql') { j += 2; continue; }
        if (text.startsWith(d, j)) { j += d.length; break; }
        if (text[j] === '\n' && d.length === 1 && d !== '`') break;
        j++;
      }
      const v = text.slice(i, j);
      push(lang === 'json' && /^\s*:/.test(text.slice(j, j + 3)) ? 'attr' : 'str', v);
      i = j;
      prevSignificant = 'str';
      continue;
    }
    if (def.regex && c === '/' && !/[\w$)\]]/.test(prevSignificant)) {
      const m = /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\\\n])+\/[dgimsuyv]*/y;
      m.lastIndex = i;
      const r = m.exec(text);
      if (r) { push('str', r[0]); i += r[0].length; prevSignificant = 'x'; continue; }
    }
    if (/\d/.test(c) && !/[\w$]/.test(text[i - 1] || '')) {
      num.lastIndex = i;
      const m = num.exec(text);
      if (m) { push('num', m[0]); i += m[0].length; prevSignificant = '0'; continue; }
    }
    if (/[A-Za-z_$]/.test(c)) {
      ident.lastIndex = i;
      const w = ident.exec(text)[0];
      const key = def.ci ? w.toLowerCase() : w;
      if (def.kw.has(key)) push('kw', w);
      else if (def.css && text[i + w.length] === ':') push('attr', w);
      else if (text[i + w.length] === '(') push('fn', w);
      else if (/^[A-Z][a-z]/.test(w) && lang !== 'sql') push('type', w);
      else push('', w);
      i += w.length;
      prevSignificant = 'a';
      continue;
    }
    if (def.css && (c === '#' || c === '.') && /[\w-]/.test(text[i + 1] || '') && prevSignificant !== '0') {
      const m = /[#.][\w-]+/y;
      m.lastIndex = i;
      const v = m.exec(text)[0];
      push(/^#[\da-fA-F]{3,8}$/.test(v) ? 'num' : 'tag', v);
      i += v.length;
      continue;
    }
    push('', c);
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  flush();
  return out;
}

/** Devuelve un fragmento DOM con el código resaltado. */
function highlight(text, lang) {
  const frag = document.createDocumentFragment();
  if (!lang || text.length > 400000) {
    frag.append(document.createTextNode(text));
    return frag;
  }
  for (const [type, value] of hlTokenize(text, lang)) {
    if (!type) { frag.append(document.createTextNode(value)); continue; }
    const span = document.createElement('span');
    span.className = `tk-${type}`;
    span.textContent = value;
    frag.append(span);
  }
  return frag;
}
