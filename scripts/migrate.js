#!/usr/bin/env node
/**
 * Applique le schema PostgreSQL.
 *
 *   npm run migrate
 *
 * Le fichier server/db/schema.sql est idempotent : la commande peut etre
 * rejouee sans dommage, ce qui permet de l'inclure dans le buildCommand Render.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertConfig, ROOT } from '../server/core/config.js';
import { query, transaction, closePool, ping } from '../server/db/index.js';
import { erreurBaseIndisponible } from '../server/core/errors.js';

assertConfig();

const schemaPath = path.join(ROOT, 'server', 'db', 'schema.sql');

async function main() {
  console.log('\n  Connexion a la base...');
  const ms = await ping();
  console.log('  Base joignable (' + ms + ' ms).');

  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('  Application du schema...');
  // Le fichier entier est joue dans une seule transaction : en cas d'erreur,
  // la base reste exactement dans l'etat ou elle etait.
  await transaction(async (tx) => {
    // I-D9 : le pool impose un delai de quinze secondes a chaque instruction,
    // et ce fichier en est UNE — soixante-huit kilo-octets, tables, index et
    // vues compris. Le delai est fait pour une requete d'ecran ; une creation
    // d'index sur deux cent mille factures le depasse largement. La migration
    // se faisait alors annuler (« canceling statement due to statement
    // timeout »), et demarrer.js interrompait le demarrage pour ne pas servir
    // une base incoherente : le conteneur ne repartait plus, sur une base qui
    // n'avait pourtant rien d'anormal, sinon d'avoir grandi.
    //
    // SET LOCAL : la valeur ne vaut que pour cette transaction et revient au
    // COMMIT. La connexion rendue au pool retrouve les quinze secondes.
    //
    // Dix minutes, et non zero : une migration bloquee doit finir par rendre
    // la main plutot que de tenir le demarrage indefiniment, ou personne ne
    // saurait s'il faut attendre ou intervenir.
    await tx.query("SET LOCAL statement_timeout = '600s'");
    // B-6 : un orchestrateur qui demarre plusieurs repliques lance autant de
    // migrations au meme instant. Deux passent ; a quatre, elles se prennent
    // les verrous de tables dans un ordre different et Postgres en tue deux
    // pour interblocage (40P01) — que db/index.js traduisait en « Une autre
    // ecriture a touche les memes donnees » : un message de saisie de
    // facture, lu par un exploitant devant un conteneur qui ne demarre pas.
    // Le verrou consultatif serialise les migrations : la seconde attend la
    // premiere, puis rejoue un fichier idempotent et conclut « Schema
    // applique ». Il tombe avec la transaction, COMMIT ou ROLLBACK.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('flotte.migration'))");
    await tx.query(sql);
  });

  const tables = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const views = await query(
    `SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' ORDER BY table_name`,
  );

  await query(
    `INSERT INTO app_meta(key, value, updated_at) VALUES ('schema.applied_at', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [new Date().toISOString()],
  );

  console.log('\n  Schema applique.');
  console.log('  ' + tables.rowCount + ' tables : ' + tables.rows.map((r) => r.table_name).join(', '));
  console.log('  ' + views.rowCount + ' vues   : ' + views.rows.map((r) => r.table_name).join(', '));
  console.log('\n  Etape suivante : npm run seed\n');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    // B-8 : une connexion coupee pendant la migration (serveur arrete,
    // pg_terminate_backend, reseau) remontait en « Unhandled 'error' event »
    // avec une pile d'appels, parce que le client pg emettait « error » sans
    // ecouteur ; db/index.js en pose un desormais, et l'erreur arrive ici,
    // dite en francais. La transaction n'a rien applique.
    const indisponible = erreurBaseIndisponible(err);
    if (indisponible) {
      console.error('\n  Echec de la migration : ' + indisponible.message);
      console.error('  (' + err.message + ')');
      await closePool().catch(() => {});
      process.exit(1);
    }
    if (err.status === 409) {
      console.error('\n  Echec de la migration : une autre migration tournait au meme instant.');
      console.error('  Rien n a ete applique : relancez.');
      await closePool().catch(() => {});
      process.exit(1);
    }
    console.error('\n  Echec de la migration : ' + err.message);
    if (err.position) console.error('  Position dans le SQL : ' + err.position);
    if (err.detail) console.error('  Detail : ' + err.detail);
    await closePool().catch(() => {});
    process.exit(1);
  });
