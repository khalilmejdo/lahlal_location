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

  test('deux rôles, et deux seulement', () => {
    // Décision du 4 octobre 2026 : cette flotte se tient à deux ou trois
    // personnes qui font le même travail. Cinq rôles, c'était cinq jeux de
    // droits à maintenir et une matrice que personne ne relit.
    assert.deepEqual(DEFAULT_ROLES.map((r) => r.code), ['SUPERADMIN', 'ADMIN']);
  });

  test('le super-administrateur détient tout', () => {
    const su = DEFAULT_ROLES.find((r) => r.code === 'SUPERADMIN');
    assert.equal(su.permissions, '*');
    assert.equal(su.rank, 0);
  });

  test('l’administrateur détient tout, sauf exactement ce qui est réservé', () => {
    // L'écart entre les deux rôles doit être LISIBLE : il se lit dans
    // RESERVE_SUPERADMIN, et nulle part ailleurs.
    const admin = DEFAULT_ROLES.find((r) => r.code === 'ADMIN');
    const manquantes = PERMISSION_CODES.filter((c) => !admin.permissions.includes(c));
    assert.deepEqual(manquantes.sort(), [...RESERVE_SUPERADMIN].sort());
  });

  test('ce qui est réservé touche la hiérarchie ou le filet, rien d’autre', () => {
    /*
     * Avec deux rôles, la réserve est le SEUL garde-fou de droits qui
     * reste. Elle doit donc rester minuscule et justifiable :
     *
     *   - redéfinir les droits d'un rôle, parce qu'on ne se hisse pas
     *     au-dessus de sa propre hiérarchie ;
     *   - gérer les comptes, pour la même raison — et parce que le rang
     *     l'interdirait de toute façon entre administrateurs ;
     *   - restaurer une pièce jointe, parce qu'un filet que tout le monde
     *     peut relever n'en est plus un.
     *
     * Toute autre entrée ici demande une raison écrite.
     */
    assert.deepEqual([...RESERVE_SUPERADMIN].sort(),
      ['attachment.restore', 'role.manage', 'user.manage']);
  });

  test('aucun droit réservé ne reste sans effet pour l’administrateur', () => {
    /*
     * Une case à cocher qui ne ferme rien est pire qu'une case absente :
     * elle dispense de chercher le vrai contrôle. Chaque droit réservé doit
     * donc être EXIGÉ par au moins une route — sinon il décore.
     */
    const router = buildRouter();
    const exigees = new Set();
    for (const [, liste] of router.routes) {
      for (const r of liste) {
        const p = r.options?.permission;
        for (const code of Array.isArray(p) ? p : [p]) if (code) exigees.add(code);
      }
    }
    const decoratives = RESERVE_SUPERADMIN.filter((c) => !exigees.has(c));
    assert.deepEqual(decoratives, [],
      'droits réservés qu’aucune route n’exige : ' + decoratives.join(', '));
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

  test('aucun écran n’appelle un helper de core.js sans l’importer', () => {
    /*
     * CE QUE check-imports NE VOIT PAS.
     *
     * Le vérificateur d'imports contrôle que chaque nom IMPORTÉ existe bien
     * à l'export. Il ne dit rien du contraire : un helper appelé mais
     * jamais importé passe l'analyse, passe `node --check`, et n'échoue
     * qu'à l'exécution — sur l'écran concerné, chez l'utilisateur.
     *
     * C'est arrivé deux fois pendant l'écriture de ce module, avec
     * `donnee()` puis `texteEcheance()`. Ce contrôle ferme la classe
     * entière plutôt que les deux cas.
     */
    const core = fs.readFileSync(new URL('public/js/core.js', RACINE), 'utf8');
    const exportes = [...core.matchAll(/^export (?:function|const|class)\s+(\w+)/gm)]
      .map((m) => m[1]);
    assert.ok(exportes.length > 10, 'les exports de core.js ne se lisent pas');

    const coupables = [];
    for (const f of fichiers.filter((x) => x.includes(path.join('public', 'js')))) {
      if (f.endsWith(path.join('js', 'core.js'))) continue;

      // Les commentaires sont écartés : une mention dans une explication
      // n'est pas un appel.
      const source = fs.readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const imports = (source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? []).join('\n');
      const corps = source.replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '');

      for (const nom of exportes) {
        // Un appel, une lecture de propriété ou un passage en argument.
        if (!new RegExp('\\b' + nom + '\\s*\\(').test(corps)) continue;
        // Défini localement dans ce fichier ? Alors ce n'est pas celui-là.
        if (new RegExp('(?:function|const|let)\\s+' + nom + '\\b').test(corps)) continue;
        if (!new RegExp('\\b' + nom + '\\b').test(imports)) {
          coupables.push(path.basename(f) + ' → ' + nom + '()');
        }
      }
    }
    assert.deepEqual(coupables, [], 'helpers appelés sans import : ' + coupables.join(', '));
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

/* ------------------------------------------------------------------ */

describe('La traduction en darija', () => {
  const source = fs.readFileSync(new URL('public/js/i18n.js', RACINE), 'utf8');

  /** Le dictionnaire, extrait du module sans le charger (il touche au DOM). */
  const clesDuDictionnaire = () => {
    const bloc = source.slice(source.indexOf('const ARY = {'), source.lastIndexOf('};'));
    return [...bloc.matchAll(/^\s*(?:'([^']+)'|([A-Za-zÀ-ÿ]+)):\s*'/gm)]
      .map((m) => m[1] ?? m[2]);
  };

  test('les deux langues sont déclarées, avec leur sens d’écriture', () => {
    assert.match(source, /code: 'fr'.*sens: 'ltr'/s);
    assert.match(source, /code: 'ary'.*sens: 'rtl'/s);
  });

  test('le code de langue est « ary », pas « ar »', () => {
    // « ar » désigne l'arabe standard. Un navigateur réglé en arabe
    // standard ne doit pas recevoir de la darija sans l'avoir demandé.
    assert.ok(!/code: 'ar'[,\s]/.test(source), 'le code « ar » ne doit pas être utilisé');
  });

  test('aucune clé ne porte le libellé d’un type livré', () => {
    /*
     * C'EST LE PIÈGE QUE CE TEST FERME.
     *
     * Les libellés de types viennent de la base et se renomment à l'écran.
     * Si « Vidange » figurait au dictionnaire, il serait traduit à
     * l'affichage — et renommer ce type n'aurait plus d'effet visible tant
     * que l'ancien nom y resterait. Le libellé d'un type est une DONNÉE.
     */
    const cles = new Set(clesDuDictionnaire());
    const collisions = [...TYPES_ACTIVITE, ...TYPES_ENTRETIEN]
      .map((t) => t.libelle)
      .filter((libelle) => cles.has(libelle));
    assert.deepEqual(collisions, [],
      'libellés de types présents au dictionnaire : ' + collisions.join(', '));
  });

  test('aucun nom de rôle livré ne figure au dictionnaire', () => {
    // Même raison : les rôles vivent en base et sont renommables.
    const cles = new Set(clesDuDictionnaire());
    const collisions = DEFAULT_ROLES.map((r) => r.name).filter((n) => cles.has(n));
    assert.deepEqual(collisions, [], 'noms de rôles au dictionnaire : ' + collisions.join(', '));
  });

  test('chaque traduction est écrite en caractères arabes', () => {
    // Une entrée laissée en français serait une traduction oubliée qui se
    // présente comme faite : elle ne figurerait plus dans le relevé des
    // chaînes manquantes.
    const bloc = source.slice(source.indexOf('const ARY = {'), source.lastIndexOf('};'));
    const sansArabe = [...bloc.matchAll(/^\s*(?:'([^']+)'|([A-Za-zÀ-ÿ]+)):\s*'([^']+)'/gm)]
      .filter((m) => !/[؀-ۿ]/.test(m[3]))
      .map((m) => (m[1] ?? m[2]) + ' -> ' + m[3]);
    assert.deepEqual(sansArabe, [], 'entrées sans caractère arabe : ' + sansArabe.join(' | '));
  });

  test('la feuille de style porte les règles de droite à gauche', () => {
    const css = fs.readFileSync(new URL('public/css/app.css', RACINE), 'utf8');
    assert.match(css, /\[dir="rtl"\]/, 'aucune règle RTL');
    // Les chiffres se lisent de gauche à droite même en darija.
    assert.match(css, /\[dir="rtl"\][^{]*\.num[^{]*\{[^}]*direction: ltr/);
  });
});

/* ------------------------------------------------------------------ */

describe('Les dates sont calendaires, pas des instants UTC', () => {
  /*
   * LE DÉFAUT QUE CE CONTRÔLE FERME.
   *
   * `today()` rendait `new Date().toISOString().slice(0, 10)`, c'est-à-dire
   * la date UTC. Au Maroc (UTC+1), entre minuit et une heure du matin, il
   * est déjà demain localement et encore aujourd'hui en UTC : l'activité
   * qu'on venait de finir était refusée comme « dans le futur ».
   *
   * Le défaut ne se voit qu'une heure par jour — et c'est justement l'heure
   * à laquelle une équipe de nuit saisit sa journée.
   */
  test('today() suit le fuseau du serveur, pas UTC', () => {
    const source = fs.readFileSync(new URL('server/core/text.js', RACINE), 'utf8');
    const corps = source.slice(source.indexOf('export function today()'));
    const fin = corps.indexOf('\n}');
    assert.ok(!/toISOString/.test(corps.slice(0, fin)),
      'today() repasse par toISOString() : la date redevient UTC');
    assert.match(corps.slice(0, fin), /getFullYear|toLocaleDateString/);
  });

  test('today() rend bien une date ISO valide', async () => {
    const { today, isValidIsoDate } = await import('../server/core/text.js');
    assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(isValidIsoDate(today()), true);
  });

  test('le déploiement pose un fuseau', () => {
    // Un conteneur n'hérite pas du fuseau de son hôte : sans TZ, il repart
    // en UTC, et le défaut ci-dessus revient par la porte de service.
    for (const fichier of ['.env.example', 'Dockerfile', 'docker-compose.yml']) {
      const contenu = fs.readFileSync(new URL(fichier, RACINE), 'utf8');
      assert.match(contenu, /TZ[=:]\s*Africa\/Casablanca/, fichier + ' ne pose pas TZ');
    }
    // Alpine ne connaît aucun fuseau nommé sans tzdata : TZ y serait sans effet.
    const dockerfile = fs.readFileSync(new URL('Dockerfile', RACINE), 'utf8');
    assert.match(dockerfile, /apk add[^\n]*tzdata/, 'tzdata absente de l’image');
  });
});

/* ------------------------------------------------------------------ */

describe('L’historisation : aucune écriture sans trace', () => {
  /*
   * AVEC DEUX ROLES, LA TRACE REMPLACE LA RESTRICTION.
   *
   * Un administrateur peut tout faire. Ce qui répond à l'erreur n'est donc
   * plus le refus — c'est le journal : qui, quand, quoi, et pourquoi. Une
   * route d'écriture qui oublie `record()` ouvre un angle mort dans
   * exactement le dispositif qui tient lieu de garde-fou.
   *
   * Le contrôle est grossier — il compte — mais il attrape le cas qui
   * arrive vraiment : une route ajoutée dans un fichier existant sans que
   * l'on pense au journal.
   */
  const DOSSIER = new URL('server/routes/', RACINE);

  test('chaque fichier de routes trace au moins autant qu’il écrit', () => {
    const manques = [];
    for (const nom of fs.readdirSync(DOSSIER)) {
      const source = fs.readFileSync(new URL(nom, DOSSIER), 'utf8');
      const ecritures = (source.match(/Routes\.(post|patch|put|delete)\(/g) ?? []).length;
      if (!ecritures) continue;
      const traces = (source.match(/\brecord\(\{/g) ?? []).length;
      if (traces < ecritures) {
        manques.push(nom + ' : ' + ecritures + ' écriture(s), ' + traces + ' trace(s)');
      }
    }
    assert.deepEqual(manques, [], 'routes d’écriture sans trace : ' + manques.join(' | '));
  });

  test('tout geste destructeur exige un motif', () => {
    /*
     * Un motif obligatoire n'est pas une formalité : c'est la seule chose
     * qui, dans six mois, dira POURQUOI cette activité a disparu de
     * l'historique. Sans lui, le journal dit qui et quand — et laisse la
     * question qui compte sans réponse.
     */
    const attendus = [
      ['activites.js', 'DELETE', 'mise à la corbeille d’une activité'],
      ['vehicules.js', '/:id/archiver', 'archivage d’un véhicule'],
      ['entretiens.js', '/:id/clore', 'clôture d’une échéance'],
      ['fichiers.js', 'DELETE', 'suppression d’une pièce jointe'],
    ];
    for (const [fichier, , quoi] of attendus) {
      const source = fs.readFileSync(new URL(fichier, DOSSIER), 'utf8');
      assert.match(source, /rules\.requiredReason/,
        quoi + ' : aucun motif obligatoire dans ' + fichier);
    }
  });

  test('le journal ne peut pas être modifié, même avec un accès à la base', () => {
    const schema = fs.readFileSync(new URL('server/db/schema.sql', RACINE), 'utf8');
    assert.match(schema, /CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log/);
    assert.match(schema, /RAISE EXCEPTION/);
  });

  test('rien de ce qui porte l’historique ne se détruit vraiment', () => {
    /*
     * Le contraire d'une restriction : plutôt qu'empêcher la suppression,
     * on la rend réversible. Chacune de ces tables doit donc porter une
     * colonne de corbeille ou d'archivage.
     */
    const schema = fs.readFileSync(new URL('server/db/schema.sql', RACINE), 'utf8');
    const bloc = (table) => {
      const i = schema.indexOf('CREATE TABLE IF NOT EXISTS ' + table + ' (');
      return schema.slice(i, schema.indexOf('\n);', i));
    };
    assert.match(bloc('activites'), /deleted_at\s+TIMESTAMPTZ/, 'activites sans corbeille');
    assert.match(bloc('vehicules'), /archived_at\s+TIMESTAMPTZ/, 'vehicules sans archivage');
    assert.match(bloc('fichiers'), /deleted_at\s+TIMESTAMPTZ/, 'fichiers sans corbeille');
    // Un entretien déjà réalisé se clôt plutôt que de disparaître.
    const statut = bloc('entretiens').split('\n').find((l) => /^\s*statut\s+TEXT/.test(l));
    assert.ok(statut && statut.includes("'CLOS'"),
      'entretiens : pas de statut CLOS — une échéance réalisée disparaîtrait');
  });
});


/* ------------------------------------------------------------------ */

/**
 * Le compose de production.
 *
 * Docker n'est pas disponible sur le poste de developpement : `docker
 * compose config` ne peut pas servir de garde-fou. Ces controles tiennent
 * ce role. Ils ne verifient pas que le deploiement fonctionne — ils
 * verifient qu'il ne redevient pas, par glissement, le montage local.
 *
 * Chacun d'eux correspond a une faute qui ne se voit PAS au deploiement :
 * l'application demarre, l'ecran s'affiche, et le defaut n'apparait qu'au
 * premier incident. Un mot de passe de base en clair dans un fichier
 * versionne, un port de base ouvert sur l'internet, une ancre d'audit
 * posee sur un systeme de fichiers ephemere.
 */
describe('Le compose de production ne redevient pas celui du poste', () => {
  const texte = fs.readFileSync(new URL('docker-compose.coolify.yml', RACINE), 'utf8');
  // Les lignes utiles : ni vides, ni commentaires. Un controle qui se
  // satisferait d'une mention en commentaire ne controlerait rien.
  const utile = texte
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join('\n');

  /** Le reglage `cle: valeur`, guillemets optionnels, ou null s'il est absent. */
  const reglage = (cle) => {
    const m = utile.match(new RegExp('^[ \\t]*' + cle + ':[ \\t]*(.*)$', 'm'));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
  };

  test('il existe, et il est distinct du compose local', () => {
    const local = fs.readFileSync(new URL('docker-compose.yml', RACINE), 'utf8');
    assert.notEqual(texte, local);
    assert.match(
      local, /DEVELOPPEMENT UNIQUEMENT/,
      'le compose local doit se signaler comme tel, sinon quelqu’un le deploiera',
    );
  });

  test('aucun secret n’y est ecrit en dur', () => {
    for (const nom of ['APP_SECRET', 'APP_PASSWORD_PEPPER', 'POSTGRES_PASSWORD']) {
      const v = reglage(nom);
      assert.ok(v !== null, nom + ' est absent du compose de production');
      assert.match(
        v, /^\$\{[A-Z_]+(:[?-][^}]*)?\}$/,
        nom + ' doit venir de l’environnement, pas du fichier — trouve : ' + v,
      );
    }
  });

  test('les variables vitales font echouer le deploiement si elles manquent', () => {
    // `${VAR}` ou `${VAR:-}` demarre sur une chaine vide, en silence.
    // Seul `${VAR:?message}` arrete le deploiement.
    for (const nom of ['APP_SECRET', 'APP_PASSWORD_PEPPER', 'POSTGRES_PASSWORD',
      'POSTGRES_USER', 'POSTGRES_DB', 'ALLOWED_ORIGINS']) {
      const v = reglage(nom);
      assert.ok(v !== null, nom + ' est absent du compose de production');
      assert.match(
        v, /^\$\{[A-Z_]+:\?[^}]+\}$/,
        nom + ' doit s’ecrire ${…:?message} : sans cela, une variable oubliee ' +
        'laisse l’application demarrer sur une valeur vide — trouve : ' + v,
      );
    }
  });

  test('aucun port n’est publie sur la machine', () => {
    assert.ok(
      !/^[ \t]*ports:/m.test(utile),
      'un `ports:` publie le service sur l’hote — derriere le proxy de Coolify rien ' +
      'ne le justifie, et sur le service `base` cela ouvrirait PostgreSQL a l’exterieur',
    );
  });

  test('la posture de securite est celle de la production', () => {
    const attendus = {
      NODE_ENV: 'production',
      SECURE_COOKIES: 'true',
      ENABLE_HSTS: 'true',
      TRUST_PROXY: 'true',
      TRUST_REAL_IP: 'false',
      TRUST_PROXY_HOPS: '1',
    };
    for (const [cle, attendu] of Object.entries(attendus)) {
      assert.equal(reglage(cle), attendu, cle + ' doit valoir ' + attendu + ' en production');
    }
  });

  test('le dossier de l’ancre d’audit est un volume persistant', () => {
    assert.match(
      utile, /-[ \t]*donnees-app:\/app\/data/,
      'sans ce volume, l’ancre externe du journal disparait a chaque redeploiement ' +
      'et ne prouve plus rien',
    );
    assert.equal(reglage('AUDIT_ANCRE_EXTERNE'), 'true', 'l’ancre doit etre active');
    for (const volume of ['donnees-base', 'donnees-app']) {
      assert.match(
        utile, new RegExp('^  ' + volume + ':[ \\t]*$', 'm'),
        'le volume ' + volume + ' doit etre declare, sinon il n’est pas persistant',
      );
    }
  });

  test('le fuseau horaire est pose sur les deux services', () => {
    // Un par service. Sans TZ, le conteneur tourne en UTC et, au Maroc,
    // l’activite saisie apres minuit est refusee comme etant dans le futur.
    const n = (utile.match(/^[ \t]*TZ:[ \t]*\$\{TZ:-Africa\/Casablanca\}[ \t]*$/gm) || []).length;
    assert.equal(n, 2, 'TZ doit etre pose sur `base` ET sur `application`, pas sur l’un des deux');
  });

  test('la base est prete avant que l’application parte', () => {
    assert.match(utile, /condition:[ \t]*service_healthy/);
    assert.match(utile, /pg_isready/);
  });

  test('la sonde de l’application interroge /healthz', () => {
    assert.match(utile, /\/healthz/);
  });

  test('la procedure de deploiement existe et dit l’essentiel', () => {
    const doc = fs.readFileSync(new URL('docs/DEPLOIEMENT-COOLIFY.md', RACINE), 'utf8');
    assert.match(doc, /docker-compose\.coolify\.yml/,
      'la procedure doit nommer le fichier a deployer');
    assert.match(doc, /superadmin/,
      'la creation du super-administrateur doit y figurer : sans elle, l’installation ' +
      'est dans une impasse, l’administrateur ne pouvant pas creer de compte');
    assert.match(doc, /BOOTSTRAP_ADMIN_PASSWORD/,
      'le retrait du mot de passe d’installation doit y figurer');
    // Toute variable exigee par le compose doit etre expliquee quelque part
    // dans la procedure : une variable obligatoire absente de la doc est un
    // deploiement qui echoue, la nuit, sans que personne sache pourquoi.
    for (const m of utile.matchAll(/\$\{([A-Z_]+):\?/g)) {
      assert.ok(doc.includes(m[1]), m[1] + ' est obligatoire mais absent de la procedure');
    }
  });
});
