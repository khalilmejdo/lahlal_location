/**
 * Les cohérences qu'aucun écran ne montre.
 *
 * Ce fichier ne teste pas une fonctionnalité : il teste que deux endroits
 * qui doivent dire la même chose la disent. Ce sont les défauts les plus
 * coûteux, parce qu'ils ne se voient qu'en production — un seuil livré qui
 * ne correspond pas au défaut du code, une permission écrite dans une route
 * mais absente du catalogue, une route qui a oublié d'en déclarer une.
 *
 * L'inspiration vient de lahlal_samuplus, qui porte une famille entière de
 * contrôles de ce genre (surface-des-droits, code-mort, alias-sql-uniques).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PERMISSION_CODES, PERMISSIONS, DEFAULT_ROLES, RESERVE_SUPERADMIN } from '../server/core/rbac.js';
import { SEUILS_PAR_DEFAUT, BORNES_SEUILS, lireSeuils } from '../server/domain/echeances.js';
import { SETTINGS_PAR_DEFAUT, TYPES_ACTIVITE, TYPES_ENTRETIEN } from '../server/db/seed-data.js';
import { REGLAGES_POSTURE } from '../server/core/posture.js';
import { buildRouter } from '../server/app.js';

const RACINE = new URL('../', import.meta.url);

/* ------------------------------------------------------------------ */

describe('Les seuils livrés valent les seuils du code', () => {
  const parCle = new Map(SETTINGS_PAR_DEFAUT.map((s) => [s.key, s.value]));

  test('chaque seuil du domaine est livré en base, à la même valeur', () => {
    for (const [champ, regle] of Object.entries(BORNES_SEUILS)) {
      const livre = parCle.get(regle.cle);
      assert.ok(livre !== undefined, 'seuil absent du seed : ' + regle.cle);
      assert.equal(
        Number(livre), SEUILS_PAR_DEFAUT[champ],
        regle.cle + ' : le seed livre ' + livre + ', le code applique ' + SEUILS_PAR_DEFAUT[champ],
      );
    }
  });

  test('chaque valeur livrée tient dans ses propres bornes', () => {
    for (const regle of Object.values(BORNES_SEUILS)) {
      const v = Number(parCle.get(regle.cle));
      assert.ok(v >= regle.min && v <= regle.max,
        regle.cle + ' = ' + v + ' hors de [' + regle.min + ', ' + regle.max + ']');
    }
  });

  test('une base vide applique exactement les valeurs par défaut', () => {
    assert.deepEqual(lireSeuils([]), { ...SEUILS_PAR_DEFAUT });
    assert.deepEqual(lireSeuils(null), { ...SEUILS_PAR_DEFAUT });
  });

  test('chaque réglage de posture est livré en base', () => {
    for (const cle of Object.keys(REGLAGES_POSTURE)) {
      assert.ok(parCle.has(cle), 'réglage de posture absent du seed : ' + cle);
    }
  });

  test('aucun réglage livré n’est inconnu du code', () => {
    const connus = new Set([
      ...Object.values(BORNES_SEUILS).map((r) => r.cle),
      ...Object.keys(REGLAGES_POSTURE),
    ]);
    const orphelins = SETTINGS_PAR_DEFAUT.map((s) => s.key).filter((k) => !connus.has(k));
    assert.deepEqual(orphelins, [],
      'réglages livrés que rien ne lit : ' + orphelins.join(', '));
  });

  test('chaque réglage porte un libellé lisible par un non-informaticien', () => {
    for (const s of SETTINGS_PAR_DEFAUT) {
      assert.ok(s.label && s.label.length > 10, s.key + ' : libellé trop court');
      assert.ok(!/[_.]/.test(s.label), s.key + ' : le libellé ressemble à une clé technique');
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Les droits', () => {
  test('aucune permission n’est déclarée deux fois', () => {
    assert.equal(new Set(PERMISSION_CODES).size, PERMISSION_CODES.length);
  });

  test('chaque permission porte un libellé et une catégorie', () => {
    for (const p of PERMISSIONS) {
      assert.match(p.code, /^[a-z]+\.[a-z_]+$/, 'code mal formé : ' + p.code);
      assert.ok(p.label?.length > 5, p.code + ' : libellé absent');
      assert.ok(p.category?.length > 2, p.code + ' : catégorie absente');
    }
  });

  test('les rôles ne référencent que des permissions connues', () => {
    for (const role of DEFAULT_ROLES) {
      if (role.permissions === '*') continue;
      for (const code of role.permissions) {
        assert.ok(PERMISSION_CODES.includes(code),
          role.code + ' référence une permission inconnue : ' + code);
      }
    }
  });

  test('la réserve du super-administrateur ne cite que des permissions connues', () => {
    for (const code of RESERVE_SUPERADMIN) {
      assert.ok(PERMISSION_CODES.includes(code), 'réservée mais inconnue : ' + code);
    }
  });

  test('les rangs sont strictement ordonnés : c’est eux qui disent qui agit sur qui', () => {
    const rangs = DEFAULT_ROLES.map((r) => r.rank);
    assert.equal(new Set(rangs).size, rangs.length, 'deux rôles partagent un rang');
    assert.equal(Math.min(...rangs), 0, 'le super-administrateur doit être au rang 0');
  });

  test('le rôle de saisie terrain ne peut ni modifier ni supprimer', () => {
    // C'est le rôle prévu pour le téléphone (§23) : il enregistre et
    // photographie, il ne réécrit pas l'historique.
    const saisie = DEFAULT_ROLES.find((r) => r.code === 'SAISIE');
    for (const interdit of ['activity.edit', 'activity.delete', 'vehicle.archive',
      'maintenance.delete', 'attachment.delete', 'settings.edit', 'user.manage']) {
      assert.ok(!saisie.permissions.includes(interdit),
        'SAISIE ne doit pas détenir ' + interdit);
    }
  });

  test('le rôle de consultation ne détient aucun droit d’écriture', () => {
    const lecture = DEFAULT_ROLES.find((r) => r.code === 'LECTURE');
    const ecritures = lecture.permissions.filter((p) =>
      /\.(create|edit|delete|archive|close|add|manage|force_mileage)$/.test(p));
    assert.deepEqual(ecritures, [], 'LECTURE détient : ' + ecritures.join(', '));
  });
});

/* ------------------------------------------------------------------ */

/**
 * Les rares routes qu'un compte authentifié appelle sans droit particulier.
 *
 * Elles sont listées ici, une par une : une route qui s'ajouterait à cette
 * famille par oubli ferait échouer le contrôle ci-dessous, et c'est le but.
 */
const CHEMINS_SANS_DROIT = new Set([
  '/api/meta',                 // les référentiels d'amorçage ; le contenu s'adapte aux droits
  '/api/auth/logout',
  '/api/auth/password',        // changer SON mot de passe
  '/api/auth/sessions',        // voir SES sessions
  '/api/auth/sessions/:id',    // fermer l'une des siennes
]);

describe('La surface exposée', () => {
  const router = buildRouter();
  const toutes = [...router.routes.entries()]
    .flatMap(([verbe, liste]) => liste.map((r) => ({ verbe, ...r })));

  test('le routeur expose bien toutes les familles du module', () => {
    const chemins = toutes.map((r) => r.path).join(' ');
    for (const famille of ['/api/vehicules', '/api/activites', '/api/entretiens',
      '/api/fichiers', '/api/tableau-de-bord', '/api/statistiques',
      '/api/exports', '/api/reglages', '/api/utilisateurs', '/api/audit']) {
      assert.ok(chemins.includes(famille), 'famille absente : ' + famille);
    }
  });

  test('chaque route déclare une permission, ou dit explicitement qu’elle est ouverte', () => {
    // Le routeur refuse par défaut : une route sans annotation exige une
    // session. Ce test va plus loin — il veut une DÉCISION écrite, pour
    // qu'aucune route ne devienne ouverte par oubli.
    const sansDecision = toutes.filter((r) => {
      const o = r.options || {};
      return !o.public && !o.permission && !CHEMINS_SANS_DROIT.has(r.path);
    });
    assert.deepEqual(sansDecision.map((r) => r.verbe + ' ' + r.path), [],
      'routes sans permission déclarée');
  });

  test('les permissions citées par les routes existent au catalogue', () => {
    for (const r of toutes) {
      const p = r.options?.permission;
      if (!p) continue;
      for (const code of Array.isArray(p) ? p : [p]) {
        assert.ok(PERMISSION_CODES.includes(code),
          r.verbe + ' ' + r.path + ' exige « ' + code +' », absent du catalogue');
      }
    }
  });

  test('toute route d’écriture exige une permission', () => {
    // Les seules exceptions sont les gestes qu'on fait sur SOI : se
    // déconnecter, changer son mot de passe, fermer sa propre session.
    // Exiger une permission pour cela enfermerait dehors un compte dont on
    // vient justement de retirer les droits.
    const ecritures = toutes.filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.verbe));
    const nues = ecritures.filter((r) =>
      !r.options?.permission && !r.options?.public && !CHEMINS_SANS_DROIT.has(r.path));
    assert.deepEqual(nues.map((r) => r.verbe + ' ' + r.path), [],
      'écritures sans permission');
  });

  test('les seules routes publiques sont celles qui doivent l’être', () => {
    const publiques = toutes.filter((r) => r.options?.public).map((r) => r.verbe + ' ' + r.path);
    assert.deepEqual(publiques.sort(), [
      'GET /healthz',
      'GET /api/auth/session',
      'POST /api/auth/login',
    ].sort());
  });
});

/* ------------------------------------------------------------------ */

describe('Les types livrés', () => {
  const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

  test('chaque code respecte la contrainte du schéma', () => {
    for (const t of [...TYPES_ACTIVITE, ...TYPES_ENTRETIEN]) {
      assert.match(t.code, CODE, 'code refusé par la base : ' + t.code);
      assert.ok(t.libelle && t.libelle.length <= 60, t.code + ' : libellé hors bornes');
    }
  });

  test('aucun code n’est livré deux fois dans le même domaine', () => {
    for (const liste of [TYPES_ACTIVITE, TYPES_ENTRETIEN]) {
      const codes = liste.map((t) => t.code);
      assert.equal(new Set(codes).size, codes.length);
    }
  });

  test('le sens d’un type d’activité est l’une des trois valeurs admises', () => {
    for (const t of TYPES_ACTIVITE) {
      assert.ok(['DEPENSE', 'RECETTE', 'MIXTE'].includes(t.sens), t.code + ' : sens ' + t.sens);
    }
  });

  test('les types du §35 sont tous livrés', () => {
    const codes = TYPES_ENTRETIEN.map((t) => t.code);
    for (const attendu of ['VIDANGE', 'REVISION', 'PNEUS', 'CONTROLE_TECHNIQUE',
      'ASSURANCE', 'BATTERIE', 'FREINS', 'DISTRIBUTION', 'AUTRE']) {
      assert.ok(codes.includes(attendu), 'type d’entretien manquant : ' + attendu);
    }
  });

  test('les types du §5 sont tous livrés', () => {
    const codes = TYPES_ACTIVITE.map((t) => t.code);
    for (const attendu of ['LOCATION', 'REMORQUAGE', 'DEPANNAGE', 'TRANSPORT',
      'INTERVENTION', 'ENTRETIEN', 'REPARATION', 'CARBURANT',
      'ASSURANCE', 'CONTROLE_TECHNIQUE', 'AUTRE']) {
      assert.ok(codes.includes(attendu), 'type d’activité manquant : ' + attendu);
    }
  });

  test('un intervalle suggéré reste dans les bornes du schéma', () => {
    for (const t of TYPES_ENTRETIEN) {
      if (t.intervalleKm !== null) {
        assert.ok(t.intervalleKm >= 100 && t.intervalleKm <= 500000, t.code);
      }
      if (t.intervalleMois !== null) {
        assert.ok(t.intervalleMois >= 1 && t.intervalleMois <= 240, t.code);
      }
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Le schéma et le code', () => {
  const schema = fs.readFileSync(new URL('server/db/schema.sql', RACINE), 'utf8');

  test('le résultat est calculé par la base, pas par l’application', () => {
    // Trois écrans l'affichent ; une seule soustraction doit exister.
    assert.match(schema, /resultat_cents\s+BIGINT GENERATED ALWAYS AS \(recette_cents - depense_cents\) STORED/);
  });

  test('le kilométrage courant est une vue, pas une colonne dénormalisée', () => {
    assert.match(schema, /CREATE OR REPLACE VIEW v_vehicules/);
    assert.ok(!/ALTER TABLE vehicules[^;]*ADD COLUMN[^;]*\bkilometrage\b\s+INTEGER/.test(schema),
      'une colonne kilometrage dénormalisée est réapparue');
  });

  test('le journal d’audit refuse d’être modifié', () => {
    assert.match(schema, /CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log/);
  });

  test('les index de filtrage du §32 existent', () => {
    for (const attendu of ['idx_activites_vehicule_date', 'idx_activites_date',
      'idx_activites_type', 'idx_activites_kilometrage',
      'idx_entretiens_date', 'idx_entretiens_km']) {
      assert.ok(schema.includes(attendu), 'index absent : ' + attendu);
    }
  });

  test('aucune table ni colonne de TVA (§7)', () => {
    const lignes = schema.split('\n')
      .filter((l) => !/^\s*--/.test(l))
      .filter((l) => /\btva\b|taux|_bp\b/i.test(l));
    assert.deepEqual(lignes, [], 'lignes fiscales dans le schéma : ' + lignes.join(' | '));
  });

  test('les montants sont des entiers, jamais des décimaux flottants', () => {
    // Les commentaires sont écartés : l'en-tête du schéma explique
    // précisément pourquoi NUMERIC est proscrit, et il a le droit de le dire.
    const lignes = schema.split('\n')
      .filter((l) => !/^\s*--/.test(l))
      .filter((l) => /\b(NUMERIC|REAL|DOUBLE PRECISION|FLOAT)\b/i.test(l));
    assert.deepEqual(lignes, [], 'types à virgule trouvés : ' + lignes.join(' | '));
  });
});

/* ------------------------------------------------------------------ */

describe('Aucune trace du domaine d’origine', () => {
  /**
   * Le socle vient de lahlal_samuplus : il ne doit rien rester de SON
   * métier ici. Une table `invoices` citée dans une requête, un exercice
   * comptable, un bénéficiaire : autant de code repris sans être adapté,
   * qui tomberait à la première exécution.
   */
  const fichiers = [];
  const parcourir = (dossier) => {
    for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
      const p = path.join(dossier, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (/\.(js|mjs|sql)$/.test(e.name)) fichiers.push(p);
    }
  };
  for (const racine of ['server', 'scripts', 'public/js']) {
    if (fs.existsSync(racine)) parcourir(racine);
  }

  /** Une ligne de commentaire ne s'exécute pas : elle est écartée. */
  const estCommentaire = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

  test('aucun identifiant SQL du socle d’origine ne subsiste', () => {
    const interdits = /\b(FROM|JOIN|INTO|UPDATE)\s+(invoices|missions|quotes|payments|clients|drivers|company_settings|data_access_log|vehicle_documents|vehicle_maintenances)\b/i;
    const coupables = [];
    for (const f of fichiers) {
      const source = fs.readFileSync(f, 'utf8');
      for (const [i, ligne] of source.split('\n').entries()) {
        if (!estCommentaire(ligne) && interdits.test(ligne)) coupables.push(f + ':' + (i + 1));
      }
    }
    assert.deepEqual(coupables, [], 'tables du socle d’origine encore interrogées');
  });

  test('aucun appel à un module resté dans le socle d’origine', () => {
    const coupables = [];
    for (const f of fichiers) {
      const source = fs.readFileSync(f, 'utf8');
      for (const [i, ligne] of source.split('\n').entries()) {
        if (estCommentaire(ligne)) continue;
        for (const m of ligne.matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
          const cible = path.resolve(path.dirname(f), m[1]);
          if (!fs.existsSync(cible)) coupables.push(f + ':' + (i + 1) + ' -> ' + m[1]);
        }
      }
    }
    assert.deepEqual(coupables, [], 'imports vers des fichiers absents');
  });
});
