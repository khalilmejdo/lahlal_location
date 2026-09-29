/**
 * Les vehicules.
 *
 * Une fiche par vehicule (§4), son etat en un coup d'oeil (§37), et sa page
 * dediee avec son historique (§17).
 *
 * LE KILOMETRAGE NE SE SAISIT PAS ICI, sauf une fois.
 *
 * A la creation, on releve le compteur : c'est le point de depart. Ensuite,
 * le kilometrage du vehicule est deduit de ses activites (vue v_vehicules),
 * et la seule facon de le faire avancer est d'enregistrer une activite. Un
 * champ « kilometrage actuel » modifiable a la main aurait ouvert deux
 * sources de verite pour la meme grandeur — et c'est celle que les alertes
 * comparent aux echeances.
 */
import { Router } from '../http/router.js';
import { validate, validatePartial, rules } from '../core/validate.js';
import { newId } from '../core/crypto.js';
import { notFound, conflict, badRequest } from '../core/errors.js';
import { record, diff } from '../core/audit.js';
import { all, one, value, transaction, Where } from '../db/index.js';
import { today } from '../core/text.js';
import { vehiculesAvecEtat, vehiculeAvecEtat, presenterActivite } from '../domain/flotte.js';

export const vehiculeRoutes = new Router();

/* ------------------------------------------------------------------ */
/*  Normalisation de l'immatriculation                                 */
/* ------------------------------------------------------------------ */

/**
 * « 1234-A-56 », « 1234 A 56 » et « 1234a56 » sont le meme vehicule.
 *
 * Reprise de lahlal_samuplus : c'est la forme normalisee qui porte
 * l'unicite, jamais la forme saisie — sinon le meme camion entre deux fois
 * et son historique se coupe en deux.
 */
export const normaliserImmatriculation = (plaque) =>
  String(plaque ?? '').toUpperCase().replace(/[^A-Z0-9؀-ۿ]/g, '');

const STATUTS = ['DISPONIBLE', 'EN_SERVICE', 'MAINTENANCE', 'IMMOBILISE', 'VENDU'];

const schemaVehicule = {
  immatriculation: { type: 'string', required: true, min: 2, max: 20 },
  libelle: rules.shortText(60),
  marque: rules.shortText(60),
  modele: rules.shortText(60),
  annee: { type: 'int', min: 1950, max: 2100 },
  statut: { type: 'enum', values: STATUTS, default: 'DISPONIBLE' },
  notes: rules.notes,
};

/* ------------------------------------------------------------------ */
/*  Liste                                                              */
/* ------------------------------------------------------------------ */

vehiculeRoutes.get(
  '/',
  async (ctx) => {
    const avecArchives = ctx.queryBool('archives', false);
    const recherche = ctx.query('q');

    let flotte = await vehiculesAvecEtat({ inclureArchives: avecArchives });

    // La recherche se fait en memoire : la flotte tient sur un ecran, et une
    // requete SQL de plus pour filtrer vingt lignes deja chargees couterait
    // plus qu'elle ne rapporte.
    if (recherche) {
      const terme = recherche.trim().toLowerCase();
      const normalisee = normaliserImmatriculation(recherche);
      flotte = flotte.filter((v) =>
        normaliserImmatriculation(v.immatriculation).includes(normalisee) ||
        String(v.nom).toLowerCase().includes(terme) ||
        String(v.marque ?? '').toLowerCase().includes(terme) ||
        String(v.modele ?? '').toLowerCase().includes(terme));
    }

    ctx.ok({ vehicules: flotte });
  },
  { permission: 'vehicle.view' },
);

/* ------------------------------------------------------------------ */
/*  Fiche d'un vehicule (§17)                                          */
/* ------------------------------------------------------------------ */

vehiculeRoutes.get(
  '/:id',
  async (ctx) => {
    const vehicule = await vehiculeAvecEtat(ctx.params.id);
    if (!vehicule) throw notFound('Ce véhicule n’existe pas.');

    const { limit, offset } = ctx.pagination({ defaultLimit: 25, maxLimit: 200 });

    // La timeline recente, et les chiffres du vehicule. Deux requetes, pas
    // une par ligne : le nombre de pieces jointes vient d'un agregat joint,
    // pas d'un appel par activite.
    const activites = await all(
      `SELECT a.*, t.libelle AS type_libelle,
              (SELECT COUNT(*) FROM fichiers f
                WHERE f.entity = 'activite' AND f.entity_id = a.id) AS nb_pieces
         FROM activites a
         LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
        WHERE a.vehicule_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.date_activite DESC, a.created_at DESC
        LIMIT $2 OFFSET $3`,
      [vehicule.id, limit, offset],
    );

    const total = await value(
      'SELECT COUNT(*)::int FROM activites WHERE vehicule_id = $1 AND deleted_at IS NULL',
      [vehicule.id],
    );

    ctx.ok({
      vehicule,
      activites: activites.map(presenterActivite),
      pagination: { limit, offset, total: Number(total) },
      statistiques: await statistiquesVehicule(vehicule.id),
    });
  },
  { permission: 'vehicle.view' },
);

/**
 * Les chiffres d'un vehicule (§17) : ce qu'il a coute, ce qu'il a rapporte,
 * et ce qu'il a parcouru.
 *
 * Le kilometrage parcouru est l'ecart entre le plus petit et le plus grand
 * releve, et non la somme des releves : additionner des compteurs n'aurait
 * aucun sens.
 */
async function statistiquesVehicule(vehiculeId, { du = null, au = null } = {}) {
  const w = new Where();
  w.add('a.vehicule_id = ?', vehiculeId);
  w.add('a.deleted_at IS NULL');
  if (du) w.add('a.date_activite >= ?', du);
  if (au) w.add('a.date_activite <= ?', au);

  const ligne = await one(
    `SELECT COUNT(*)::int                                  AS nb_activites,
            COALESCE(SUM(a.depense_cents), 0)::bigint      AS depenses_cents,
            COALESCE(SUM(a.recette_cents), 0)::bigint      AS recettes_cents,
            COALESCE(SUM(a.resultat_cents), 0)::bigint     AS resultat_cents,
            MIN(a.kilometrage)                             AS km_min,
            MAX(a.kilometrage)                             AS km_max
       FROM activites a ${w.sql()}`,
    w.params,
  );

  const kmMin = ligne?.km_min ?? null;
  const kmMax = ligne?.km_max ?? null;

  return {
    nbActivites: Number(ligne?.nb_activites ?? 0),
    depensesCents: Number(ligne?.depenses_cents ?? 0),
    recettesCents: Number(ligne?.recettes_cents ?? 0),
    resultatCents: Number(ligne?.resultat_cents ?? 0),
    kilometresParcourus: kmMin !== null && kmMax !== null ? kmMax - kmMin : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Creation                                                           */
/* ------------------------------------------------------------------ */

vehiculeRoutes.post(
  '/',
  async (ctx) => {
    const data = validate(ctx.body, {
      ...schemaVehicule,
      // Le releve du compteur au moment ou le vehicule entre dans le parc.
      // Il ne se remodifiera plus qu'exceptionnellement : ensuite, ce sont
      // les activites qui font avancer le compteur.
      kilometrageInitial: { type: 'int', min: 0, max: 3000000, default: 0 },
    });

    const normalisee = normaliserImmatriculation(data.immatriculation);
    if (normalisee.length < 2) {
      throw badRequest('L’immatriculation doit comporter au moins deux caractères utiles.');
    }

    const clash = await one(
      'SELECT id, immatriculation, archived_at FROM vehicules WHERE immatriculation_norm = $1',
      [normalisee],
    );
    if (clash) {
      throw conflict(
        clash.archived_at
          ? 'Le véhicule ' + clash.immatriculation + ' existe déjà, mais il est archivé. ' +
            'Réactivez-le plutôt que d’en créer un second : son historique lui est attaché.'
          : 'Un véhicule porte déjà l’immatriculation ' + clash.immatriculation + '.',
      );
    }

    const id = newId();
    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO vehicules
           (id, immatriculation, immatriculation_norm, libelle, marque, modele,
            annee, kilometrage_initial, statut, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [id, data.immatriculation.trim(), normalisee, data.libelle ?? null,
         data.marque ?? null, data.modele ?? null, data.annee ?? null,
         data.kilometrageInitial, data.statut, data.notes ?? null, ctx.user.id],
      );

      await record({
        tx,
        actor: ctx.user,
        action: 'vehicule.create',
        entity: 'vehicule',
        entityId: id,
        entityLabel: data.libelle || data.immatriculation,
        summary: 'Création du véhicule ' + (data.libelle || data.immatriculation) +
          ' (' + data.immatriculation + '), compteur à ' + data.kilometrageInitial + ' km.',
        ip: ctx.ip,
      });
    });

    ctx.created({ vehicule: await vehiculeAvecEtat(id) });
  },
  { permission: 'vehicle.create' },
);

/* ------------------------------------------------------------------ */
/*  Modification                                                       */
/* ------------------------------------------------------------------ */

vehiculeRoutes.patch(
  '/:id',
  async (ctx) => {
    const avant = await one('SELECT * FROM vehicules WHERE id = $1', [ctx.params.id]);
    if (!avant) throw notFound('Ce véhicule n’existe pas.');

    const data = validatePartial(ctx.body, {
      ...schemaVehicule,
      immatriculation: { type: 'string', min: 2, max: 20 },
      // Corriger le releve de depart reste possible : c'est une saisie comme
      // une autre, et elle peut avoir ete fausse. Elle est tracee.
      kilometrageInitial: { type: 'int', min: 0, max: 3000000 },
    });
    if (!Object.keys(data).length) throw badRequest('Aucune modification demandée.');

    let normalisee = avant.immatriculation_norm;
    if (data.immatriculation !== undefined) {
      normalisee = normaliserImmatriculation(data.immatriculation);
      if (normalisee.length < 2) {
        throw badRequest('L’immatriculation doit comporter au moins deux caractères utiles.');
      }
      const clash = await one(
        'SELECT id, immatriculation FROM vehicules WHERE immatriculation_norm = $1 AND id <> $2',
        [normalisee, avant.id],
      );
      if (clash) throw conflict('Un véhicule porte déjà l’immatriculation ' + clash.immatriculation + '.');
    }

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE vehicules SET
           immatriculation      = COALESCE($2, immatriculation),
           immatriculation_norm = $3,
           libelle              = CASE WHEN $4::bool THEN $5 ELSE libelle END,
           marque               = CASE WHEN $6::bool THEN $7 ELSE marque END,
           modele               = CASE WHEN $8::bool THEN $9 ELSE modele END,
           annee                = CASE WHEN $10::bool THEN $11 ELSE annee END,
           statut               = COALESCE($12, statut),
           notes                = CASE WHEN $13::bool THEN $14 ELSE notes END,
           kilometrage_initial  = COALESCE($15, kilometrage_initial),
           updated_at = now(), updated_by = $16
         WHERE id = $1`,
        [
          avant.id,
          data.immatriculation !== undefined ? data.immatriculation.trim() : null,
          normalisee,
          'libelle' in data, data.libelle ?? null,
          'marque' in data, data.marque ?? null,
          'modele' in data, data.modele ?? null,
          'annee' in data, data.annee ?? null,
          data.statut ?? null,
          'notes' in data, data.notes ?? null,
          data.kilometrageInitial ?? null,
          ctx.user.id,
        ],
      );

      const apres = await tx.one('SELECT * FROM vehicules WHERE id = $1', [avant.id]);
      const changements = diff(avant, apres, {
        fields: ['immatriculation', 'libelle', 'marque', 'modele', 'annee',
                 'statut', 'kilometrage_initial', 'notes'],
      });

      await record({
        tx,
        actor: ctx.user,
        action: 'vehicule.update',
        entity: 'vehicule',
        entityId: avant.id,
        entityLabel: apres.libelle || apres.immatriculation,
        summary: 'Modification du véhicule ' + (apres.libelle || apres.immatriculation) + '.',
        changes: changements,
        ip: ctx.ip,
      });
    });

    ctx.ok({ vehicule: await vehiculeAvecEtat(avant.id) });
  },
  { permission: 'vehicle.edit' },
);

/* ------------------------------------------------------------------ */
/*  Archivage et reactivation (§29)                                    */
/* ------------------------------------------------------------------ */

vehiculeRoutes.post(
  '/:id/archiver',
  async (ctx) => {
    const vehicule = await one('SELECT * FROM vehicules WHERE id = $1', [ctx.params.id]);
    if (!vehicule) throw notFound('Ce véhicule n’existe pas.');
    if (vehicule.archived_at) throw conflict('Ce véhicule est déjà archivé.');

    const { motif } = validate(ctx.body, { motif: rules.requiredReason });

    await transaction(async (tx) => {
      await tx.query(
        'UPDATE vehicules SET archived_at = now(), archived_by = $2, updated_at = now() WHERE id = $1',
        [vehicule.id, ctx.user.id],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'vehicule.archive',
        entity: 'vehicule',
        entityId: vehicule.id,
        entityLabel: vehicule.libelle || vehicule.immatriculation,
        summary: 'Archivage du véhicule ' + (vehicule.libelle || vehicule.immatriculation) +
          '. Motif : ' + motif,
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    ctx.ok({ vehicule: await vehiculeAvecEtat(vehicule.id) });
  },
  { permission: 'vehicle.archive' },
);

vehiculeRoutes.post(
  '/:id/reactiver',
  async (ctx) => {
    const vehicule = await one('SELECT * FROM vehicules WHERE id = $1', [ctx.params.id]);
    if (!vehicule) throw notFound('Ce véhicule n’existe pas.');
    if (!vehicule.archived_at) throw conflict('Ce véhicule n’est pas archivé.');

    await transaction(async (tx) => {
      await tx.query(
        'UPDATE vehicules SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = $1',
        [vehicule.id],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'vehicule.reactivate',
        entity: 'vehicule',
        entityId: vehicule.id,
        entityLabel: vehicule.libelle || vehicule.immatriculation,
        summary: 'Réactivation du véhicule ' + (vehicule.libelle || vehicule.immatriculation) + '.',
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    ctx.ok({ vehicule: await vehiculeAvecEtat(vehicule.id) });
  },
  { permission: 'vehicle.archive' },
);

/* ------------------------------------------------------------------ */
/*  Statistiques d'un vehicule sur une periode (§20)                   */
/* ------------------------------------------------------------------ */

vehiculeRoutes.get(
  '/:id/statistiques',
  async (ctx) => {
    const existe = await value('SELECT 1 FROM vehicules WHERE id = $1', [ctx.params.id]);
    if (!existe) throw notFound('Ce véhicule n’existe pas.');

    const du = ctx.queryDate('du');
    const au = ctx.queryDate('au');
    if (du && au && du > au) {
      throw badRequest('La période est inversée : ' + du + ' est postérieur à ' + au + '.');
    }

    ctx.ok({
      periode: { du, au: au ?? today() },
      statistiques: await statistiquesVehicule(ctx.params.id, { du, au }),
    });
  },
  { permission: 'stats.view' },
);

