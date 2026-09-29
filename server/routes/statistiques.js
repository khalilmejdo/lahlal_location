/**
 * Les statistiques (§20, §21).
 *
 * Trois lectures de la meme periode : par mois, par vehicule, par type
 * d'activite. Les filtres se combinent — « toutes les dépenses d'entretien
 * de tous les véhicules cette année » est une periode plus des types, sans
 * vehicule ; « le Renault Master en septembre » est un vehicule plus une
 * periode.
 *
 * TOUT SE FAIT EN SQL, PAR AGREGAT.
 *
 * La tentation serait de charger les activites et de les additionner en
 * JavaScript. Cela marche jusqu'au jour ou la periode demandee compte
 * quarante mille lignes, et l'ecran les recoit toutes pour afficher quatre
 * nombres. Les sommes se font la ou sont les donnees.
 */
import { Router } from '../http/router.js';
import { badRequest } from '../core/errors.js';
import { all, one, Where } from '../db/index.js';
import { today } from '../core/text.js';

export const statistiqueRoutes = new Router();

/** Les filtres communs aux trois lectures. */
function filtres(ctx) {
  const du = ctx.queryDate('du');
  const au = ctx.queryDate('au');
  if (du && au && du > au) {
    throw badRequest('La période est inversée : ' + du + ' est postérieur à ' + au + '.');
  }

  const w = new Where();
  w.add('a.deleted_at IS NULL');
  w.addIf(du, 'a.date_activite >= ?', du);
  w.addIf(au, 'a.date_activite <= ?', au);

  const vehicule = ctx.queryUuid('vehicule');
  w.addIf(vehicule, 'a.vehicule_id = ?', vehicule);

  const types = (ctx.query('type') ?? '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z][A-Z0-9_]{1,39}$/.test(t));
  if (types.length) w.add('a.type_code = ANY(?::text[])', types);

  return { w, periode: { du, au: au ?? today() } };
}

const nombres = (l) => ({
  nbActivites: Number(l?.nb ?? 0),
  depensesCents: Number(l?.depenses_cents ?? 0),
  recettesCents: Number(l?.recettes_cents ?? 0),
  resultatCents: Number(l?.resultat_cents ?? 0),
});

const AGREGATS = `
  COUNT(*)::int                              AS nb,
  COALESCE(SUM(a.depense_cents), 0)::bigint  AS depenses_cents,
  COALESCE(SUM(a.recette_cents), 0)::bigint  AS recettes_cents,
  COALESCE(SUM(a.resultat_cents), 0)::bigint AS resultat_cents`;

statistiqueRoutes.get(
  '/',
  async (ctx) => {
    const { w, periode } = filtres(ctx);
    const params = w.params;
    const where = w.sql();

    // Le total de la periode.
    const total = await one(
      `SELECT ${AGREGATS} FROM activites a ${where}`, params,
    );

    // Par vehicule (§20). Les vehicules sans activite sur la periode ne
    // figurent pas : une ligne a zero n'apprend rien et allonge le tableau.
    const parVehicule = await all(
      `SELECT a.vehicule_id AS id,
              COALESCE(v.libelle, v.immatriculation) AS nom,
              v.immatriculation,
              ${AGREGATS},
              MIN(a.kilometrage) AS km_min,
              MAX(a.kilometrage) AS km_max
         FROM activites a
         JOIN vehicules v ON v.id = a.vehicule_id
         ${where}
        GROUP BY a.vehicule_id, v.libelle, v.immatriculation
        ORDER BY resultat_cents DESC`,
      params,
    );

    // Par type d'activite (§20).
    const parType = await all(
      `SELECT a.type_code AS code,
              COALESCE(t.libelle, a.type_code) AS libelle,
              ${AGREGATS}
         FROM activites a
         LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
         ${where}
        GROUP BY a.type_code, t.libelle
        ORDER BY resultat_cents DESC`,
      params,
    );

    // Par periode : la serie qui se dessine en colonnes.
    //
    // La granularite est un CHOIX D'ECRAN, pas une constante. « Combien
    // j'ai depense cette semaine » et « combien ce mois-ci » sont deux
    // questions differentes, et la seconde ne repond pas a la premiere :
    // un mois qui finit bien peut cacher trois semaines mauvaises.
    //
    // `date_trunc` ne prend pas de parametre lie : la valeur vient d'une
    // liste blanche, jamais de la requete telle quelle.
    const granularite = ctx.query('granularite') === 'semaine' ? 'semaine' : 'mois';
    const unite = granularite === 'semaine' ? 'week' : 'month';
    // La semaine ISO commence le lundi — c'est ce que fait date_trunc, et
    // c'est la semaine dont parlent les gens ici.
    const format = granularite === 'semaine' ? 'IYYY-"S"IW' : 'YYYY-MM';

    const parPeriode = await all(
      `SELECT to_char(date_trunc('${unite}', a.date_activite), '${format}') AS periode,
              MIN(a.date_activite) AS debut,
              ${AGREGATS}
         FROM activites a
         ${where}
        GROUP BY date_trunc('${unite}', a.date_activite)
        ORDER BY 1`,
      params,
    );

    ctx.ok({
      periode,
      total: nombres(total),
      parVehicule: parVehicule.map((l) => ({
        id: l.id,
        nom: l.nom,
        immatriculation: l.immatriculation,
        ...nombres(l),
        // L'ecart entre le plus petit et le plus grand releve de la periode.
        // Additionner des compteurs n'aurait aucun sens.
        kilometresParcourus: l.km_min !== null && l.km_max !== null ? l.km_max - l.km_min : null,
      })),
      parType: parType.map((l) => ({ code: l.code, libelle: l.libelle, ...nombres(l) })),
      granularite,
      parPeriode: parPeriode.map((l) => ({
        periode: l.periode,
        debut: l.debut,
        ...nombres(l),
      })),
    });
  },
  { permission: 'stats.view' },
);
