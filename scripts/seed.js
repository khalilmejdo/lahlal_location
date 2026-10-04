#!/usr/bin/env node
/**
 * Remplit une base neuve, et met a jour une base existante.
 *
 *   npm run seed
 *
 * La commande se rejoue a chaque demarrage (scripts/demarrer.js). Elle doit
 * donc respecter une regle absolue :
 *
 *     ELLE N'ECRASE JAMAIS CE QUE L'EXPLOITANT A CHANGE.
 *
 * Un seuil d'alerte regle a 5 000 km, un type d'activite renomme, un role
 * dont les droits ont ete redefinis : tout cela survit au redemarrage. Ce
 * qui est realigne a chaque passage, en revanche, c'est ce qui n'appartient
 * pas a l'exploitant : le catalogue des permissions — une permission qui
 * disparait du code doit disparaitre de la base — et le RANG des roles, qui
 * decide de qui peut agir sur qui et ne doit pas pouvoir deriver.
 */
import { assertConfig, config } from '../server/core/config.js';
import { newId, hashPassword } from '../server/core/crypto.js';
import { one, value, transaction, closePool, ping } from '../server/db/index.js';
import { PERMISSIONS, PERMISSION_CODES, DEFAULT_ROLES } from '../server/core/rbac.js';
import { SETTINGS_PAR_DEFAUT, TYPES_ACTIVITE, TYPES_ENTRETIEN } from '../server/db/seed-data.js';

assertConfig();

const stats = {
  permissions: 0, permissionsRetirees: 0, roles: 0, rolesMisAJour: 0,
  rolesSupprimes: 0, rolesRetenus: [],
  reglages: 0, types: 0, comptes: 0,
};

/* ------------------------------------------------------------------ */
/*  Permissions : realignees sur le code, sans exception               */
/* ------------------------------------------------------------------ */

async function seedPermissions(tx) {
  for (const p of PERMISSIONS) {
    const { rowCount } = await tx.query(
      `INSERT INTO permissions (code, label, category, is_sensitive)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE
         SET label = EXCLUDED.label,
             category = EXCLUDED.category,
             is_sensitive = EXCLUDED.is_sensitive`,
      [p.code, p.label, p.category, Boolean(p.sensitive)],
    );
    stats.permissions += rowCount;
  }

  // Une permission retiree du code doit disparaitre de la base, sinon elle
  // reste cochable a l'ecran et ne ferme plus rien. Une case a cocher qui
  // ne protege rien est pire qu'une case absente : elle dispense de
  // chercher le vrai controle.
  const { rowCount } = await tx.query(
    'DELETE FROM permissions WHERE code <> ALL($1::text[])', [PERMISSION_CODES],
  );
  stats.permissionsRetirees = rowCount;
}

/* ------------------------------------------------------------------ */
/*  Roles                                                              */
/* ------------------------------------------------------------------ */

async function seedRoles(tx) {
  for (const role of DEFAULT_ROLES) {
    const existant = await tx.one('SELECT id, is_customized FROM roles WHERE code = $1', [role.code]);
    let id = existant?.id;

    if (!id) {
      id = newId();
      await tx.query(
        `INSERT INTO roles (id, code, name, description, is_system, rank, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, role.code, role.name, role.description, role.isSystem, role.rank, role.sort],
      );
      stats.roles += 1;
    } else {
      await tx.query(
        `UPDATE roles SET name = $2, description = $3, is_system = $4,
                          rank = $5, sort_order = $6
          WHERE id = $1`,
        [id, role.name, role.description, role.isSystem, role.rank, role.sort],
      );
      stats.rolesMisAJour += 1;
    }

    // Les droits d'un role redefini a l'ecran ne se rejouent pas : c'est une
    // decision du super-administrateur, elle vaut plus que le defaut livre.
    if (existant?.is_customized) continue;

    const codes = role.permissions === '*' ? PERMISSION_CODES : role.permissions;

    // On remplace l'ensemble plutot que d'ajouter : un droit retire du role
    // par defaut doit reellement partir.
    await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
    if (codes.length) {
      await tx.query(
        `INSERT INTO role_permissions (role_id, permission_code)
         SELECT $1, code FROM unnest($2::text[]) AS code
         ON CONFLICT DO NOTHING`,
        [id, codes],
      );
    }
  }

  await retirerRolesDisparus(tx);
}

/**
 * Les roles retires du code s'en vont — mais jamais sous les pieds de
 * quelqu'un.
 *
 * Le module a d'abord porte cinq roles, puis deux. Les trois autres
 * resteraient en base indefiniment : visibles a l'ecran de creation d'un
 * compte, attribuables, et porteurs de droits que plus personne ne relit.
 *
 * Un role encore DETENU n'est pas supprime : on ne retire pas ses droits a
 * quelqu'un pendant qu'il travaille. Le seed le signale, et c'est a
 * l'exploitant de deplacer les comptes concernes puis de relancer.
 */
async function retirerRolesDisparus(tx) {
  const connus = DEFAULT_ROLES.map((r) => r.code);

  const orphelins = await tx.all(
    `SELECT r.id, r.code, r.name,
            (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) AS comptes
       FROM roles r
      WHERE r.code <> ALL($1::text[])
      ORDER BY r.rank`,
    [connus],
  );

  for (const role of orphelins) {
    if (role.comptes > 0) {
      stats.rolesRetenus.push(role.code + ' (' + role.comptes + ' compte(s))');
      continue;
    }
    // role_permissions part en cascade (ON DELETE CASCADE).
    await tx.query('DELETE FROM roles WHERE id = $1', [role.id]);
    stats.rolesSupprimes += 1;
  }
}

/* ------------------------------------------------------------------ */
/*  Reglages et types : poses une fois, jamais rejoues                 */
/* ------------------------------------------------------------------ */

async function seedReglages(tx) {
  for (const s of SETTINGS_PAR_DEFAUT) {
    // DO NOTHING, et non DO UPDATE : un seuil regle a l'ecran ne revient pas
    // a sa valeur d'usine au redemarrage suivant. Seul le libelle, qui est
    // du texte d'interface et non une donnee, suit le code.
    const { rowCount } = await tx.query(
      `INSERT INTO settings (key, value, label, category, sort_order)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO UPDATE
         SET label = EXCLUDED.label,
             category = EXCLUDED.category,
             sort_order = EXCLUDED.sort_order`,
      [s.key, s.value, s.label, s.category, s.sort],
    );
    stats.reglages += rowCount;
  }
}

async function seedTypes(tx) {
  const poser = async (domaine, liste) => {
    for (const t of liste) {
      // Meme regle : un type renomme ou desactive reste tel quel (§35).
      const { rowCount } = await tx.query(
        `INSERT INTO types (domaine, code, libelle, sens, ordre, is_system, actif)
         VALUES ($1,$2,$3,$4,$5,TRUE,TRUE)
         ON CONFLICT (domaine, code) DO NOTHING`,
        [domaine, t.code, t.libelle, t.sens ?? 'MIXTE', t.ordre],
      );
      stats.types += rowCount;
    }
  };
  await poser('ACTIVITE', TYPES_ACTIVITE);
  await poser('ENTRETIEN', TYPES_ENTRETIEN);
}

/* ------------------------------------------------------------------ */
/*  Le premier compte                                                  */
/* ------------------------------------------------------------------ */

async function seedAdmin(tx) {
  const dejaDesComptes = await tx.value('SELECT COUNT(*)::int FROM users');
  if (dejaDesComptes > 0) return null;

  if (!config.bootstrap.password) {
    return { absent: true };
  }
  if (config.bootstrap.password.length < config.security.passwordMinLength) {
    throw new Error(
      'BOOTSTRAP_ADMIN_PASSWORD fait ' + config.bootstrap.password.length + ' caracteres ; ' +
      'le minimum est de ' + config.security.passwordMinLength + '.',
    );
  }

  const role = await tx.one("SELECT id FROM roles WHERE code = 'ADMIN'");
  const identifiant = String(config.bootstrap.username).toLowerCase();
  const courriel = config.bootstrap.email || null;
  const id = newId();

  await tx.query(
    `INSERT INTO users
       (id, username, username_lower, email, email_lower, full_name,
        password_hash, must_change_password, role_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,TRUE)`,
    [id, config.bootstrap.username, identifiant, courriel,
     courriel ? courriel.toLowerCase() : null, 'Administrateur',
     await hashPassword(config.bootstrap.password), role.id],
  );
  stats.comptes += 1;
  return { identifiant };
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('\n  Connexion a la base...');
  console.log('  Base joignable (' + (await ping()) + ' ms).\n');

  let admin = null;
  await transaction(async (tx) => {
    // Le seed se joue au demarrage de chaque replique : sans verrou, deux
    // d'entre elles inserent les memes permissions au meme instant et se
    // prennent les verrous de tables dans un ordre different. Meme raison
    // que dans scripts/migrate.js.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('flotte.seed'))");
    await seedPermissions(tx);
    await seedRoles(tx);
    await seedReglages(tx);
    await seedTypes(tx);
    admin = await seedAdmin(tx);
  });

  console.log('  Permissions ......... ' + stats.permissions + ' posee(s)' +
    (stats.permissionsRetirees ? ', ' + stats.permissionsRetirees + ' retiree(s)' : ''));
  console.log('  Roles ............... ' + stats.roles + ' cree(s), ' +
    stats.rolesMisAJour + ' mis a jour' +
    (stats.rolesSupprimes ? ', ' + stats.rolesSupprimes + ' retire(s)' : ''));
  for (const retenu of stats.rolesRetenus) {
    console.log('    ATTENTION : le role ' + retenu + ' n existe plus dans le code,');
    console.log('    mais il est encore detenu. Deplacez ces comptes, puis relancez.');
  }
  console.log('  Reglages ............ ' + stats.reglages + ' pose(s)');
  console.log('  Types ............... ' + stats.types + ' pose(s)');

  if (admin?.identifiant) {
    console.log('  Compte initial ...... « ' + admin.identifiant + ' » cree ' +
      '(mot de passe a changer a la premiere connexion)');
  } else if (admin?.absent) {
    console.log('  Compte initial ...... AUCUN : BOOTSTRAP_ADMIN_PASSWORD n est pas renseigne.');
  } else {
    console.log('  Compte initial ...... deja present, rien a faire');
  }

  const total = await value('SELECT COUNT(*)::int FROM users');
  if (Number(total) === 0) {
    console.log('\n  Aucun compte : personne ne peut se connecter.');
    console.log('  Renseignez BOOTSTRAP_ADMIN_PASSWORD puis relancez, ou creez');
    console.log('  un super-administrateur : npm run superadmin');
    console.log('');
    return;
  }

  /*
   * L'INSTALLATION N'EST PAS FINIE SANS SUPER-ADMINISTRATEUR.
   *
   * Depuis le passage a deux roles, trois gestes lui sont reserves : creer
   * un compte, reinitialiser un mot de passe, et restaurer une piece
   * jointe. Un deploiement qui s'arrete au compte d'amorcage donne donc une
   * application qui tourne — et dans laquelle on ne peut ni ajouter un
   * collegue, ni depanner quelqu'un qui a perdu son mot de passe.
   *
   * Le defaut se decouvrirait le jour ou l'on en a besoin, c'est-a-dire au
   * plus mauvais moment. Il se dit donc ici, a chaque demarrage, tant qu'il
   * dure.
   */
  const superadmins = await value(
    `SELECT COUNT(*)::int FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.code = 'SUPERADMIN' AND u.is_active`,
  );
  if (Number(superadmins) === 0) {
    console.log('');
    console.log('  ATTENTION : aucun super-administrateur.');
    console.log('');
    console.log('  Trois gestes lui sont reserves et ne sont donc possibles pour');
    console.log('  personne aujourd hui : creer un compte, reinitialiser un mot de');
    console.log('  passe, restaurer une piece jointe supprimee.');
    console.log('');
    console.log('    npm run superadmin -- --username direction --nom "Nom Prenom"');
    console.log('');
    console.log('  Le mot de passe s affiche UNE fois. Prevoyez-en deux comptes :');
    console.log('  ce role ne se reinitialise que depuis le serveur.');
  } else {
    console.log('  Super-administrateur .. ' + superadmins + ' compte(s) actif(s)');
  }
  console.log('');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('\n  Echec du seed : ' + err.message);
    if (err.detail) console.error('  Detail : ' + err.detail);
    await closePool().catch(() => {});
    process.exit(1);
  });
