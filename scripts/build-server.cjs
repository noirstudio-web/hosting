'use strict';
/*
 * Construye dist/NoirStudioServidor.exe: el hosting completo en un único ejecutable
 * (Node.js Single Executable Application) con la web incrustada como recursos.
 * Uso: node scripts/build-server.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, 'build');
const OUT = path.join(DIST, 'NoirStudioServidor.exe');
fs.mkdirSync(WORK, { recursive: true });

// 1. Empaquetador mínimo: cada módulo local se envuelve en una función con su propio require.
const modules = new Map();
function addModule(rel) {
  rel = rel.split(path.sep).join('/');
  if (modules.has(rel)) return;
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  modules.set(rel, src);
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    let dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    if (!dep.endsWith('.js')) dep += '.js';
    addModule(dep);
  }
}
addModule('app/main.js');

let bundle = "'use strict';\nconst __path = require('path');\nconst __defs = {};\nconst __cache = {};\n";
bundle += 'function __load(id) {\n  if (__cache[id]) return __cache[id].exports;\n  const module = { exports: {} };\n  __cache[id] = module;\n  __defs[id](module, module.exports, (p) => __require(id, p), id, __path.posix.dirname(id));\n  return module.exports;\n}\n';
bundle += "function __require(from, p) {\n  if (!p.startsWith('.')) return require(p);\n  let id = __path.posix.normalize(__path.posix.join(__path.posix.dirname(from), p));\n  if (!id.endsWith('.js')) id += '.js';\n  return __load(id);\n}\n";
for (const [id, src] of modules) {
  bundle += `__defs[${JSON.stringify(id)}] = function (module, exports, require, __filename, __dirname) {\n${src.replace(/^#!.*\n/, '')}\n};\n`;
}
bundle += "__load('app/main.js');\n";
fs.writeFileSync(path.join(WORK, 'server.bundle.js'), bundle);
console.log(`  ✓ ${modules.size} módulos empaquetados`);

// 2. Recursos: la web (public/)
const assets = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else assets[path.relative(ROOT, full).split(path.sep).join('/')] = full;
  }
})(path.join(ROOT, 'public'));
fs.writeFileSync(path.join(WORK, 'sea-config.json'), JSON.stringify({
  main: 'server.bundle.js',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: WORK, stdio: 'inherit' });
console.log(`  ✓ ${Object.keys(assets).length} recursos de la web incluidos`);

// 3. node.exe + blob
(async () => {
  const postjectDir = path.join(ROOT, 'agent', 'dist', 'node_modules', 'postject');
  if (!fs.existsSync(postjectDir)) {
    fs.mkdirSync(path.join(ROOT, 'agent', 'dist'), { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', '.', 'postject@1.0.0-alpha.6'], { cwd: path.join(ROOT, 'agent', 'dist'), stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const { inject } = require(postjectDir);
  fs.copyFileSync(process.execPath, OUT);
  await inject(OUT, 'NODE_SEA_BLOB', fs.readFileSync(path.join(WORK, 'sea-prep.blob')), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
  const v = execFileSync(OUT, ['--version']).toString().trim();
  console.log(`  ✓ Servidor listo: ${OUT} · v${v} · ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB`);
})().catch((err) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
