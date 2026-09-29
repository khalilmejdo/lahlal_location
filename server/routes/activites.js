/**
 * Les activites : le geste central de l'application.
 *
 * « Je selectionne une voiture, j'enregistre ce que j'ai fait, j'indique le
 * kilometrage, ce que j'ai depense et ce que j'ai gagne. » Tout le reste —
 * l'historique, les statistiques, le compteur du vehicule — en decoule.
 *
 * TROIS POINTS DE CONCEPTION
 *
 * 1. LE RESULTAT N'EST JAMAIS CALCULE ICI. La colonne `resultat_cents` est
 *    generee par PostgreSQL (recette - depense). Ni cette route, ni l'ecran,
 *    ni l'export ne refont la soustraction : il n'y a qu'une definition, et
 *    elle ne peut pas diverger.
 *
 * 2. LE COMPTEUR DU VEHICULE EST DEDUIT, PAS ECRIT. Modifier une activite ou
 *    la mettre a la corbeille change mecaniquement le kilometrage du
 *    vehicule, parce que la vue v_vehicules le relit. Le §28 demande de
 *    « recalculer le kilometrage actuel » : il n'y a rien a recalculer.
 *
 * 3. LA COHERENCE DU KILOMETRAGE TIENT COMPTE DE LA DATE. Saisir 149 000 km
 *    aujourd'hui alors que le compteur affiche 152 300 est suspect ; saisir
 *    149 000 km pour une intervention du mois dernier ne l'est pas. Comparer
 *    au seul dernier releve aurait fait crier l'application a chaque saisie
 *    retroactive — et un avertissement qui se declenche toujours est un
 *    avertissement qu'on finit par confirmer sans le lire.
 */
import { Router } from '../http/router.js';
import { validate, validatePartial, rules } from '../core/validate.js';
import { newId } from '../core/crypto.js';
import { notFound, conflict, badRequest, forbidden, AppError } from '../core/errors.js';
import { record, diff } from '../core/audit.js';
import { all, one, transaction, Where, orderBy } from '../db/index.js';
import { likeContains, today } from '../core/text.js';
import { can } from '../core/rbac.js';
import { presenterActivite } from '../domain/flotte.js';
import { reculKilometrage, sautKilometrage } from '../domain/echeances.js';
import { seuils } from '../domain/seuils.js';

export const activiteRoutes = new Router();

/* ------------------------------------------------------------------ */
/*  Coherence du kilometrage (§4, §27)                                 */
/* ------------------------------------------------------------------ */

/**
 * Ce que l'on sait du compteur AUTOUR de la date d'une activite.
 *
 * `avant` : le plus haut releve a cette date OU AVANT. Le compteur ne
 *           revient pas en arriere : la saisie ne peut pas lui etre
 *           inferieure sans explication.
 * `apres` : le plus bas releve d'un jour STRICTEMENT POSTERIEUR. La saisie
 *           ne peut pas depasser un releve deja enregistre plus tard.
 *
 * LES DEUX BORNES NE TRAITENT PAS LE MEME JOUR DE LA MEME FACON, ET C'EST
 * VOLONTAIRE.
 *
 * Plusieurs activites dans une meme journee sont le cas NORMAL : un
 * remorquage le matin, un plein a midi, une location l'apres-midi. Elles
 * n'ont pas d'ordre entre elles — seule la date est enregistree, pas
 * l'heure. Si le jour meme comptait aussi pour la borne haute, la deuxieme
 * activite de la journee declencherait un avertissement des qu'elle porte
 * un kilometrage superieur a la premiere, c'est-a-dire toujours. Un
 * avertissement qui se declenche toujours est un avertissement qu'on
 * confirme sans le lire, et il ne protege plus de rien.
 *
 * La borne basse, elle, garde le jour meme : c'est exactement le cas du §4
 * — « le dernier kilometrage enregistre est 152 300 et l'utilisateur saisit
 * 149 000 » — et dans une journee le compteur ne descend pas.
 *
 * L'activite en cours de modification est exclue de sa propre comparaison :
 * sans quoi corriger « 152 300 » en « 152 350 » se heurterait a 152 300.
 */
async function bornesKilometrage(lecteur, vehiculeId, date, exclureId = null) {
  const ligne = await lecteur.one(
    `SELECT MAX(kilometrage) FILTER (WHERE date_activite <= $2) AS avant,
            MIN(kilometrage) FILTER (WHERE date_activite >  $2) AS apres
       FROM activites
      WHERE vehicule_id = $1
        AND deleted_at IS NULL
        AND kilometrage IS NOT NULL
        AND ($3::uuid IS NULL OR id <> $3)`,
    [vehiculeId, date, exclureId],
  );
  return { avant: ligne?.avant ?? null, apres: ligne?.apres ?? null };
}

/**
 * Le kilometrage saisi demande-t-il confirmation ?
 *
 * Rend null si tout va bien, sinon l'avertissement a montrer. Ne refuse
 * jamais de lui-meme : c'est l'appelant qui exige la confirmation.
 */
function controlerKilometrage(km, bornes, reglages) {
  if (km === null || km === undefined) return null;

  const recul = reculKilometrage(km, bornes.avant, reglages.reculToleKm);
  if (recul) return { code: 'RECUL', ...recul };

  if (bornes.apres !== null && km > bornes.apres) {
    return {
      code: 'DEPASSE_SUIVANT',
      ecart: km - bornes.apres,
      message:
        'Un relevé postérieur indique ' + bornes.apres + ' km, soit moins que les ' +
        km + ' km saisis ici. L’un des deux est erroné.',
    };
  }

  const saut = sautKilometrage(km, bornes.avant);
  if (saut) return { code: 'SAUT', ...saut };

  return null;
}

/* ------------------------------------------------------------------ */
/*  Liste, filtres et recherche (§18, §19, §21, §39)                   */
/* ------------------------------------------------------------------ */

const TRIS = {
  date: 'a.date_activite DESC, a.created_at DESC',
  date_asc: 'a.date_activite ASC, a.created_at ASC',
  resultat: 'a.resultat_cents DESC',
  resultat_asc: 'a.resultat_cents ASC',
  depense: 'a.depense_cents DESC',
  recette: 'a.recette_cents DESC',
  kilometrage: 'a.kilometrage DESC NULLS LAST',
};

activiteRoutes.get(
  '/',
  async (ctx) => {
    const w = construireFiltres(ctx);
    const { limit, offset } = ctx.pagination({ defaultLimit: 50, maxLimit: 200 });
    const tri = orderBy(ctx.query('tri'), Object.keys(TRIS), 'date');

    const lignes = await all(
      `SELECT a.*, t.libelle AS type_libelle,
              v.immatriculation AS vehicule_immatriculation,
              COALESCE(v.libelle, v.immatriculation) AS vehicule_nom,
              (SELECT COUNT(*) FROM fichiers f
                WHERE f.entity = 'activite' AND f.entity_id = a.id) AS nb_pieces
         FROM activites a
         JOIN vehicules v ON v.id = a.vehicule_id
         LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
         ${w.sql()}
        ORDER BY ${TRIS[tri]}
        LIMIT ${w.next(limit)} OFFSET ${w.next(offset)}`,
      w.params,
    );

    // Les totaux portent sur TOUT le filtre, pas sur la page affichee : c'est
    // ce que demande le §19 — « afficher toutes les depenses du Renault
    // Master en septembre » veut dire leur somme, pas celle des cinquante
    // premieres.
    const f = construireFiltres(ctx);
    const totaux = await one(
      `SELECT COUNT(*)::int                              AS nb,
              COALESCE(SUM(a.depense_cents), 0)::bigint  AS depenses_cents,
              COALESCE(SUM(a.recette_cents), 0)::bigint  AS recettes_cents,
              COALESCE(SUM(a.resultat_cents), 0)::bigint AS resultat_cents
         FROM activites a
         JOIN vehicules v ON v.id = a.vehicule_id
         ${f.sql()}`,
      f.params,
    );

    ctx.ok({
      activites: lignes.map(presenterActivite),
      totaux: {
        nb: Number(totaux.nb),
        depensesCents: Number(totaux.depenses_cents),
        recettesCents: Number(totaux.recettes_cents),
        resultatCents: Number(totaux.resultat_cents),
      },
      pagination: { limit, offset, total: Number(totaux.nb) },
    });
  },
  { permission: 'activity.view' },
);

/**
 * Les filtres du §19, assembles une fois pour la liste comme pour les
 * totaux et pour l'export : trois endroits qui doivent voir exactement le
 * meme sous-ensemble, sinon le total affiche ne correspond pas aux lignes.
 *
 * Exportee pour que l'export (routes/exports.js) parte des memes criteres.
 */
export function construireFiltres(ctx) {
  const w = new Where();

  // La corbeille ne se melange pas a l'historique : il faut la demander.
  w.add(ctx.queryBool('corbeille', false) ? 'a.deleted_at IS NOT NULL' : 'a.deleted_at IS NULL');

  const vehiculeId = ctx.queryUuid('vehicule');
  w.addIf(vehiculeId, 'a.vehicule_id = ?', vehiculeId);

  const du = ctx.queryDate('du');
  const au = ctx.queryDate('au');
  w.addIf(du, 'a.date_activite >= ?', du);
  w.addIf(au, 'a.date_activite <= ?', au);

  // Plusieurs types a la fois : « toutes les activites de remorquage ET de
  // depannage » est une question courante.
  const types = (ctx.query('type') ?? '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z][A-Z0-9_]{1,39}$/.test(t));
  if (types.length) w.add('a.type_code = ANY(?::text[])', types);

  // Le sens : ce qui a coute, ce qui a rapporte.
  const sens = String(ctx.query('sens') ?? '').toUpperCase();
  if (sens === 'DEPENSE') w.add('a.depense_cents > 0');
  if (sens === 'RECETTE') w.add('a.recette_cents > 0');
  if (sens === 'PERTE') w.add('a.resultat_cents < 0');
  if (sens === 'GAIN') w.add('a.resultat_cents > 0');

  const recherche = ctx.query('q');
  if (recherche && recherche.trim()) {
    const motif = likeContains(recherche);
    w.add(
      '(a.prestation ILIKE ? OR a.notes ILIKE ? OR v.immatriculation ILIKE ? OR v.libelle ILIKE ?)',
      motif, motif, motif, motif,
    );
  }

  return w;
}

/* ------------------------------------------------------------------ */
/*  Detail                                                             */
/* ------------------------------------------------------------------ */

activiteRoutes.get(
  '/:id',
  async (ctx) => {
    const a = await one(
      `SELECT a.*, t.libelle AS type_libelle,
              v.immatriculation AS vehicule_immatriculation,
              COALESCE(v.libelle, v.immatriculation) AS vehicule_nom
         FROM activites a
         JOIN vehicules v ON v.id = a.vehicule_id
         LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
        WHERE a.id = $1`,
      [ctx.params.id],
    );
    if (!a) throw notFound('Cette activité n’existe pas.');

    const pieces = await all(
      `SELECT id, nom_origine, mime, taille, ordre, created_at
         FROM fichiers WHERE entity = 'activite' AND entity_id = $1
        ORDER BY ordre, created_at`,
      [a.id],
    );

    ctx.ok({
      activite: presenterActivite(a),
      pieces: pieces.map(presenterPiece),
    });
  },
  { permission: 'activity.view' },
);

const presenterPiece = (f) => ({
  id: f.id,
  nom: f.nom_origine,
  mime: f.mime,
  taille: f.taille,
  ordre: f.ordre,
  ajouteLe: f.created_at,
});

/* ------------------------------------------------------------------ */
/*  Creation                                                           */
/* ------------------------------------------------------------------ */

const schemaActivite = {
  vehiculeId: { type: 'uuid', required: true },
  date: { type: 'date', required: true },
  typeCode: rules.codeType,
  prestation: rules.requiredText(200),
  kilometrage: rules.kilometrage,
  depenseCents: rules.montant,
  recetteCents: rules.montant,
  notes: rules.notes,
};

activiteRoutes.post(
  '/',
  async (ctx) => {
    const data = validate(ctx.body, {
      ...schemaActivite,
      // Le geste a-t-il ete confirme apres un avertissement de kilometrage ?
      confirmerKilometrage: { type: 'bool', default: false },
      // Contre le double envoi depuis un telephone en zone mal couverte.
      idempotencyKey: { type: 'string', max: 80 },
    });

    // Une date dans le futur n'est pas une activite : c'est une faute de
    // frappe sur l'annee, et elle fausserait « ce mois-ci » pour longtemps.
    if (data.date > today()) {
      throw badRequest('La date de l’activité est dans le futur (' + data.date + ').');
    }

    if (data.idempotencyKey) {
      const deja = await one(
        `SELECT a.*, t.libelle AS type_libelle FROM activites a
           LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
          WHERE a.idempotency_key = $1`,
        [data.idempotencyKey],
      );
      // Le meme envoi rejoue rend le meme resultat, sans rien creer.
      if (deja) { ctx.ok({ activite: presenterActivite(deja), rejeu: true }); return; }
    }

    const vehicule = await one(
      'SELECT id, libelle, immatriculation, archived_at FROM vehicules WHERE id = $1',
      [data.vehiculeId],
    );
    if (!vehicule) throw notFound('Ce véhicule n’existe pas.');
    if (vehicule.archived_at) {
      throw conflict(
        'Le véhicule ' + (vehicule.libelle || vehicule.immatriculation) + ' est archivé : ' +
        'réactivez-le pour lui rattacher une activité.',
      );
    }

    await verifierType(data.typeCode);

    const resultat = await transaction(async (tx) => {
      const bornes = await bornesKilometrage(tx, data.vehiculeId, data.date);
      const alerte = controlerKilometrage(data.kilometrage, bornes, seuils());

      if (alerte && !data.confirmerKilometrage) {
        // 409 et non 400 : la saisie n'est pas invalide, elle est en conflit
        // avec ce que l'on sait deja. L'ecran affiche le message et propose
        // de confirmer.
        throw new AppError(409, alerte.message, { code: 'KILOMETRAGE_' + alerte.code, details: alerte });
      }
      if (alerte && !can(ctx.user, 'activity.force_mileage')) {
        throw forbidden(
          'Ce kilométrage est incohérent avec les relevés existants, et vous n’avez pas le ' +
          'droit de passer outre. Demandez à un gestionnaire de flotte.',
        );
      }

      const id = newId();
      await tx.query(
        `INSERT INTO activites
           (id, vehicule_id, date_activite, type_code, prestation, kilometrage,
            kilometrage_force, depense_cents, recette_cents, notes,
            idempotency_key, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [id, data.vehiculeId, data.date, data.typeCode, data.prestation,
         data.kilometrage ?? null, Boolean(alerte), data.depenseCents, data.recetteCents,
         data.notes ?? null, data.idempotencyKey ?? null, ctx.user.id],
      );

      await record({
        tx,
        actor: ctx.user,
        action: 'activite.create',
        entity: 'activite',
        entityId: id,
        entityLabel: data.prestation,
        summary:
          'Activité « ' + data.prestation + ' » du ' + data.date + ' sur ' +
          (vehicule.libelle || vehicule.immatriculation) + '.' +
          (alerte ? ' Kilométrage confirmé malgré un avertissement : ' + alerte.message : ''),
        severity: alerte ? 'warning' : 'info',
        ip: ctx.ip,
      });

      return id;
    });

    ctx.created({ activite: await lireActivite(resultat), avertissement: null });
  },
  { permission: 'activity.create' },
);

async function verifierType(code) {
  const t = await one(
    "SELECT code, actif FROM types WHERE domaine = 'ACTIVITE' AND code = $1", [code],
  );
  if (!t) throw badRequest('Le type d’activité « ' + code + ' » n’existe pas.');
  if (!t.actif) throw badRequest('Le type d’activité « ' + code + ' » est désactivé.');
}

async function lireActivite(id) {
  const a = await one(
    `SELECT a.*, t.libelle AS type_libelle,
            v.immatriculation AS vehicule_immatriculation,
            COALESCE(v.libelle, v.immatriculation) AS vehicule_nom
       FROM activites a
       JOIN vehicules v ON v.id = a.vehicule_id
       LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
      WHERE a.id = $1`,
    [id],
  );
  return a ? presenterActivite(a) : null;
}

/* ------------------------------------------------------------------ */
/*  Modification (§28)                                                 */
/* ------------------------------------------------------------------ */

activiteRoutes.patch(
  '/:id',
  async (ctx) => {
    const avant = await one('SELECT * FROM activites WHERE id = $1', [ctx.params.id]);
    if (!avant) throw notFound('Cette activité n’existe pas.');
    if (avant.deleted_at) {
      throw conflict('Cette activité est à la corbeille : restaurez-la avant de la modifier.');
    }

    const data = validatePartial(ctx.body, {
      ...schemaActivite,
      vehiculeId: { type: 'uuid' },
      date: { type: 'date' },
      typeCode: { type: 'string', max: 40, min: 2 },
      prestation: rules.shortText(200),
      confirmerKilometrage: { type: 'bool' },
    });
    delete data.confirmerKilometrage;
    if (!Object.keys(data).length) throw badRequest('Aucune modification demandée.');

    if (data.date && data.date > today()) {
      throw badRequest('La date de l’activité est dans le futur (' + data.date + ').');
    }
    if (data.typeCode) await verifierType(data.typeCode);
    if (data.vehiculeId) {
      const v = await one('SELECT id, archived_at FROM vehicules WHERE id = $1', [data.vehiculeId]);
      if (!v) throw notFound('Ce véhicule n’existe pas.');
      if (v.archived_at) throw conflict('Ce véhicule est archivé.');
    }

    const confirme = ctx.body?.confirmerKilometrage === true;

    await transaction(async (tx) => {
      const vehiculeId = data.vehiculeId ?? avant.vehicule_id;
      const date = data.date ?? String(avant.date_activite).slice(0, 10);
      const km = 'kilometrage' in data ? data.kilometrage : avant.kilometrage;

      let force = avant.kilometrage_force;
      const changeLeKm = 'kilometrage' in data || data.date || data.vehiculeId;
      if (changeLeKm) {
        const bornes = await bornesKilometrage(tx, vehiculeId, date, avant.id);
        const alerte = controlerKilometrage(km, bornes, seuils());
        if (alerte && !confirme) {
          throw new AppError(409, alerte.message, { code: 'KILOMETRAGE_' + alerte.code, details: alerte });
        }
        if (alerte && !can(ctx.user, 'activity.force_mileage')) {
          throw forbidden(
            'Ce kilométrage est incohérent avec les relevés existants, et vous n’avez pas le ' +
            'droit de passer outre.',
          );
        }
        force = Boolean(alerte);
      }

      await tx.query(
        `UPDATE activites SET
           vehicule_id       = COALESCE($2, vehicule_id),
           date_activite     = COALESCE($3, date_activite),
           type_code         = COALESCE($4, type_code),
           prestation        = COALESCE($5, prestation),
           kilometrage       = CASE WHEN $6::bool THEN $7 ELSE kilometrage END,
           kilometrage_force = $8,
           depense_cents     = COALESCE($9, depense_cents),
           recette_cents     = COALESCE($10, recette_cents),
           notes             = CASE WHEN $11::bool THEN $12 ELSE notes END,
           updated_at = now(), updated_by = $13
         WHERE id = $1`,
        [avant.id, data.vehiculeId ?? null, data.date ?? null, data.typeCode ?? null,
         data.prestation ?? null,
         'kilometrage' in data, data.kilometrage ?? null,
         force,
         data.depenseCents ?? null, data.recetteCents ?? null,
         'notes' in data, data.notes ?? null,
         ctx.user.id],
      );

      const apres = await tx.one('SELECT * FROM activites WHERE id = $1', [avant.id]);
      await record({
        tx,
        actor: ctx.user,
        action: 'activite.update',
        entity: 'activite',
        entityId: avant.id,
        entityLabel: apres.prestation,
        summary: 'Modification de l’activité « ' + apres.prestation + ' ».',
        changes: diff(avant, apres, {
          fields: ['vehicule_id', 'date_activite', 'type_code', 'prestation',
                   'kilometrage', 'depense_cents', 'recette_cents', 'notes'],
        }),
        ip: ctx.ip,
      });
    });

    ctx.ok({ activite: await lireActivite(avant.id) });
  },
  { permission: 'activity.edit' },
);

/* ------------------------------------------------------------------ */
/*  Corbeille (§29)                                                    */
/* ------------------------------------------------------------------ */

activiteRoutes.delete(
  '/:id',
  async (ctx) => {
    const a = await one('SELECT * FROM activites WHERE id = $1', [ctx.params.id]);
    if (!a) throw notFound('Cette activité n’existe pas.');
    if (a.deleted_at) throw conflict('Cette activité est déjà à la corbeille.');

    const { motif } = validate(ctx.body, { motif: rules.requiredReason });

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE activites SET deleted_at = now(), deleted_by = $2, delete_reason = $3
          WHERE id = $1`,
        [a.id, ctx.user.id, motif],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'activite.delete',
        entity: 'activite',
        entityId: a.id,
        entityLabel: a.prestation,
        summary: 'Mise à la corbeille de l’activité « ' + a.prestation + ' ». Motif : ' + motif,
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    // Le kilometrage du vehicule a pu reculer : la vue le relit, rien a faire.
    ctx.ok({ supprime: true });
  },
  { permission: 'activity.delete' },
);

activiteRoutes.post(
  '/:id/restaurer',
  async (ctx) => {
    const a = await one('SELECT * FROM activites WHERE id = $1', [ctx.params.id]);
    if (!a) throw notFound('Cette activité n’existe pas.');
    if (!a.deleted_at) throw conflict('Cette activité n’est pas à la corbeille.');

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE activites SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
          WHERE id = $1`,
        [a.id],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'activite.restore',
        entity: 'activite',
        entityId: a.id,
        entityLabel: a.prestation,
        summary: 'Restauration de l’activité « ' + a.prestation + ' ».',
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    ctx.ok({ activite: await lireActivite(a.id) });
  },
  { permission: 'activity.delete' },
);

