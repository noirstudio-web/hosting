'use strict';
/*
 * Construye bin/NoirAlmacenamiento.exe: la app del PC de almacenamiento en un único ejecutable
 * (Node.js Single Executable Application). Uso: node scripts/build-agent.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'agent', 'dist');
const OUT = path.join(ROOT, 'bin', 'NoirAlmacenamiento.exe');

fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// 1. Un solo archivo JS: el módulo de almacenamiento compartido va incrustado.
const store = fs.readFileSync(path.join(ROOT, 'lib', 'fsstore.js'), 'utf8');
const agent = fs.readFileSync(path.join(ROOT, 'agent', 'agent.js'), 'utf8');
const marker = /^.*\/\/ @bundle\s*$/m;
if (!marker.test(agent)) throw new Error('No se encontró la línea // @bundle en agent.js');
const inlined = `const { FsStore, STORE_OPS } = (() => {\n  const module = { exports: {} };\n${store}\n  return module.exports;\n})();`;
fs.writeFileSync(path.join(DIST, 'agent.bundle.js'), agent.replace(marker, inlined));
console.log('  ✓ Código empaquetado');

// 2. Blob de la aplicación
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify({
  main: 'agent.bundle.js',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: DIST, stdio: 'inherit' });
console.log('  ✓ Blob generado');

// 3. Copia de node.exe + inyección del blob (postject se usa como librería: evita problemas con rutas especiales)
(async () => {
  const postjectDir = path.join(DIST, 'node_modules', 'postject');
  if (!fs.existsSync(postjectDir)) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', '.', 'postject@1.0.0-alpha.6'], { cwd: DIST, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const { inject } = require(postjectDir);
  fs.copyFileSync(process.execPath, OUT);
  await inject(OUT, 'NODE_SEA_BLOB', fs.readFileSync(path.join(DIST, 'sea-prep.blob')), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });
  console.log(`  ✓ App lista: ${OUT} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
