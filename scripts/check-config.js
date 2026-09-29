#!/usr/bin/env node
/**
 * Verifie la configuration sans rien modifier.
 *
 *   npm run check
 *
 * Utile avant un deploiement : signale les secrets manquants, les incoherences
 * et les points de posture de securite a surveiller. Teste egalement la
 * joignabilite de la base si --db est passe.
 */
import { config, validateConfig, configWarnings } from '../server/core/config.js';

const testerBase = process.argv.includes('--db');

const erreurs = validateConfig({ requireDb: true });
const avertissements = configWarnings();

console.log('\n  Configuration — Lahlal, gestion de flotte\n');

console.log('  Reseau');
console.log('    hote / port ............ ' + config.http.host + ':' + config.http.port);
console.log('    derriere un proxy ...... ' + oui(config.http.trustProxy));
console.log('    origines autorisees .... ' +
  (config.http.allowedOrigins.length ? config.http.allowedOrigins.join(', ') : '(hote courant uniquement)'));

console.log('\n  Base de donnees');
console.log('    chaine de connexion .... ' + masquerUrl(config.db.url));
console.log('    chiffrement TLS ........ ' + config.db.ssl);
console.log('    connexions maximales ... ' + config.db.poolMax);

console.log('\n  Securite');
console.log('    secrets renseignes ..... ' + oui(
  Boolean(config.security.secret && config.security.passwordPepper)));
console.log('    cookies Secure ......... ' + oui(config.security.secureCookies));
console.log('    HSTS ................... ' + oui(config.security.enableHsts));
console.log('    inactivite maximale .... ' + Math.round(config.security.sessionIdleMs / 60000) + ' min');
console.log('    duree absolue .......... ' + Math.round(config.security.sessionAbsoluteMs / 3600000) + ' h');
console.log('    longueur mot de passe .. ' + config.security.passwordMinLength + ' caracteres');
console.log('    verrouillage apres ..... ' + config.security.loginMaxAttempts + ' echecs');

console.log('\n  Pièces jointes');
console.log('    taille max des pieces .. ' +
  Math.round(config.storage.maxUploadBytes / 1048576) + ' Mo');
console.log('    formats acceptes ....... ' + config.storage.allowedMimeTypes.join(', '));

// Les seuils d'alerte ne figurent pas ici : ils vivent en base et se reglent
// a l'ecran (Parametres). « npm run check » regarde l'environnement, et rien
// d'autre — il doit pouvoir tourner sans base joignable.

if (avertissements.length) {
  console.log('\n  Avertissements');
  for (const a of avertissements) console.log('    - ' + a);
}

if (erreurs.length) {
  console.log('\n  Erreurs bloquantes');
  for (const e of erreurs) console.log('    - ' + e);
  console.log('\n  La configuration doit etre corrigee avant tout demarrage.\n');
  process.exit(1);
}

if (!testerBase) {
  console.log('\n  Configuration valide. Ajoutez --db pour tester la connexion a la base.\n');
  process.exit(0);
}

const { ping, closePool } = await import('../server/db/index.js');
try {
  const ms = await ping();
  console.log('\n  Base joignable en ' + ms + ' ms. Configuration valide.\n');
  await closePool();
} catch (err) {
  console.error('\n  Base injoignable : ' + err.message);
  console.error('  Verifiez DATABASE_URL, le mot de passe et l autorisation reseau.\n');
  await closePool().catch(() => {});
  process.exit(1);
}

function oui(v) {
  return v ? 'oui' : 'non';
}

/** Masque le mot de passe de la chaine de connexion avant affichage. */
function masquerUrl(url) {
  if (!url) return '(absente)';
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:••••••@');
}
