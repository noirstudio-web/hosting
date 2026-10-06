'use strict';
/*
 * Publica una actualización: sube la versión, despliega el servidor en la nube (Neon)
 * y publica la web en GitHub Pages. No hace falta ningún PC encendido.
 * Uso: node scripts/publish.cjs "Descripción de los cambios"
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'lib', 'version.js');
const notes = (process.argv.slice(2).join(' ').trim() || 'Mejoras y correcciones');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
// neon está instalado con npm (neon.cmd en Windows): necesita la consola para ejecutarse.
const neon = (args) => execFileSync(`neon ${args}`, { cwd: ROOT, stdio: 'inherit', shell: true });

if (!fs.existsSync(path.join(ROOT, '.env.local')) || !fs.existsSync(path.join(ROOT, '.neon'))) {
  console.error('  ✗ Este PC no está vinculado a la nube. Ejecuta: neon link (y luego neon env pull)');
  process.exit(1);
}

// 1. Nueva versión
const src = fs.readFileSync(VERSION_FILE, 'utf8');
const current = src.match(/'(\d+)\.(\d+)\.(\d+)'/);
const next = `${current[1]}.${current[2]}.${Number(current[3]) + 1}`;
fs.writeFileSync(VERSION_FILE, src.replace(current[0], `'${next}'`));
console.log(`\n  ■ Publicando Noir Studio ${next}\n`);

try {
  // 2. Servidor en la nube y web
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'pg'))) sh(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { shell: process.platform === 'win32' });
  neon('deploy --env .env.local');
  sh(process.execPath, ['scripts/build-pages.cjs']);

  // 3. Código y web a GitHub
  sh('git', ['pull', '--rebase', '--autostash', '-q']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-q', '-m', `Versión ${next}: ${notes}`]);
  sh('git', ['push', '-q']);
  console.log(`\n  ✓ Versión ${next} publicada: el servidor en la nube ya la usa y la web se actualiza en 1-2 minutos.\n`);
} catch (err) {
  fs.writeFileSync(VERSION_FILE, src);
  console.error(`\n  ✗ No se pudo publicar: ${err.message}`);
  process.exit(1);
}
