/**
 * Les exports (§40).
 *
 * Le socle sait deja produire un classeur Excel (server/core/tableur.js) et
 * un CSV (server/core/csv.js) sans aucune dependance : on les reprend plutot
 * que d'ajouter une bibliotheque, conformement a la regle 3.
 *
 * L'EXPORT SUIT EXACTEMENT LES FILTRES DE L'ECRAN.
 *
 * C'est la seule regle qui compte ici, et c'est celle qu'on rate : un export
 * qui rend autre chose que ce qui est affiche fait prendre des decisions sur
 * des chiffres que personne n'a vus. La construction des filtres est donc
 * importee de routes/activites.js — la meme fonction, pas une copie qui
 * derivera.
 *
 * Il n'y a pas d'export PDF binaire : l'historique d'un vehicule se rend en
 * HTML imprimable, que le navigateur enregistre en PDF. C'est ce que fait
 * deja lahlal_samuplus pour ses etats, et cela evite d'embarquer un moteur
 * de rendu pour un document d'une page.
 */
import { Router } from '../http/router.js';
import { notFound, badRequest } from '../core/errors.js';
import { all, one } from '../db/index.js';
import { PROFILES } from '../core/ratelimit.js';
import { construireXlsx, dateExcel, MIME_XLSX } from '../core/tableur.js';
import { toCsv } from '../core/csv.js';
import { centsToNumber, formatCents } from '../core/money.js';
import { today, formatDateFr, escapeHtml } from '../core/text.js';
import { construireFiltres } from './activites.js';
import { vehiculeAvecEtat } from '../domain/flotte.js';

export const exportRoutes = new Router();

/** Borne de securite : un export n'est pas une sauvegarde. */
const MAX_LIGNES = 20000;

async function lireActivitesFiltrees(ctx) {
  const w = construireFiltres(ctx);
  const lignes = await all(
    `SELECT a.date_activite, a.prestation, a.kilometrage,
            a.depense_cents, a.recette_cents, a.resultat_cents, a.notes,
            COALESCE(t.libelle, a.type_code) AS type_libelle,
            v.immatriculation,
            COALESCE(v.libelle, v.immatriculation) AS vehicule_nom,
            (SELECT COUNT(*) FROM fichiers f
              WHERE f.entity = 'activite' AND f.entity_id = a.id
                AND f.deleted_at IS NULL) AS nb_pieces
       FROM activites a
       JOIN vehicules v ON v.id = a.vehicule_id
       LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
       ${w.sql()}
      ORDER BY a.date_activite DESC, a.created_at DESC
      LIMIT ${w.next(MAX_LIGNES + 1)}`,
    w.params,
  );

  if (lignes.length > MAX_LIGNES) {
    throw badRequest(
      'La sélection dépasse ' + MAX_LIGNES.toLocaleString('fr-FR') + ' lignes. ' +
      'Restreignez la période ou le véhicule : un export n’est pas une sauvegarde.',
    );
  }
  return lignes;
}

const COLONNES = [
  { titre: 'Date', largeur: 12 },
  { titre: 'Véhicule', largeur: 22 },
  { titre: 'Immatriculation', largeur: 16 },
  { titre: 'Type', largeur: 18 },
  { titre: 'Prestation', largeur: 40 },
  { titre: 'Kilométrage', largeur: 14 },
  { titre: 'Dépense', largeur: 14, format: 'montant' },
  { titre: 'Recette', largeur: 14, format: 'montant' },
  { titre: 'Résultat', largeur: 14, format: 'montant' },
  { titre: 'Pièces', largeur: 9 },
  { titre: 'Notes', largeur: 40 },
];

const enLigne = (l) => [
  dateExcel(l.date_activite),
  l.vehicule_nom,
  l.immatriculation,
  l.type_libelle,
  l.prestation,
  l.kilometrage ?? null,
  centsToNumber(l.depense_cents),
  centsToNumber(l.recette_cents),
  centsToNumber(l.resultat_cents),
  Number(l.nb_pieces),
  l.notes ?? '',
];

/* ------------------------------------------------------------------ */
/*  Classeur Excel                                                     */
/* ------------------------------------------------------------------ */

exportRoutes.get(
  '/activites.xlsx',
  async (ctx) => {
    const lignes = await lireActivitesFiltrees(ctx);

    const totaux = lignes.reduce((t, l) => ({
      depense: t.depense + Number(l.depense_cents),
      recette: t.recette + Number(l.recette_cents),
      resultat: t.resultat + Number(l.resultat_cents),
    }), { depense: 0, recette: 0, resultat: 0 });

    const classeur = construireXlsx({
      feuille: 'Activités',
      colonnes: COLONNES,
      entete: [
        { valeurs: ['Activités de la flotte'], style: 'titre' },
        { valeurs: [decrireSelection(ctx)] },
        { valeurs: ['Édité le ' + formatDateFr(today()) + ' par ' + ctx.user.username] },
      ],
      lignes: lignes.map(enLigne),
      total: ['Total', '', '', '', lignes.length + ' activité(s)', '',
              centsToNumber(totaux.depense), centsToNumber(totaux.recette),
              centsToNumber(totaux.resultat), '', ''],
      mentions: [
        'Activité non déclarée : ces montants sont des dépenses réellement engagées et des ' +
        'recettes réellement perçues. Ils ne constituent pas une comptabilité officielle et ' +
        'ne comportent aucune TVA.',
      ],
      paysage: true,
    });

    ctx.file(classeur, {
      filename: 'activites-' + today() + '.xlsx',
      mimeType: MIME_XLSX,
      download: true,
    });
  },
  { permission: 'export.data', rateLimit: PROFILES.export },
);

/* ------------------------------------------------------------------ */
/*  CSV                                                                */
/* ------------------------------------------------------------------ */

exportRoutes.get(
  '/activites.csv',
  async (ctx) => {
    const lignes = await lireActivitesFiltrees(ctx);

    const csv = toCsv(
      COLONNES.map((c) => c.titre),
      lignes.map((l) => [
        l.date_activite,
        l.vehicule_nom,
        l.immatriculation,
        l.type_libelle,
        l.prestation,
        l.kilometrage ?? '',
        centsToNumber(l.depense_cents),
        centsToNumber(l.recette_cents),
        centsToNumber(l.resultat_cents),
        Number(l.nb_pieces),
        l.notes ?? '',
      ]),
    );

    ctx.file(Buffer.from(csv, 'utf8'), {
      filename: 'activites-' + today() + '.csv',
      mimeType: 'text/csv; charset=utf-8',
      download: true,
    });
  },
  { permission: 'export.data', rateLimit: PROFILES.export },
);

/* ------------------------------------------------------------------ */
/*  Etat imprimable d'un vehicule                                      */
/* ------------------------------------------------------------------ */

exportRoutes.get(
  '/vehicule/:id',
  async (ctx) => {
    const vehicule = await vehiculeAvecEtat(ctx.params.id);
    if (!vehicule) throw notFound('Ce véhicule n’existe pas.');

    const du = ctx.queryDate('du');
    const au = ctx.queryDate('au') ?? today();

    const params = [vehicule.id, du, au];
    const activites = await all(
      `SELECT a.date_activite, a.prestation, a.kilometrage,
              a.depense_cents, a.recette_cents, a.resultat_cents,
              COALESCE(t.libelle, a.type_code) AS type_libelle
         FROM activites a
         LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
        WHERE a.vehicule_id = $1 AND a.deleted_at IS NULL
          AND ($2::date IS NULL OR a.date_activite >= $2)
          AND a.date_activite <= $3
        ORDER BY a.date_activite DESC
        LIMIT 2000`,
      params,
    );

    const totaux = await one(
      `SELECT COALESCE(SUM(depense_cents),0)::bigint  AS d,
              COALESCE(SUM(recette_cents),0)::bigint  AS r,
              COALESCE(SUM(resultat_cents),0)::bigint AS s,
              COUNT(*)::int                           AS n
         FROM activites
        WHERE vehicule_id = $1 AND deleted_at IS NULL
          AND ($2::date IS NULL OR date_activite >= $2)
          AND date_activite <= $3`,
      params,
    );

    ctx.html(200, etatVehicule({ vehicule, activites, totaux, du, au, par: ctx.user.username }));
  },
  { permission: 'export.data', rateLimit: PROFILES.export },
);

/**
 * L'etat imprimable.
 *
 * Tout est en ligne — style compris — parce que ce document est fait pour
 * etre enregistre en PDF par le navigateur, puis classe. Il doit rester
 * lisible des annees apres, sans dependre d'une feuille de style servie par
 * une application qui aura change.
 */
function etatVehicule({ vehicule, activites, totaux, du, au, par }) {
  const e = escapeHtml;
  const montant = (c) => formatCents(Number(c), { withCurrency: true });

  const lignes = activites.map((a) => `
    <tr>
      <td>${e(formatDateFr(a.date_activite))}</td>
      <td>${e(a.type_libelle)}</td>
      <td>${e(a.prestation)}</td>
      <td class="n">${a.kilometrage != null ? e(String(a.kilometrage)) + ' km' : ''}</td>
      <td class="n">${a.depense_cents > 0 ? e(montant(a.depense_cents)) : ''}</td>
      <td class="n">${a.recette_cents > 0 ? e(montant(a.recette_cents)) : ''}</td>
      <td class="n ${Number(a.resultat_cents) < 0 ? 'neg' : 'pos'}">${e(montant(a.resultat_cents))}</td>
    </tr>`).join('');

  const echeances = vehicule.entretiens
    .filter((x) => x.etat.surveille)
    .map((x) => `<li><strong>${e(x.libelle)}</strong> — ${e(x.alerte?.detail ?? '')}</li>`)
    .join('') || '<li>Aucune échéance suivie.</li>';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${e(vehicule.nom)} — historique</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 12px/1.45 system-ui, "Segoe UI", sans-serif; color: #111; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .sous { color: #555; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; }
  th, td { border-bottom: 1px solid #ddd; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .neg { color: #b91c1c; } .pos { color: #15803d; }
  .cartes { display: flex; gap: 10px; margin: 12px 0; flex-wrap: wrap; }
  .carte { border: 1px solid #ddd; border-radius: 8px; padding: 8px 12px; min-width: 120px; }
  .carte b { display: block; font-size: 16px; }
  .carte span { color: #555; font-size: 11px; }
  ul { margin: 6px 0; padding-left: 18px; }
  footer { margin-top: 16px; color: #666; font-size: 10px; border-top: 1px solid #ddd; padding-top: 6px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<h1>${e(vehicule.nom)}</h1>
<div class="sous">
  ${e(vehicule.immatriculation)}${vehicule.marque ? ' · ' + e(vehicule.marque) : ''}${vehicule.modele ? ' ' + e(vehicule.modele) : ''}
  · compteur ${e(String(vehicule.kilometrage))} km · ${e(vehicule.statut)}
</div>

<div class="cartes">
  <div class="carte"><b>${e(String(totaux.n))}</b><span>activités</span></div>
  <div class="carte"><b>${e(montant(totaux.r))}</b><span>recettes</span></div>
  <div class="carte"><b>${e(montant(totaux.d))}</b><span>dépenses</span></div>
  <div class="carte"><b class="${Number(totaux.s) < 0 ? 'neg' : 'pos'}">${e(montant(totaux.s))}</b><span>résultat</span></div>
</div>

<h2 style="font-size:14px;margin:14px 0 0">Échéances suivies</h2>
<ul>${echeances}</ul>

<h2 style="font-size:14px;margin:14px 0 0">Activités${du ? ' du ' + e(formatDateFr(du)) : ''} au ${e(formatDateFr(au))}</h2>
<table>
  <thead><tr>
    <th>Date</th><th>Type</th><th>Prestation</th>
    <th class="n">Kilométrage</th><th class="n">Dépense</th><th class="n">Recette</th><th class="n">Résultat</th>
  </tr></thead>
  <tbody>${lignes || '<tr><td colspan="7">Aucune activité sur la période.</td></tr>'}</tbody>
</table>

<footer>
  Édité le ${e(formatDateFr(today()))} par ${e(par)}.
  Activité non déclarée : ces montants sont des dépenses réellement engagées et des recettes
  réellement perçues. Ils ne constituent pas une comptabilité officielle et ne comportent aucune TVA.
</footer>
<p class="noprint"><button onclick="window.print()">Imprimer / enregistrer en PDF</button></p>
</body></html>`;
}

/** Une phrase qui dit ce que contient le fichier, pour qui l'ouvrira plus tard. */
function decrireSelection(ctx) {
  const parts = [];
  const du = ctx.queryDate('du');
  const au = ctx.queryDate('au');
  if (du && au) parts.push('du ' + formatDateFr(du) + ' au ' + formatDateFr(au));
  else if (du) parts.push('à partir du ' + formatDateFr(du));
  else if (au) parts.push("jusqu'au " + formatDateFr(au));
  else parts.push('toutes périodes');

  if (ctx.queryUuid('vehicule')) parts.push('un véhicule');
  const types = (ctx.query('type') ?? '').trim();
  if (types) parts.push('types : ' + types.replace(/,/g, ', '));
  const q = ctx.query('q');
  if (q) parts.push('recherche « ' + q + ' »');

  return 'Sélection : ' + parts.join(' · ');
}
