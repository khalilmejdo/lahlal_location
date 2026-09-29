/**
 * Les entretiens et les echeances.
 *
 * Une seule table pour les deux (voir schema.sql) : du point de vue du
 * calcul, une vidange a 160 000 km et une assurance au 15/09/2027 sont la
 * meme chose — quelque chose a refaire, echu a un kilometrage, a une date,
 * ou aux deux.
 *
 * LA CLOTURE EST LE GESTE IMPORTANT (§34).
 *
 * « Entretien effectué » fait trois choses d'un coup, et dans la meme
 * transaction : il enregistre l'entretien comme realise, il cree l'activite
 * correspondante — avec son cout, donc visible dans les comptes du vehicule
 * et dans son historique —, et il reporte l'echeance suivante. Les trois
 * separement auraient laisse, au premier incident reseau, un entretien
 * declare fait dont la depense n'apparait nulle part.
 */
import { Router } from '../http/router.js';
import { validate, validatePartial, rules } from '../core/validate.js';
import { newId } from '../core/crypto.js';
import { notFound, conflict, badRequest, AppError } from '../core/errors.js';
import { record, diff } from '../core/audit.js';
import { all, one, transaction } from '../db/index.js';
import { today } from '../core/text.js';
import { presenterEntretien } from '../domain/flotte.js';
import { etatEcheance, prochaineEcheanceProposee, libelleAlerte, NIVEAUX } from '../domain/echeances.js';
import { seuils } from '../domain/seuils.js';
import { INTERVALLES_SUGGERES } from '../db/seed-data.js';

export const entretienRoutes = new Router();

/* ------------------------------------------------------------------ */
/*  Lecture                                                            */
/* ------------------------------------------------------------------ */

/**
 * La liste des entretiens, avec leur compte a rebours.
 *
 * Deux requetes au plus, comme partout : les entretiens et le kilometrage
 * des vehicules concernes. Le niveau se calcule ensuite en memoire.
 */
async function lireEntretiens({ vehiculeId = null, statut = 'ACTIF', aujourdHui = today() } = {}) {
  const conditions = ['1=1'];
  const params = [];
  if (vehiculeId) { params.push(vehiculeId); conditions.push('e.vehicule_id = $' + params.length); }
  if (statut) { params.push(statut); conditions.push('e.statut = $' + params.length); }

  const lignes = await all(
    `SELECT e.*, t.libelle AS type_libelle,
            v.kilometrage,
            v.immatriculation AS vehicule_immatriculation,
            COALESCE(v.libelle, v.immatriculation) AS vehicule_nom,
            v.archived_at AS vehicule_archive
       FROM entretiens e
       JOIN v_vehicules v ON v.id = e.vehicule_id
       LEFT JOIN types t ON t.domaine = 'ENTRETIEN' AND t.code = e.type_code
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.prochaine_date NULLS LAST, e.prochain_km NULLS LAST`,
    params,
  );

  const reglages = seuils();
  return lignes.map((e) => {
    const etat = etatEcheance(
      { prochainKm: e.prochain_km, prochaineDate: e.prochaine_date, statut: e.statut },
      e.kilometrage,
      aujourdHui,
      reglages,
    );
    return {
      ...presenterEntretien(e),
      vehiculeNom: e.vehicule_nom,
      vehiculeImmatriculation: e.vehicule_immatriculation,
      vehiculeArchive: Boolean(e.vehicule_archive),
      kilometrageVehicule: e.kilometrage,
      etat,
      alerte: libelleAlerte(e, etat),
    };
  });
}

entretienRoutes.get(
  '/',
  async (ctx) => {
    const statutDemande = String(ctx.query('statut') ?? 'ACTIF').toUpperCase();
    const statut = ['ACTIF', 'CLOS'].includes(statutDemande) ? statutDemande : 'ACTIF';

    let liste = await lireEntretiens({ vehiculeId: ctx.queryUuid('vehicule'), statut });

    // Filtre par etat (§19) : « tous les entretiens à venir », « ce qui est
    // dépassé ».
    const niveau = String(ctx.query('niveau') ?? '').toUpperCase();
    if (NIVEAUX.includes(niveau)) {
      liste = liste.filter((e) => e.etat.surveille && e.etat.niveau === niveau);
    }
    if (ctx.queryBool('alertes', false)) {
      liste = liste.filter((e) => e.etat.surveille && e.etat.niveau !== 'NORMAL');
    }

    ctx.ok({
      entretiens: liste,
      compteurs: liste.reduce((c, e) => {
        if (e.etat.surveille) c[e.etat.niveau] = (c[e.etat.niveau] ?? 0) + 1;
        return c;
      }, { NORMAL: 0, ATTENTION: 0, URGENT: 0, DEPASSE: 0 }),
    });
  },
  { permission: 'maintenance.view' },
);

entretienRoutes.get(
  '/:id',
  async (ctx) => {
    const e = await chargerAvecEtat(ctx.params.id);
    if (!e) throw notFound('Cet entretien n’existe pas.');

    // Son historique : les activites nees de ses clotures successives.
    const historique = await all(
      `SELECT a.id, a.date_activite, a.kilometrage, a.depense_cents, a.prestation, a.notes
         FROM activites a
        WHERE a.entretien_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.date_activite DESC`,
      [e.id],
    );

    const pieces = await all(
      `SELECT id, nom_origine, mime, taille, ordre, created_at
         FROM fichiers WHERE entity = 'entretien' AND entity_id = $1 ORDER BY ordre, created_at`,
      [e.id],
    );

    ctx.ok({
      entretien: e,
      historique: historique.map((h) => ({
        id: h.id,
        date: h.date_activite,
        kilometrage: h.kilometrage,
        coutCents: Number(h.depense_cents),
        prestation: h.prestation,
        notes: h.notes,
      })),
      pieces: pieces.map((f) => ({
        id: f.id, nom: f.nom_origine, mime: f.mime, taille: f.taille, ajouteLe: f.created_at,
      })),
    });
  },
  { permission: 'maintenance.view' },
);

async function chargerAvecEtat(id, aujourdHui = today()) {
  const ligne = await one(
    `SELECT e.*, t.libelle AS type_libelle, v.kilometrage,
            v.immatriculation AS vehicule_immatriculation,
            COALESCE(v.libelle, v.immatriculation) AS vehicule_nom
       FROM entretiens e
       JOIN v_vehicules v ON v.id = e.vehicule_id
       LEFT JOIN types t ON t.domaine = 'ENTRETIEN' AND t.code = e.type_code
      WHERE e.id = $1`,
    [id],
  );
  if (!ligne) return null;
  const etat = etatEcheance(
    { prochainKm: ligne.prochain_km, prochaineDate: ligne.prochaine_date, statut: ligne.statut },
    ligne.kilometrage,
    aujourdHui,
    seuils(),
  );
  return {
    ...presenterEntretien(ligne),
    vehiculeNom: ligne.vehicule_nom,
    vehiculeImmatriculation: ligne.vehicule_immatriculation,
    kilometrageVehicule: ligne.kilometrage,
    etat,
    alerte: libelleAlerte(ligne, etat),
  };
}

/* ------------------------------------------------------------------ */
/*  Les intervalles suggeres (§35)                                     */
/* ------------------------------------------------------------------ */

entretienRoutes.get(
  '/suggestions/intervalles',
  async (ctx) => {
    // Ce ne sont QUE des suggestions d'ecran : un intervalle saisi a la main
    // s'applique tel quel (§11, §12).
    ctx.ok({ intervalles: INTERVALLES_SUGGERES });
  },
  { permission: 'maintenance.view' },
);

/* ------------------------------------------------------------------ */
/*  Creation et modification                                           */
/* ------------------------------------------------------------------ */

const schemaEntretien = {
  vehiculeId: { type: 'uuid', required: true },
  typeCode: rules.codeType,
  libelle: rules.requiredText(120),
  derniereDate: rules.optionalDate,
  dernierKm: rules.kilometrage,
  intervalleKm: { type: 'int', min: 100, max: 500000 },
  intervalleMois: { type: 'int', min: 1, max: 240 },
  prochainKm: rules.kilometrage,
  prochaineDate: rules.optionalDate,
  notes: rules.notes,
};

entretienRoutes.post(
  '/',
  async (ctx) => {
    const data = validate(ctx.body, schemaEntretien);

    const vehicule = await one(
      'SELECT id, libelle, immatriculation, archived_at FROM vehicules WHERE id = $1',
      [data.vehiculeId],
    );
    if (!vehicule) throw notFound('Ce véhicule n’existe pas.');
    if (vehicule.archived_at) throw conflict('Ce véhicule est archivé.');

    await verifierTypeEntretien(data.typeCode);

    // L'echeance : celle qui est saisie, sinon celle que l'intervalle
    // propose. La saisie l'emporte toujours (§11, §12).
    const propose = prochaineEcheanceProposee({
      km: data.dernierKm,
      date: data.derniereDate,
      intervalleKm: data.intervalleKm,
      intervalleMois: data.intervalleMois,
    });
    const prochainKm = data.prochainKm ?? propose.prochainKm;
    const prochaineDate = data.prochaineDate ?? propose.prochaineDate;

    if (prochainKm === null && prochaineDate === null) {
      throw badRequest(
        'Cet entretien ne surveille rien : donnez-lui une prochaine échéance — ' +
        'un kilométrage, une date, ou les deux — ou un intervalle et une dernière réalisation ' +
        'à partir desquels la calculer.',
      );
    }
    verifierCoherence({ ...data, prochainKm, prochaineDate });

    const id = newId();
    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO entretiens
           (id, vehicule_id, type_code, libelle, derniere_date, dernier_km,
            intervalle_km, intervalle_mois, prochain_km, prochaine_date, notes,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [id, data.vehiculeId, data.typeCode, data.libelle,
         data.derniereDate ?? null, data.dernierKm ?? null,
         data.intervalleKm ?? null, data.intervalleMois ?? null,
         prochainKm, prochaineDate, data.notes ?? null, ctx.user.id],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'entretien.create',
        entity: 'entretien',
        entityId: id,
        entityLabel: data.libelle,
        summary:
          'Échéance « ' + data.libelle + ' » créée sur ' +
          (vehicule.libelle || vehicule.immatriculation) + ' : ' +
          decrireEcheance(prochainKm, prochaineDate) + '.',
        ip: ctx.ip,
      });
    });

    ctx.created({ entretien: await chargerAvecEtat(id) });
  },
  { permission: 'maintenance.create' },
);

entretienRoutes.patch(
  '/:id',
  async (ctx) => {
    const avant = await one('SELECT * FROM entretiens WHERE id = $1', [ctx.params.id]);
    if (!avant) throw notFound('Cet entretien n’existe pas.');

    const data = validatePartial(ctx.body, {
      ...schemaEntretien,
      vehiculeId: { type: 'uuid' },
      typeCode: { type: 'string', max: 40, min: 2 },
      libelle: rules.shortText(120),
    });
    if (!Object.keys(data).length) throw badRequest('Aucune modification demandée.');
    if (data.typeCode) await verifierTypeEntretien(data.typeCode);

    const fusion = {
      derniereDate: 'derniereDate' in data ? data.derniereDate : avant.derniere_date,
      dernierKm: 'dernierKm' in data ? data.dernierKm : avant.dernier_km,
      prochainKm: 'prochainKm' in data ? data.prochainKm : avant.prochain_km,
      prochaineDate: 'prochaineDate' in data ? data.prochaineDate : avant.prochaine_date,
    };
    if (avant.statut === 'ACTIF' && fusion.prochainKm === null && fusion.prochaineDate === null) {
      throw badRequest('Un entretien actif doit garder au moins une échéance.');
    }
    verifierCoherence(fusion);

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE entretiens SET
           vehicule_id     = COALESCE($2, vehicule_id),
           type_code       = COALESCE($3, type_code),
           libelle         = COALESCE($4, libelle),
           derniere_date   = CASE WHEN $5::bool  THEN $6  ELSE derniere_date   END,
           dernier_km      = CASE WHEN $7::bool  THEN $8  ELSE dernier_km      END,
           intervalle_km   = CASE WHEN $9::bool  THEN $10 ELSE intervalle_km   END,
           intervalle_mois = CASE WHEN $11::bool THEN $12 ELSE intervalle_mois END,
           prochain_km     = CASE WHEN $13::bool THEN $14 ELSE prochain_km     END,
           prochaine_date  = CASE WHEN $15::bool THEN $16 ELSE prochaine_date  END,
           notes           = CASE WHEN $17::bool THEN $18 ELSE notes           END,
           updated_at = now(), updated_by = $19
         WHERE id = $1`,
        [avant.id, data.vehiculeId ?? null, data.typeCode ?? null, data.libelle ?? null,
         'derniereDate' in data, data.derniereDate ?? null,
         'dernierKm' in data, data.dernierKm ?? null,
         'intervalleKm' in data, data.intervalleKm ?? null,
         'intervalleMois' in data, data.intervalleMois ?? null,
         'prochainKm' in data, data.prochainKm ?? null,
         'prochaineDate' in data, data.prochaineDate ?? null,
         'notes' in data, data.notes ?? null,
         ctx.user.id],
      );
      const apres = await tx.one('SELECT * FROM entretiens WHERE id = $1', [avant.id]);
      await record({
        tx,
        actor: ctx.user,
        action: 'entretien.update',
        entity: 'entretien',
        entityId: avant.id,
        entityLabel: apres.libelle,
        summary: 'Modification de l’échéance « ' + apres.libelle + ' ».',
        changes: diff(avant, apres, {
          fields: ['libelle', 'type_code', 'derniere_date', 'dernier_km',
                   'intervalle_km', 'intervalle_mois', 'prochain_km', 'prochaine_date', 'notes'],
        }),
        ip: ctx.ip,
      });
    });

    ctx.ok({ entretien: await chargerAvecEtat(avant.id) });
  },
  { permission: 'maintenance.edit' },
);

/* ------------------------------------------------------------------ */
/*  « Entretien effectué » (§34)                                       */
/* ------------------------------------------------------------------ */

entretienRoutes.post(
  '/:id/effectue',
  async (ctx) => {
    const entretien = await one('SELECT * FROM entretiens WHERE id = $1', [ctx.params.id]);
    if (!entretien) throw notFound('Cet entretien n’existe pas.');

    const data = validate(ctx.body, {
      date: { type: 'date', required: true },
      kilometrage: rules.kilometrage,
      coutCents: rules.montant,
      notes: rules.notes,
      // Ce que l'utilisateur veut pour la PROCHAINE fois. Absent, l'intervalle
      // propose ; present, c'est lui qui s'applique, tel quel (§11, §12).
      prochainKm: rules.kilometrage,
      prochaineDate: rules.optionalDate,
      // Un entretien ponctuel qui ne se reconduit pas.
      clore: { type: 'bool', default: false },
      idempotencyKey: { type: 'string', max: 80 },
    });

    if (data.date > today()) {
      throw badRequest('La date de réalisation est dans le futur (' + data.date + ').');
    }

    const vehicule = await one(
      'SELECT id, libelle, immatriculation, archived_at FROM vehicules WHERE id = $1',
      [entretien.vehicule_id],
    );
    if (vehicule.archived_at) throw conflict('Ce véhicule est archivé.');

    // La prochaine echeance : saisie, sinon proposee par l'intervalle a
    // partir de CETTE realisation.
    const propose = prochaineEcheanceProposee({
      km: data.kilometrage,
      date: data.date,
      intervalleKm: entretien.intervalle_km,
      intervalleMois: entretien.intervalle_mois,
    });
    const prochainKm = data.clore ? null : (data.prochainKm ?? propose.prochainKm);
    const prochaineDate = data.clore ? null : (data.prochaineDate ?? propose.prochaineDate);

    // Une echeance qui ne se reconduit pas sort des alertes : ce n'est pas
    // un effet de bord, c'est une decision. Sans intervalle enregistre et
    // sans prochaine echeance saisie, on ne devine pas — on demande.
    //
    // Fermer en silence serait le pire des comportements : l'entretien
    // disparaitrait du tableau de bord, et personne ne saurait avant la
    // panne que plus rien ne le surveillait.
    if (!data.clore && prochainKm === null && prochaineDate === null) {
      // Un code propre plutot que le « REQUETE_INVALIDE » generique : l'ecran
      // doit pouvoir distinguer ce cas — il rouvre le formulaire sur le champ
      // de la prochaine echeance — d'une saisie simplement fautive.
      throw new AppError(
        400,
        'Aucune prochaine échéance ne peut être déduite : cet entretien n’a pas d’intervalle ' +
        'enregistré. Indiquez le prochain kilométrage ou la prochaine date, ou cochez ' +
        '« ne pas reconduire » pour le clôturer.',
        { code: 'ECHEANCE_INDETERMINEE' },
      );
    }

    const statut = data.clore ? 'CLOS' : 'ACTIF';

    // Un entretien qui se reconduit doit reculer : refaire la vidange a
    // 150 200 km et reporter la suivante a 150 000 la rendrait immediatement
    // « dépassée », et l'ecran afficherait une alerte que le geste vient
    // precisement de lever.
    if (statut === 'ACTIF') {
      if (prochainKm !== null && data.kilometrage !== undefined && data.kilometrage !== null
          && prochainKm <= data.kilometrage) {
        throw badRequest(
          'La prochaine échéance (' + prochainKm + ' km) n’est pas postérieure au kilométrage ' +
          'de la réalisation (' + data.kilometrage + ' km) : elle serait dépassée aussitôt.',
        );
      }
      if (prochaineDate !== null && prochaineDate <= data.date) {
        throw badRequest(
          'La prochaine date (' + prochaineDate + ') n’est pas postérieure à la date de ' +
          'réalisation (' + data.date + ') : elle serait échue aussitôt.',
        );
      }
    }

    const activiteId = newId();
    await transaction(async (tx) => {
      if (data.idempotencyKey) {
        const deja = await tx.one(
          'SELECT id FROM activites WHERE idempotency_key = $1', [data.idempotencyKey],
        );
        if (deja) return;
      }

      // 1. L'activite : c'est elle qui porte le cout et fait avancer le
      //    compteur. Le type d'activite reprend celui de l'entretien quand il
      //    existe des deux cotes (VIDANGE, PNEUS...), « ENTRETIEN » sinon.
      const typeActivite = await tx.value(
        "SELECT code FROM types WHERE domaine = 'ACTIVITE' AND code = $1 AND actif",
        [entretien.type_code],
      );
      await tx.query(
        `INSERT INTO activites
           (id, vehicule_id, date_activite, type_code, prestation, kilometrage,
            depense_cents, recette_cents, notes, entretien_id, idempotency_key,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$11)`,
        [activiteId, entretien.vehicule_id, data.date, typeActivite ?? 'ENTRETIEN',
         entretien.libelle, data.kilometrage ?? null, data.coutCents,
         data.notes ?? null, entretien.id, data.idempotencyKey ?? null, ctx.user.id],
      );

      // 2. L'entretien : realise, et reporte.
      await tx.query(
        `UPDATE entretiens SET
           derniere_date = $2, dernier_km = COALESCE($3, dernier_km),
           prochain_km = $4, prochaine_date = $5, statut = $6,
           updated_at = now(), updated_by = $7
         WHERE id = $1`,
        [entretien.id, data.date, data.kilometrage ?? null,
         prochainKm, prochaineDate, statut, ctx.user.id],
      );

      await record({
        tx,
        actor: ctx.user,
        action: 'entretien.effectue',
        entity: 'entretien',
        entityId: entretien.id,
        entityLabel: entretien.libelle,
        summary:
          '« ' + entretien.libelle +' » réalisé le ' + data.date +
          (data.kilometrage != null ? ' à ' + data.kilometrage + ' km' : '') +
          (data.coutCents ? ', pour ' + (data.coutCents / 100).toFixed(2) + ' DH' : '') +
          '. ' + (statut === 'CLOS'
            ? 'Échéance close, elle ne se reconduit pas.'
            : 'Prochaine échéance : ' + decrireEcheance(prochainKm, prochaineDate) + '.'),
        ip: ctx.ip,
      });
    });

    ctx.ok({
      entretien: await chargerAvecEtat(entretien.id),
      activiteId,
    });
  },
  { permission: 'maintenance.close' },
);

/* ------------------------------------------------------------------ */
/*  Cloture et suppression                                             */
/* ------------------------------------------------------------------ */

entretienRoutes.post(
  '/:id/clore',
  async (ctx) => {
    const e = await one('SELECT * FROM entretiens WHERE id = $1', [ctx.params.id]);
    if (!e) throw notFound('Cet entretien n’existe pas.');
    if (e.statut === 'CLOS') throw conflict('Cet entretien est déjà clos.');
    const { motif } = validate(ctx.body, { motif: rules.requiredReason });

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE entretiens SET statut = 'CLOS', prochain_km = NULL, prochaine_date = NULL,
                               updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [e.id, ctx.user.id],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'entretien.clore',
        entity: 'entretien',
        entityId: e.id,
        entityLabel: e.libelle,
        summary: 'Clôture de l’échéance « ' + e.libelle + ' ». Motif : ' + motif,
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    ctx.ok({ entretien: await chargerAvecEtat(e.id) });
  },
  { permission: 'maintenance.edit' },
);

entretienRoutes.delete(
  '/:id',
  async (ctx) => {
    const e = await one('SELECT * FROM entretiens WHERE id = $1', [ctx.params.id]);
    if (!e) throw notFound('Cet entretien n’existe pas.');

    const { motif } = validate(ctx.body, { motif: rules.requiredReason });

    // Une echeance qui a deja servi porte de l'historique : elle se clot,
    // elle ne s'efface pas (§29). Seule une echeance jamais realisee — donc
    // creee par erreur — peut disparaitre.
    const realisations = await one(
      'SELECT COUNT(*)::int AS n FROM activites WHERE entretien_id = $1', [e.id],
    );
    if (Number(realisations.n) > 0) {
      throw conflict(
        'Cette échéance a déjà été réalisée ' + realisations.n + ' fois : la supprimer ' +
        'couperait l’historique du véhicule. Clôturez-la — elle sortira des alertes et ' +
        'restera consultable.',
      );
    }

    await transaction(async (tx) => {
      await tx.query('DELETE FROM entretiens WHERE id = $1', [e.id]);
      await record({
        tx,
        actor: ctx.user,
        action: 'entretien.delete',
        entity: 'entretien',
        entityId: e.id,
        entityLabel: e.libelle,
        summary: 'Suppression de l’échéance « ' + e.libelle + ' », jamais réalisée. Motif : ' + motif,
        severity: 'warning',
        ip: ctx.ip,
      });
    });

    ctx.ok({ supprime: true });
  },
  { permission: 'maintenance.delete' },
);

/* ------------------------------------------------------------------ */
/*  Aides                                                              */
/* ------------------------------------------------------------------ */

async function verifierTypeEntretien(code) {
  const t = await one(
    "SELECT code, actif FROM types WHERE domaine = 'ENTRETIEN' AND code = $1", [code],
  );
  if (!t) throw badRequest('Le type d’entretien « ' + code + ' » n’existe pas.');
  if (!t.actif) throw badRequest('Le type d’entretien « ' + code + ' » est désactivé.');
}

/**
 * Une echeance anterieure a la realisation qui la precede est une faute de
 * saisie : elle naitrait deja depassee.
 */
function verifierCoherence({ dernierKm, derniereDate, prochainKm, prochaineDate }) {
  if (dernierKm != null && prochainKm != null && prochainKm <= dernierKm) {
    throw badRequest(
      'La prochaine échéance (' + prochainKm + ' km) doit être postérieure au kilométrage ' +
      'de la dernière réalisation (' + dernierKm + ' km).',
    );
  }
  const d1 = derniereDate ? String(derniereDate).slice(0, 10) : null;
  const d2 = prochaineDate ? String(prochaineDate).slice(0, 10) : null;
  if (d1 && d2 && d2 <= d1) {
    throw badRequest(
      'La prochaine date (' + d2 + ') doit être postérieure à celle de la dernière ' +
      'réalisation (' + d1 + ').',
    );
  }
}

const decrireEcheance = (km, date) => {
  const parts = [];
  if (km != null) parts.push(km + ' km');
  if (date) parts.push('le ' + String(date).slice(0, 10));
  return parts.length ? parts.join(' ou ') : 'aucune';
};
