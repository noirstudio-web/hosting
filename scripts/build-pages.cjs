'use strict';
/*
 * Publica la web en GitHub Pages (carpeta docs/): la página se carga desde GitHub y habla con el servidor
 * (PC de almacenamiento) a través de su dirección firmada. Uso: node scripts/build-pages.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const DOCS = path.join(ROOT, 'docs');

// Rutas absolutas ("/app.css") → relativas ("app.css"), porque la web vive en /hosting/
const relative = (html) => html.replace(/(href|src)="\/(?!\/)/g, '$1="');
const withConnect = (html, before) => html.replace(`<script src="${before}"></script>`, `<script src="connect.js"></script>\n  <script src="${before}"></script>`);

for (const f of ['app.js', 'modules.js', 'highlight.js', 'app.css', 'favicon.svg', 'share.js', 'manifest.webmanifest']) {
  fs.copyFileSync(path.join(PUB, f), path.join(DOCS, f));
}
// Logos e íconos
fs.cpSync(path.join(PUB, 'img'), path.join(DOCS, 'img'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'pages', 'connect.js'), path.join(DOCS, 'connect.js'));
fs.writeFileSync(path.join(DOCS, 'index.html'), withConnect(relative(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')), 'highlight.js'));
fs.writeFileSync(path.join(DOCS, 's.html'), withConnect(relative(fs.readFileSync(path.join(PUB, 'share.html'), 'utf8')), 'share.js'));
console.log('  ✓ Web publicada en docs/ (GitHub Pages)');
