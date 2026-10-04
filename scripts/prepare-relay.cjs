'use strict';
/*
 * Prepara el enlace fijo firmado: el servidor publica su dirección en un canal público (ntfy.sh)
 * firmada con una clave privada; la página del enlace fijo solo acepta direcciones con esa firma.
 *   - data/relay-key.json  → clave privada (privada: viaja en el paquete de mudanza, nunca a GitHub)
 *   - docs/relay.json      → canal + clave pública (se publica en GitHub Pages)
 * Uso: node scripts/prepare-relay.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const KEY = path.join(ROOT, 'data', 'relay-key.json');
const PUB = path.join(ROOT, 'docs', 'relay.json');

let relay;
try { relay = JSON.parse(fs.readFileSync(KEY, 'utf8')); } catch { relay = null; }
if (!relay?.privateKey) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  relay = { topic: `noirstudio-${crypto.randomBytes(12).toString('hex')}`, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  fs.mkdirSync(path.dirname(KEY), { recursive: true });
  fs.writeFileSync(KEY, JSON.stringify(relay, null, 2));
  console.log('  ✓ Clave de firma creada');
}
const publicKey = crypto.createPublicKey(relay.privateKey).export({ format: 'jwk' });
fs.writeFileSync(PUB, `${JSON.stringify({ topic: relay.topic, publicKey }, null, 2)}\n`);
console.log(`  ✓ docs/relay.json listo (canal ${relay.topic})`);
