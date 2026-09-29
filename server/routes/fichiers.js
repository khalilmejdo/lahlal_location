/**
 * Les pieces jointes : photos de compteur, factures de garage, attestations.
 *
 * Reprise directe de lahlal_samuplus, precautions comprises :
 *
 *   - le type reel se determine sur les octets d'en-tete, jamais sur
 *     l'extension ni sur le Content-Type annonce (domain/fichiers.js) ;
 *   - le contenu est stocke en base, et jamais servi depuis un chemin
 *     devinable ;
 *   - la restitution force `nosniff` et une disposition en piece jointe,
 *     pour qu'un fichier piege ne puisse pas s'executer dans le navigateur ;
 *   - l'empreinte est verifiee a la restitution : une piece alteree en base
 *     ne sort pas en se faisant passer pour l'originale.
 *
 * LE DROIT EST PORTE PAR L'ENTITE VISEE, PAS SEULEMENT PAR LA ROUTE.
 *
 * Une attestation d'assurance et une photo de compteur se stockent pareil,
 * mais ne se lisent pas sous le meme droit. La permission declaree sur la
 * route est la premiere barriere ; la table ci-dessous est la seconde, et
 * c'est la seule qui distingue. C'est le correctif N-01 du socle, ou trois
 * valeurs mal choisies ouvraient les justificatifs comptables a un role qui
 * n'avait aucun droit sur la comptabilite.
 */
import { Router } from '../http/router.js';
import { validate } from '../core/validate.js';
import { newId, sha256 } from '../core/crypto.js';
import { notFound, badRequest, forbidden, tooLarge, unsupportedMedia } from '../core/errors.js';
import { record } from '../core/audit.js';
import { can } from '../core/rbac.js';
import { all, one, transaction } from '../db/index.js';
import { PROFILES } from '../core/ratelimit.js';
import { examiner, estPrevisualisable, MAX_FICHIERS_PAR_ENVOI } from '../domain/fichiers.js';

export const fichierRoutes = new Router();

/**
 * A quoi une piece peut se rattacher, et sous quel droit.
 *
 * `voir` decide de la lecture et du telechargement, `joindre` de l'ajout,
 * `retirer` de la suppression. Joindre une photo a une activite n'est pas
 * modifier l'activite : ces gestes ont leur propre droit plutot que
 * d'emprunter celui d'un autre.
 */
export const ENTITES = {
  vehicule: { table: 'vehicules', libelle: 'véhicule', voir: 'vehicle.view' },
  activite: { table: 'activites', libelle: 'activité', voir: 'activity.view' },
  entretien: { table: 'entretiens', libelle: 'entretien', voir: 'maintenance.view' },
};

const CODES_ENTITES = Object.keys(ENTITES);

async function exigerEntite(user, entity, entityId, droit) {
  const regle = ENTITES[entity];
  if (!regle) throw badRequest('Entité inconnue : ' + entity + '.');

  // Le droit de VOIR l'entite portante conditionne tout geste sur ses
  // pieces : on ne joint pas une photo a un objet qu'on n'a pas le droit de
  // regarder, et on n'en supprime pas davantage.
  if (!can(user, regle.voir)) {
    throw forbidden('Vous n’avez pas accès à cet ' + regle.libelle + '.');
  }
  if (!can(user, droit)) {
    throw forbidden('Vous n’avez pas le droit nécessaire sur les pièces jointes.');
  }

  const existe = await one(
    'SELECT 1 AS ok FROM ' + regle.table + ' WHERE id = $1', [entityId],
  );
  if (!existe) throw notFound('Cet ' + regle.libelle + ' n’existe pas.');
}

/* ------------------------------------------------------------------ */
/*  Liste des pieces d'une entite                                      */
/* ------------------------------------------------------------------ */

fichierRoutes.get(
  '/',
  async (ctx) => {
    const entity = String(ctx.query('entity') ?? '');
    const entityId = ctx.queryUuid('entityId');
    if (!CODES_ENTITES.includes(entity)) throw badRequest('Entité inconnue.');
    if (!entityId) throw badRequest('Identifiant d’entité absent ou mal formé.');

    await exigerEntite(ctx.user, entity, entityId, 'attachment.view');

    const pieces = await all(
      `SELECT id, nom_origine, mime, taille, ordre, created_at, created_by_name
         FROM fichiers WHERE entity = $1 AND entity_id = $2
        ORDER BY ordre, created_at`,
      [entity, entityId],
    );

    ctx.ok({ pieces: pieces.map(presenter) });
  },
  { permission: 'attachment.view' },
);

const presenter = (f) => ({
  id: f.id,
  nom: f.nom_origine,
  mime: f.mime,
  taille: f.taille,
  ordre: f.ordre,
  // L'ecran sait ainsi s'il peut peindre une miniature ou s'il doit poser
  // l'icone generique (§30) : un PDF et un HEIC ne s'affichent pas.
  previsualisable: estPrevisualisable(f.mime),
  ajouteLe: f.created_at,
  ajoutePar: f.created_by_name,
});

/* ------------------------------------------------------------------ */
/*  Televersement                                                      */
/* ------------------------------------------------------------------ */

fichierRoutes.post(
  '/',
  async (ctx) => {
    const data = validate(ctx.body, {
      entity: { type: 'enum', values: CODES_ENTITES, required: true },
      entityId: { type: 'uuid', required: true },
    });

    await exigerEntite(ctx.user, data.entity, data.entityId, 'attachment.add');

    if (!ctx.files.length) throw badRequest('Aucun fichier reçu.');
    if (ctx.files.length > MAX_FICHIERS_PAR_ENVOI) {
      throw badRequest(MAX_FICHIERS_PAR_ENVOI + ' fichiers au maximum par envoi.');
    }

    // Tous les fichiers sont examines AVANT d'en ecrire un seul : un envoi
    // de quatre photos dont la troisieme est un exécutable ne doit pas
    // laisser les deux premieres en base et rendre une erreur. C'est tout,
    // ou rien.
    const retenus = [];
    for (const recu of ctx.files) {
      const verdict = examiner(recu);
      if (!verdict.ok) {
        if (verdict.code === 'TROP_GROS') throw tooLarge(verdict.motif);
        if (verdict.code === 'TYPE_REFUSE') throw unsupportedMedia(verdict.motif);
        throw badRequest(verdict.motif);
      }
      retenus.push(verdict.fichier);
    }

    const ordreDepart = Number(await one(
      'SELECT COALESCE(MAX(ordre), -1) + 1 AS n FROM fichiers WHERE entity = $1 AND entity_id = $2',
      [data.entity, data.entityId],
    ).then((r) => r.n));

    const crees = [];
    await transaction(async (tx) => {
      let ordre = ordreDepart;
      for (const f of retenus) {
        const id = newId();
        await tx.query(
          `INSERT INTO fichiers
             (id, entity, entity_id, nom_origine, mime, taille, sha256, contenu,
              ordre, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, data.entity, data.entityId, f.nom, f.mime, f.taille,
           sha256(f.buffer), f.buffer, ordre++, ctx.user.id, ctx.user.username],
        );
        crees.push({ id, nom: f.nom, mime: f.mime, taille: f.taille,
                     previsualisable: f.previsualisable, ordre: ordre - 1 });
      }

      await record({
        tx,
        actor: ctx.user,
        action: 'fichier.upload',
        entity: data.entity,
        entityId: data.entityId,
        entityLabel: retenus.map((f) => f.nom).join(', '),
        summary:
          retenus.length + ' pièce(s) jointe(s) ajoutée(s) : ' +
          retenus.map((f) => f.nom).join(', ') + '.',
        ip: ctx.ip,
      });
    });

    ctx.created({ pieces: crees });
  },
  {
    permission: 'attachment.add',
    // Le televersement a son propre budget : il est plus couteux qu'un appel
    // d'ecran, et une rafale de photos depuis un telephone ne doit pas
    // consommer celui de toute la navigation.
    rateLimit: PROFILES.upload,
  },
);

/* ------------------------------------------------------------------ */
/*  Restitution                                                        */
/* ------------------------------------------------------------------ */

fichierRoutes.get(
  '/:id',
  async (ctx) => {
    const f = await one('SELECT * FROM fichiers WHERE id = $1', [ctx.params.id]);
    if (!f) throw notFound('Cette pièce jointe n’existe pas.');

    await exigerEntite(ctx.user, f.entity, f.entity_id, 'attachment.view');

    // L'empreinte a ete calculee a l'entree : si elle ne correspond plus, le
    // contenu a change en base sans passer par l'application. On ne le sert
    // pas — on ne sait pas ce que c'est.
    if (sha256(f.contenu) !== f.sha256) {
      throw badRequest(
        'L’empreinte de cette pièce ne correspond plus à son contenu : elle ne sera pas ' +
        'restituée. Prévenez l’administrateur.',
      );
    }

    // Une image se regarde dans la page (miniature, apercu) ; un PDF et tout
    // le reste se telechargent. « inline » n'est concede qu'aux types dont on
    // sait qu'ils ne s'executent pas, et jamais sur la foi du nom du fichier.
    const inline = ctx.queryBool('inline', false) && estPrevisualisable(f.mime);

    ctx.file(f.contenu, {
      filename: f.nom_origine,
      mimeType: f.mime,
      download: !inline,
    });
  },
  { permission: 'attachment.view' },
);

/* ------------------------------------------------------------------ */
/*  Suppression                                                        */
/* ------------------------------------------------------------------ */

fichierRoutes.delete(
  '/:id',
  async (ctx) => {
    const f = await one(
      'SELECT id, entity, entity_id, nom_origine FROM fichiers WHERE id = $1', [ctx.params.id],
    );
    if (!f) throw notFound('Cette pièce jointe n’existe pas.');

    await exigerEntite(ctx.user, f.entity, f.entity_id, 'attachment.delete');

    await transaction(async (tx) => {
      // La suppression est seche : ni corbeille, ni deleted_at, le binaire
      // disparait. C'est pourquoi elle a son propre droit, sensible.
      await tx.query('DELETE FROM fichiers WHERE id = $1', [f.id]);
      await record({
        tx,
        actor: ctx.user,
        action: 'fichier.delete',
        entity: f.entity,
        entityId: f.entity_id,
        entityLabel: f.nom_origine,
        summary: 'Suppression définitive de la pièce jointe « ' + f.nom_origine + ' ».',
        severity: 'warning',
        ip: ctx.ip,
      });
    });

    ctx.ok({ supprime: true });
  },
  { permission: 'attachment.delete' },
);

