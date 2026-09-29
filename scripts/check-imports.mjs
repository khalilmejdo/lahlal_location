/**
 * Verifie que chaque import nomme correspond bien a un export du module cible.
 * Analyse statique : ne charge pas les modules, donc fonctionne aussi pour le
 * code front qui suppose un navigateur.
 */
import fs from 'node:fs';
import path from 'node:path';

const racines = ['server', 'public/js', 'scripts'];
const fichiers = [];

function parcourir(dossier) {
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    const chemin = path.join(dossier, entree.name);
    if (entree.isDirectory()) parcourir(chemin);
    else if (/\.(js|mjs)$/.test(entree.name)) fichiers.push(chemin);
  }
}
for (const r of racines) if (fs.existsSync(r)) parcourir(r);

/** Exports nommes d'un fichier. */
function exportsDe(source) {
  const noms = new Set();
  // export function|class|const|let|var NOM
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    noms.add(m[1]);
  }
  // export { a, b as c }
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      noms.add((as[1] || as[0]).trim());
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) noms.add('default');
  return noms;
}

const cacheExports = new Map();
function getExports(fichier) {
  if (!cacheExports.has(fichier)) {
    cacheExports.set(fichier, exportsDe(fs.readFileSync(fichier, 'utf8')));
  }
  return cacheExports.get(fichier);
}

let problemes = 0;
let verifies = 0;

for (const fichier of fichiers) {
  const source = fs.readFileSync(fichier, 'utf8');
  const motif = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;

  for (const m of source.matchAll(motif)) {
    const nommes = m[2];
    const specificateur = m[4];
    if (!specificateur.startsWith('.')) continue;

    const cible = path.resolve(path.dirname(fichier), specificateur);
    if (!fs.existsSync(cible)) {
      console.log('  MANQUANT  ' + fichier + '  ->  ' + specificateur);
      problemes++;
      continue;
    }
    if (!nommes) continue;

    const dispo = getExports(cible);
    for (const brut of nommes.split(',')) {
      const t = brut.trim();
      if (!t) continue;
      const nom = t.split(/\s+as\s+/)[0].trim();
      if (nom.startsWith('type ')) continue;
      verifies++;
      if (!dispo.has(nom)) {
        console.log('  ABSENT    ' + fichier + '  ->  { ' + nom + ' } de ' + specificateur);
        problemes++;
      }
    }
  }
}

console.log('\n  ' + fichiers.length + ' fichiers, ' + verifies + ' imports nommes verifies.');
console.log(problemes === 0 ? '  Aucun import non resolu.\n' : '  ' + problemes + ' probleme(s).\n');
process.exit(problemes ? 1 : 0);
