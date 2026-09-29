#!/usr/bin/env node
/**
 * Cree ou reinitialise le compte super-administrateur.
 *
 *   npm run superadmin -- --username direction --nom "Nom Prenom"
 *   npm run superadmin -- --reset            reinitialise le mot de passe
 *
 * Pourquoi un script, et non un ecran.
 *
 * Le super-administrateur est le seul role capable d'agir sur un
 * administrateur : modifier ses droits, reinitialiser son mot de passe,
 * supprimer son compte. Si l'application permettait de creer un tel compte
 * depuis l'interface, il suffirait de posseder « user.manage » — que tout
 * administrateur possede — pour se hisser au-dessus de sa propre hierarchie.
 * L'operation exige donc un acces au serveur, c'est-a-dire a l'hebergement :
 * un pouvoir qui ne se prend pas, il se donne.
 *
 * Le mot de passe est genere ici et affiche une seule fois. Son titulaire doit
 * en definir un nouveau des la premiere connexion.
 */
import { assertConfig, config } from '../server/core/config.js';
import { newId, hashPassword, randomToken } from '../server/core/crypto.js';
import { one, value, transaction, closePool, ping } from '../server/db/index.js';
import { record } from '../server/core/audit.js';

assertConfig();

function argument(nom, defaut = null) {
  const i = process.argv.indexOf(nom);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
}

const identifiant = String(argument('--username', 'direction')).toLowerCase();
const nomComplet = argument('--nom', 'Direction generale');
const courriel = argument('--email', null);
const reinitialiser = process.argv.includes('--reset');

async function main() {
  console.log('\n  Connexion a la base...');
  console.log('  Base joignable (' + (await ping()) + ' ms).\n');

  const role = await one("SELECT id, name, rank FROM roles WHERE code = 'SUPERADMIN'");
  if (!role) {
    console.error('  Le role SUPERADMIN est absent de la base.');
    console.error('  Lancez d abord : npm run seed\n');
    process.exit(1);
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(identifiant)) {
    console.error('  Identifiant invalide : lettres minuscules, chiffres, . _ et - seulement.\n');
    process.exit(1);
  }

  const existant = await one(
    'SELECT id, username, role_id FROM users WHERE username_lower = $1',
    [identifiant],
  );

  if (existant && !reinitialiser) {
    console.log('  Le compte « ' + identifiant + ' » existe deja.');
    console.log('  Pour lui rendre un mot de passe : npm run superadmin -- --username ' +
                identifiant + ' --reset\n');
    process.exit(0);
  }

  // Mot de passe genere : long, aleatoire, affiche une seule fois.
  const motDePasse = randomToken(18).replace(/[-_]/g, 'x').slice(0, 22);
  const empreinte = await hashPassword(motDePasse);

  const acteur = { id: null, username: 'script:superadmin' };

  const id = existant ? existant.id : newId();

  await transaction(async (tx) => {
    if (existant) {
      await tx.query(
        `UPDATE users
            SET password_hash = $2, password_changed_at = now(), must_change_password = TRUE,
                failed_attempts = 0, locked_until = NULL, is_active = TRUE,
                role_id = $3, updated_at = now()
          WHERE id = $1`,
        [id, empreinte, role.id],
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'reinitialisation super-administrateur'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );
    } else {
      await tx.query(
        `INSERT INTO users
           (id, username, username_lower, email, email_lower, full_name,
            password_hash, must_change_password, role_id, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,TRUE)`,
        [id, identifiant, identifiant, courriel, courriel ? courriel.toLowerCase() : null,
         nomComplet, empreinte, role.id],
      );
    }

    await record({
      tx,
      actor: acteur,
      action: existant ? 'user.superadmin_reset' : 'user.superadmin_create',
      entity: 'user',
      entityId: id,
      entityLabel: identifiant,
      summary:
        (existant ? 'Reinitialisation' : 'Creation') +
        ' du compte super-administrateur « ' + identifiant + ' » depuis le serveur.',
      severity: 'critical',
      ip: null,
    });
  });

  const total = await value(
    "SELECT COUNT(*)::int FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'SUPERADMIN' AND u.is_active",
  );

  console.log('  ' + (existant ? 'Compte reinitialise.' : 'Compte cree.'));
  console.log('');
  console.log('    identifiant      ' + identifiant);
  console.log('    mot de passe     ' + motDePasse);
  console.log('    role             ' + role.name + ' (rang ' + role.rank + ')');
  console.log('');
  console.log('  Ce mot de passe ne sera plus affiche. Il doit etre change a la');
  console.log('  premiere connexion.');
  console.log('');
  console.log('  ' + total + ' compte(s) super-administrateur actif(s).');
  if (Number(total) < 2) {
    console.log('  Envisagez-en un second : ce role ne peut etre reinitialise que');
    console.log('  depuis le serveur.');
  }
  console.log('');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('\n  Echec : ' + err.message);
    if (err.detail) console.error('  Detail : ' + err.detail);
    await closePool().catch(() => {});
    process.exit(1);
  });

void config;
