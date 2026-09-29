#!/usr/bin/env node
/**
 * Point d'entree du conteneur.
 *
 * Enchaine, dans cet ordre :
 *   1. attente que la base reponde (elle demarre souvent apres l'application) ;
 *   2. application du schema        — idempotente ;
 *   3. initialisation des donnees   — idempotente ;
 *   4. demarrage du serveur.
 *
 * Les etapes 2 et 3 peuvent etre rejouees a chaque redemarrage sans dommage :
 * elles n'ecrasent jamais une donnee existante. C'est ce qui permet de
 * redeployer sans intervention manuelle.
 *
 * Pour les desactiver (par exemple si la migration est jouee separement) :
 *   SKIP_MIGRATE=true   SKIP_SEED=true
 */
import { spawnSync } from 'node:child_process';
import { assertConfig } from '../server/core/config.js';
import { ping, closePool } from '../server/db/index.js';

const ATTENTE_MAX_MS = 90000;
const INTERVALLE_MS = 2000;

const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

assertConfig();

/* ------------------------------------------------------------------ */

async function attendreBase() {
  const limite = Date.now() + ATTENTE_MAX_MS;
  let tentative = 0;

  while (Date.now() < limite) {
    tentative += 1;
    try {
      const ms = await ping();
      console.log('  Base joignable en ' + ms + ' ms (tentative ' + tentative + ').');
      return true;
    } catch (err) {
      const restant = Math.ceil((limite - Date.now()) / 1000);
      console.log(
        '  Base injoignable (' + err.message.split('\n')[0] + ') — ' +
        'nouvelle tentative dans ' + INTERVALLE_MS / 1000 + ' s, ' + restant + ' s restantes.',
      );
      await new Promise((r) => setTimeout(r, INTERVALLE_MS));
    }
  }
  return false;
}

/** Execute un script de maintenance dans un processus separe. */
function executer(libelle, script, args = []) {
  console.log('\n  ' + libelle + '…');
  const resultat = spawnSync(process.execPath, [script, ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  if (resultat.status !== 0) {
    console.error('\n  Echec : ' + libelle + ' (code ' + resultat.status + ').');
    console.error('  Demarrage interrompu pour ne pas servir une base incoherente.\n');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('\n  STE LAHLAL SAMU PLUS — demarrage du conteneur\n');

  const joignable = await attendreBase();
  // Le pool ouvert pour le test est ferme : les scripts suivants ouvriront
  // le leur, et le serveur ouvrira le sien.
  await closePool().catch(() => {});

  if (!joignable) {
    console.error('\n  La base n a pas repondu dans le delai imparti.');
    console.error('  Verifiez DATABASE_URL et que le service PostgreSQL est demarre.\n');
    process.exit(1);
  }

  if (!bool(process.env.SKIP_MIGRATE)) {
    executer('Application du schema', 'scripts/migrate.js');
  }

  if (!bool(process.env.SKIP_SEED)) {
    executer('Initialisation des donnees de reference', 'scripts/seed.js');
  }

  console.log('\n  Demarrage du serveur…\n');
  await import('../server/index.js');
}

main().catch((err) => {
  console.error('\n  Echec du demarrage : ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
