'use strict';
/*
 * Publica una actualización: sube la versión, construye NoirStudioServidor.exe, guarda los cambios en GitHub
 * y crea una "Release". El PC servidor la detecta y se actualiza solo.
 * Uso: node scripts/publish.cjs "Descripción de los cambios"
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'lib', 'version.js');
const notes = (process.argv.slice(2).join(' ').trim() || 'Mejoras y correcciones');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT }).toString().trim();

try {
  out('gh', ['auth', 'status']);
} catch {
  console.error('  ✗ GitHub CLI no tiene sesión iniciada. Ejecuta: gh auth login');
  process.exit(1);
}

// 1. Nueva versión
const src = fs.readFileSync(VERSION_FILE, 'utf8');
const current = src.match(/'(\d+)\.(\d+)\.(\d+)'/);
const next = `${current[1]}.${current[2]}.${Number(current[3]) + 1}`;
fs.writeFileSync(VERSION_FILE, src.replace(current[0], `'${next}'`));
console.log(`\n  ■ Publicando Noir Studio ${next}\n`);

try {
  // 2. Enlace fijo firmado y ejecutable
  sh(process.execPath, ['scripts/prepare-relay.cjs']);
  sh(process.execPath, ['scripts/build-pages.cjs']);
  sh(process.execPath, ['scripts/build-server.cjs']);

  // 3. Código a GitHub
  sh('git', ['pull', '--rebase', '--autostash', '-q']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-q', '-m', `Versión ${next}: ${notes}`]);
  sh('git', ['push', '-q']);

  // 4. Release con el ejecutable (el servidor la descarga desde aquí)
  sh('gh', ['release', 'create', `v${next}`, path.join('dist', 'NoirStudioServidor.exe'), '--title', `Noir Studio ${next}`, '--notes', notes, '--latest']);
  console.log(`\n  ✓ Versión ${next} publicada. El PC servidor la instalará solo en las próximas horas`);
  console.log('    (o al momento desde el panel: Ajustes → Servidor y actualizaciones → Buscar actualizaciones).\n');
} catch (err) {
  fs.writeFileSync(VERSION_FILE, src);
  console.error(`\n  ✗ No se pudo publicar: ${err.message}`);
  process.exit(1);
}
