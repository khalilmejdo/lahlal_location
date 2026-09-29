#!/usr/bin/env node
/**
 * Genere les secrets cryptographiques requis par l'application.
 *
 *   npm run keygen            affiche les secrets a coller
 *   npm run keygen -- --write cree ou complete le fichier .env local
 *
 * Ces secrets ne doivent jamais etre versionnes ni transmis par messagerie.
 * Sur Coolify, ils se saisissent dans les variables d'environnement du service.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const KEYS = ['APP_SECRET', 'APP_PASSWORD_PEPPER'];

const generated = Object.fromEntries(KEYS.map((k) => [k, crypto.randomBytes(32).toString('hex')]));

const shouldWrite = process.argv.includes('--write');

if (!shouldWrite) {
  console.log('\n  Secrets generes (256 bits chacun) :\n');
  for (const key of KEYS) console.log('  ' + key + '=' + generated[key]);
  console.log('\n  Collez-les dans votre fichier .env, ou relancez avec --write.');
  console.log('  Sur Coolify : votre service > Environment Variables.\n');
  process.exit(0);
}

const envPath = path.join(ROOT, '.env');
const examplePath = path.join(ROOT, '.env.example');

let content = '';
if (fs.existsSync(envPath)) {
  content = fs.readFileSync(envPath, 'utf8');
  console.log('  Fichier .env existant : seules les cles vides seront completees.');
} else if (fs.existsSync(examplePath)) {
  content = fs.readFileSync(examplePath, 'utf8');
  console.log('  Fichier .env cree a partir de .env.example.');
}

let filled = 0;
let skipped = 0;

for (const key of KEYS) {
  const re = new RegExp('^' + key + '=(.*)$', 'm');
  const match = content.match(re);
  if (match) {
    if (match[1].trim() !== '') {
      skipped += 1;
      continue;
    }
    content = content.replace(re, key + '=' + generated[key]);
  } else {
    content += (content.endsWith('\n') || content === '' ? '' : '\n') + key + '=' + generated[key] + '\n';
  }
  filled += 1;
}

// Le fichier .env contient des secrets : permissions restreintes au proprietaire.
fs.writeFileSync(envPath, content, { mode: 0o600 });
try {
  fs.chmodSync(envPath, 0o600);
} catch {
  // Windows n'applique pas les modes POSIX : sans effet, sans consequence.
}

console.log('\n  ' + filled + ' secret(s) ecrit(s) dans .env' + (skipped ? ', ' + skipped + ' conserve(s)' : '') + '.');
console.log('  Pensez a renseigner DATABASE_URL et BOOTSTRAP_ADMIN_PASSWORD.\n');
