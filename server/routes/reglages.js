/**
 * Les parametres : seuils d'alerte et types configurables.
 *
 * Regle 17 du cahier des charges — « ne pas coder en dur les parametres
 * metier qui doivent etre configurables ». Deux familles vivent ici :
 *
 *   - les SEUILS qui decident des quatre couleurs (§15) ;
 *   - les TYPES d'activite et d'entretien (§5, §35), que l'utilisateur doit
 *     pouvoir renommer, desactiver et completer.
 *
 * Un type livre en standard ne se supprime jamais : il se desactive. Des
 * activites s'y rattachent, et les effacer leur ferait perdre leur libelle —
 * l'historique se lirait en codes.
 */
import { Router } from '../http/router.js';
import { validate, validatePartial, rules } from '../core/validate.js';
import { notFound, conflict, badRequest } from '../core/errors.js';
import { record, diff } from '../core/audit.js';
import { all, one, value, transaction } from '../db/index.js';
import { BORNES_SEUILS } from '../domain/echeances.js';
import { chargerSeuils, seuils } from '../domain/seuils.js';
import { REGLAGES_POSTURE, chargerPosture } from '../core/posture.js';

export const reglageRoutes = new Router();

/* ------------------------------------------------------------------ */
/*  Les seuils                                                         */
/* ------------------------------------------------------------------ */

/** Les cles reconnues, avec leurs bornes : alertes + posture de securite. */
function bornesConnues() {
  const table = new Map();
  for (const regle of Object.values(BORNES_SEUILS)) {
    table.set(regle.cle, { min: regle.min, max: regle.max, famille: 'alertes' });
  }
  for (const [cle, regle] of Object.entries(REGLAGES_POSTURE)) {
    table.set(cle, { min: regle.min, max: regle.max, famille: 'securite' });
  }
  return table;
}

reglageRoutes.get(
  '/',
  async (ctx) => {
    const lignes = await all(
      'SELECT key, value, label, category, sort_order, updated_at FROM settings ORDER BY sort_order, key',
    );
    const bornes = bornesConnues();

    ctx.ok({
      reglages: lignes.map((l) => ({
        cle: l.key,
        valeur: l.value,
        libelle: l.label,
        categorie: l.category,
        // Les bornes accompagnent la valeur : l'ecran peut ainsi refuser une
        // saisie aberrante avant de l'envoyer, et surtout EXPLIQUER pourquoi.
        bornes: bornes.get(l.key) ?? null,
        modifieLe: l.updated_at,
      })),
      // Les seuils tels qu'ils s'appliquent reellement, apres bornage : ce
      // n'est pas toujours ce que la table contient.
      seuilsAppliques: seuils(),
    });
  },
  { permission: 'settings.view' },
);

reglageRoutes.patch(
  '/:cle',
  async (ctx) => {
    const cle = String(ctx.params.cle);
    const bornes = bornesConnues();
    const regle = bornes.get(cle);
    if (!regle) throw notFound('Ce paramètre n’existe pas : ' + cle + '.');

    // La posture de securite est reservee au super-administrateur : allonger
    // une session ou baisser le nombre d'essais avant verrouillage n'est pas
    // de l'administration courante.
    if (regle.famille === 'securite' && ctx.user.roleCode !== 'SUPERADMIN') {
      throw badRequest(
        'Les paramètres de sécurité ne se modifient que depuis un compte ' +
        'super-administrateur.',
      );
    }

    const { valeur } = validate(ctx.body, {
      valeur: { type: 'int', required: true, min: regle.min, max: regle.max },
    });

    const avant = await one('SELECT * FROM settings WHERE key = $1', [cle]);
    if (!avant) throw notFound('Ce paramètre n’existe pas : ' + cle + '.');

    await transaction(async (tx) => {
      await tx.query(
        'UPDATE settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1',
        [cle, String(valeur), ctx.user.id],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'reglage.update',
        entity: 'settings',
        entityLabel: cle,
        summary:
          'Paramètre « ' + avant.label + ' » : ' + avant.value + ' → ' + valeur + '.',
        changes: { [cle]: { from: avant.value, to: String(valeur) } },
        severity: regle.famille === 'securite' ? 'critical' : 'notice',
        ip: ctx.ip,
      });
    });

    // Les caches se rafraichissent tout de suite : un seuil change a l'ecran
    // doit s'appliquer au prochain affichage, pas au prochain redemarrage.
    // C'est le defaut F-6 du socle, ou un budget releve ne prenait effet
    // qu'au redeploiement suivant.
    if (regle.famille === 'alertes') await chargerSeuils();
    else await chargerPosture();

    ctx.ok({ cle, valeur: String(valeur), seuilsAppliques: seuils() });
  },
  { permission: 'settings.edit' },
);

/* ------------------------------------------------------------------ */
/*  Les types (§5, §35)                                                */
/* ------------------------------------------------------------------ */

const DOMAINES = ['ACTIVITE', 'ENTRETIEN'];

reglageRoutes.get(
  '/types/:domaine',
  async (ctx) => {
    const domaine = String(ctx.params.domaine).toUpperCase();
    if (!DOMAINES.includes(domaine)) throw notFound('Domaine inconnu.');

    const lignes = await all(
      `SELECT t.*,
              (SELECT COUNT(*) FROM activites a WHERE $1 = 'ACTIVITE' AND a.type_code = t.code) +
              (SELECT COUNT(*) FROM entretiens e WHERE $1 = 'ENTRETIEN' AND e.type_code = t.code)
                AS usages
         FROM types t WHERE t.domaine = $1
        ORDER BY t.ordre, t.libelle`,
      [domaine],
    );

    ctx.ok({
      types: lignes.map((t) => ({
        domaine: t.domaine,
        code: t.code,
        libelle: t.libelle,
        sens: t.sens,
        actif: t.actif,
        ordre: t.ordre,
        systeme: t.is_system,
        usages: Number(t.usages),
      })),
    });
  },
  { permission: 'settings.view', anyPermission: true },
);

reglageRoutes.post(
  '/types/:domaine',
  async (ctx) => {
    const domaine = String(ctx.params.domaine).toUpperCase();
    if (!DOMAINES.includes(domaine)) throw notFound('Domaine inconnu.');

    const data = validate(ctx.body, {
      code: { type: 'string', required: true, min: 2, max: 40, upper: true },
      libelle: rules.requiredText(60),
      sens: { type: 'enum', values: ['DEPENSE', 'RECETTE', 'MIXTE'], default: 'MIXTE' },
      ordre: { type: 'int', min: 0, max: 9999, default: 500 },
    });

    const code = data.code.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) {
      throw badRequest('Le code doit commencer par une lettre et ne contenir que des ' +
        'majuscules, des chiffres et des tirets bas.');
    }

    const clash = await value(
      'SELECT libelle FROM types WHERE domaine = $1 AND code = $2', [domaine, code],
    );
    if (clash) throw conflict('Le code ' + code + ' est déjà utilisé par « ' + clash + ' ».');

    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO types (domaine, code, libelle, sens, ordre, is_system, actif)
         VALUES ($1,$2,$3,$4,$5,FALSE,TRUE)`,
        [domaine, code, data.libelle, data.sens, data.ordre],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'type.create',
        entity: 'type',
        entityLabel: domaine + '/' + code,
        summary: 'Création du type « ' + data.libelle + ' » (' + code + ').',
        ip: ctx.ip,
      });
    });

    ctx.created({ type: { domaine, code, libelle: data.libelle, sens: data.sens,
                          ordre: data.ordre, actif: true, systeme: false } });
  },
  { permission: 'settings.edit' },
);

reglageRoutes.patch(
  '/types/:domaine/:code',
  async (ctx) => {
    const domaine = String(ctx.params.domaine).toUpperCase();
    const code = String(ctx.params.code).toUpperCase();

    const avant = await one(
      'SELECT * FROM types WHERE domaine = $1 AND code = $2', [domaine, code],
    );
    if (!avant) throw notFound('Ce type n’existe pas.');

    const data = validatePartial(ctx.body, {
      libelle: rules.shortText(60),
      sens: { type: 'enum', values: ['DEPENSE', 'RECETTE', 'MIXTE'] },
      ordre: { type: 'int', min: 0, max: 9999 },
      actif: { type: 'bool' },
    });
    if (!Object.keys(data).length) throw badRequest('Aucune modification demandée.');

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE types SET libelle = COALESCE($3, libelle),
                          sens    = COALESCE($4, sens),
                          ordre   = COALESCE($5, ordre),
                          actif   = COALESCE($6, actif)
          WHERE domaine = $1 AND code = $2`,
        [domaine, code, data.libelle ?? null, data.sens ?? null,
         data.ordre ?? null, data.actif ?? null],
      );
      const apres = await tx.one(
        'SELECT * FROM types WHERE domaine = $1 AND code = $2', [domaine, code],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'type.update',
        entity: 'type',
        entityLabel: domaine + '/' + code,
        summary: 'Modification du type « ' + apres.libelle + ' ».',
        changes: diff(avant, apres, { fields: ['libelle', 'sens', 'ordre', 'actif'] }),
        ip: ctx.ip,
      });
    });

    ctx.ok({ type: { domaine, code } });
  },
  { permission: 'settings.edit' },
);

reglageRoutes.delete(
  '/types/:domaine/:code',
  async (ctx) => {
    const domaine = String(ctx.params.domaine).toUpperCase();
    const code = String(ctx.params.code).toUpperCase();

    const type = await one(
      'SELECT * FROM types WHERE domaine = $1 AND code = $2', [domaine, code],
    );
    if (!type) throw notFound('Ce type n’existe pas.');

    if (type.is_system) {
      throw conflict(
        'Le type « ' + type.libelle +' » est livré en standard : il ne se supprime pas. ' +
        'Désactivez-le — il disparaîtra des formulaires et l’historique gardera son libellé.',
      );
    }

    const usages = Number(await value(
      domaine === 'ACTIVITE'
        ? 'SELECT COUNT(*)::int FROM activites WHERE type_code = $1'
        : 'SELECT COUNT(*)::int FROM entretiens WHERE type_code = $1',
      [code],
    ));
    if (usages > 0) {
      throw conflict(
        'Ce type est utilisé par ' + usages + ' enregistrement(s) : le supprimer leur ferait ' +
        'perdre leur libellé. Désactivez-le à la place.',
      );
    }

    await transaction(async (tx) => {
      await tx.query('DELETE FROM types WHERE domaine = $1 AND code = $2', [domaine, code]);
      await record({
        tx,
        actor: ctx.user,
        action: 'type.delete',
        entity: 'type',
        entityLabel: domaine + '/' + code,
        summary: 'Suppression du type « ' + type.libelle + ' », jamais utilisé.',
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    ctx.ok({ supprime: true });
  },
  { permission: 'settings.edit' },
);
