/**
 * L'historique des activites (§18) et ses filtres (§19, §21).
 *
 * LES FILTRES SE COMBINENT, ET ILS VIVENT DANS L'ADRESSE.
 *
 * « Toutes les dépenses du Renault Master en septembre 2026 » est un
 * véhicule, plus une période, plus un sens : trois filtres a la fois (§21).
 * Ils sont ecrits dans le fragment d'adresse, ce qui a trois consequences
 * utiles — la page se recharge sans perdre la selection, le retour arriere
 * du navigateur fonctionne, et l'on peut envoyer le lien a quelqu'un.
 *
 * LES TOTAUX PORTENT SUR LE FILTRE, PAS SUR LA PAGE.
 *
 * C'est le serveur qui les calcule, sur l'ensemble de la selection. Les
 * additionner ici ne donnerait que le total des cinquante lignes affichees,
 * et l'on prendrait des decisions sur un chiffre faux.
 */
import {
  h, fill, api, etat, icone, montant, montantSigne, dateFr, km,
  etatVide, chargement, saisie, liste, signalerErreur, succes,
  demanderMotif, confirmer, aujourdhui, debutDuMois, modale, versCentimes, tuile, rangeeChiffres, champ,
} from '../core.js';
import { aller } from '../app.js';
import { galeriePieces } from './pieces.js';

/** Les periodes proposees en un toucher (§19). */
function periodes() {
  const jour = aujourdhui();
  const [a, m] = jour.split('-').map(Number);
  const dernierJour = (an, mois) => new Date(Date.UTC(an, mois, 0)).toISOString().slice(0, 10);
  const moisPrecedent = m === 1 ? { a: a - 1, m: 12 } : { a, m: m - 1 };
  const p = (n) => String(n).padStart(2, '0');

  return [
    { cle: 'jour', libelle: 'Aujourd’hui', du: jour, au: jour },
    { cle: 'semaine', libelle: '7 derniers jours', du: decaler(jour, -6), au: jour },
    { cle: 'mois', libelle: 'Ce mois', du: debutDuMois(), au: jour },
    {
      cle: 'mois-1',
      libelle: 'Mois précédent',
      du: moisPrecedent.a + '-' + p(moisPrecedent.m) + '-01',
      au: dernierJour(moisPrecedent.a, moisPrecedent.m),
    },
    { cle: 'annee', libelle: 'Cette année', du: a + '-01-01', au: jour },
    { cle: 'tout', libelle: 'Tout', du: '', au: '' },
  ];
}

const decaler = (iso, jours) => {
  const [a, m, j] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, j + jours)).toISOString().slice(0, 10);
};

const SENS = [
  { value: '', label: 'Tous les montants' },
  { value: 'DEPENSE', label: 'Avec dépense' },
  { value: 'RECETTE', label: 'Avec recette' },
  { value: 'GAIN', label: 'Résultat positif' },
  { value: 'PERTE', label: 'Résultat négatif' },
];

export async function rendre({ parametres }) {
  const racine = h('div', {});
  const corps = h('div', {}, chargement());

  // L'etat des filtres vient de l'adresse : recharger la page les conserve.
  const filtres = {
    vehicule: parametres.vehicule ?? '',
    du: parametres.du ?? debutDuMois(),
    au: parametres.au ?? aujourdhui(),
    type: parametres.type ?? '',
    sens: parametres.sens ?? '',
    q: parametres.q ?? '',
    corbeille: parametres.corbeille === '1',
    tri: parametres.tri ?? 'date',
    offset: Number(parametres.offset ?? 0),
  };

  const appliquer = (modif = {}) => {
    Object.assign(filtres, modif);
    if (!('offset' in modif)) filtres.offset = 0;
    const qs = {};
    for (const [k, v] of Object.entries(filtres)) {
      if (v === '' || v === false || v === 0) continue;
      qs[k] = v === true ? '1' : String(v);
    }
    aller('activites', qs);
  };

  /* --- Les controles --- */

  const vehicules = etat.meta?.vehicules ?? [];
  const types = etat.meta?.typesActivite ?? [];

  const champVehicule = liste(
    [{ value: '', label: 'Tous les véhicules' },
      ...vehicules.map((v) => ({ value: v.id, label: v.nom }))],
    filtres.vehicule,
    { onchange: (e) => appliquer({ vehicule: e.target.value }) },
  );

  const champType = liste(
    [{ value: '', label: 'Tous les types' },
      ...types.map((t) => ({ value: t.code, label: t.libelle }))],
    filtres.type,
    { onchange: (e) => appliquer({ type: e.target.value }) },
  );

  const champSens = liste(SENS, filtres.sens, {
    onchange: (e) => appliquer({ sens: e.target.value }),
  });

  const champDu = saisie({
    type: 'date', value: filtres.du,
    onchange: (e) => appliquer({ du: e.target.value }),
  });
  const champAu = saisie({
    type: 'date', value: filtres.au,
    onchange: (e) => appliquer({ au: e.target.value }),
  });

  const champQ = saisie({
    type: 'search', value: filtres.q, placeholder: 'Prestation, note, immatriculation…',
  });
  let minuteur = null;
  champQ.addEventListener('input', (e) => {
    // On attend que la frappe se calme : une requete par caractere ferait
    // trente appels pour « remorquage ».
    clearTimeout(minuteur);
    const valeur = e.target.value;
    minuteur = setTimeout(() => appliquer({ q: valeur }), 350);
  });

  const rangeePeriodes = h('div', { class: 'filtres-rapides' },
    ...periodes().map((p) => h('button', {
      type: 'button',
      class: 'bouton petit' + (p.du === filtres.du && p.au === filtres.au ? ' actif' : ''),
      onclick: () => appliquer({ du: p.du, au: p.au }),
    }, p.libelle)));

  /* --- Lecture --- */

  async function relire() {
    try {
      const donnees = await api.get('/api/activites', {
        vehicule: filtres.vehicule,
        du: filtres.du,
        au: filtres.au,
        type: filtres.type,
        sens: filtres.sens,
        q: filtres.q,
        corbeille: filtres.corbeille ? '1' : '',
        tri: filtres.tri,
        limit: 50,
        offset: filtres.offset,
      });
      fill(corps, peindre(donnees));
    } catch (err) {
      fill(corps, etatVide('Historique indisponible.'));
      signalerErreur(err, 'Lecture des activités');
    }
  }

  const peindre = ({ activites, totaux, pagination }) => h('div', {},
    // Les totaux portent sur toute la sélection, pas sur la page affichée.
    rangeeChiffres(
      tuile(String(totaux.nb), 'Activités'),
      tuile(montant(totaux.recettesCents, true), 'Recettes', 'succes'),
      tuile(montant(totaux.depensesCents, true), 'Dépenses', 'danger'),
      tuile(montantSigne(totaux.resultatCents), 'Résultat',
        totaux.resultatCents < 0 ? 'danger' : 'accent')),

    activites.length
      ? h('div', { class: 'carte' },
        h('div', { class: 'table-enveloppe' },
          h('table', { class: 'donnees' },
            h('thead', {}, h('tr', {},
              enTete('Date', 'date'),
              h('th', {}, 'Véhicule'),
              h('th', {}, 'Type'),
              h('th', {}, 'Prestation'),
              enTete('Kilométrage', 'kilometrage', true),
              enTete('Dépense', 'depense', true),
              enTete('Recette', 'recette', true),
              enTete('Résultat', 'resultat', true),
              h('th', {}, 'Pièces'),
              h('th', {}, ''))),
            h('tbody', {}, ...activites.map(ligne)))),
        pied(pagination))
      : etatVide(filtres.corbeille
        ? 'La corbeille est vide.'
        : 'Aucune activité sur cette sélection.'));

  /** Un en-tete cliquable : « triable » porte le curseur et le survol. */
  const enTete = (titre, cle, droite = false) => {
    const actif = filtres.tri === cle || filtres.tri === cle + '_asc';
    return h('th', {
      class: 'triable' + (droite ? ' num' : ''),
      onclick: () => appliquer({ tri: filtres.tri === cle ? cle + '_asc' : cle }),
      title: 'Trier par ' + titre.toLowerCase(),
    }, titre, actif ? h('span', { class: 'fleche' }, filtres.tri === cle ? ' ↓' : ' ↑') : null);
  };

  const ligne = (a) => h('tr', {},
    h('td', {}, dateFr(a.date)),
    h('td', {}, a.vehiculeNom),
    h('td', {}, a.typeLibelle),
    h('td', {},
      a.prestation,
      a.kilometrageForce
        ? h('small', { class: 'ligne-note' }, ' kilométrage confirmé manuellement')
        : null),
    h('td', { class: 'num' }, a.kilometrage != null ? km(a.kilometrage) : ''),
    h('td', { class: 'num' }, a.depenseCents ? montant(a.depenseCents) : ''),
    h('td', { class: 'num' }, a.recetteCents ? montant(a.recetteCents) : ''),
    h('td', { class: 'num ' + (a.resultatCents < 0 ? 'resultat-negatif' : 'resultat-positif') },
      montantSigne(a.resultatCents, false)),
    h('td', {}, a.nbPieces ? h('span', { class: 'pastille info' }, String(a.nbPieces)) : ''),
    h('td', {},
      h('div', { class: 'groupe-boutons' },
        h('button', { class: 'bouton petit', onclick: () => ouvrirDetail(a, relire), title: 'Détail' },
          icone('oeil')),
        !a.supprime && etat.peut('activity.delete')
          ? h('button', {
            class: 'bouton petit danger', title: 'Mettre à la corbeille',
            onclick: () => supprimer(a, relire),
          }, icone('corbeille'))
          : null,
        a.supprime && etat.peut('activity.delete')
          ? h('button', {
            class: 'bouton petit', title: 'Restaurer',
            onclick: () => restaurer(a, relire),
          }, 'Restaurer')
          : null)));

  const pied = (pagination) => h('div', { class: 'pagination' },
    h('span', { class: 'info' },
      pagination.total
        ? 'Lignes ' + (pagination.offset + 1) + ' à ' +
          Math.min(pagination.offset + pagination.limit, pagination.total) +
          ' sur ' + pagination.total
        : ''),
    h('div', { class: 'groupe-boutons' },
      h('button', {
        class: 'bouton petit',
        disabled: pagination.offset === 0,
        onclick: () => appliquer({ offset: Math.max(0, pagination.offset - pagination.limit) }),
      }, 'Précédent'),
      h('button', {
        class: 'bouton petit',
        disabled: pagination.offset + pagination.limit >= pagination.total,
        onclick: () => appliquer({ offset: pagination.offset + pagination.limit }),
      }, 'Suivant')));

  /* --- L'ecran --- */

  const parametresExport = new URLSearchParams();
  for (const [k, v] of Object.entries({
    vehicule: filtres.vehicule, du: filtres.du, au: filtres.au,
    type: filtres.type, sens: filtres.sens, q: filtres.q,
  })) if (v) parametresExport.set(k, v);

  fill(racine,
    h('div', { class: 'page-entete' },
      h('div', {},
        h('h1', {}, filtres.corbeille ? 'Corbeille' : 'Activités'),
        h('p', {}, 'Activité non déclarée : montants réellement engagés et perçus, sans TVA.')),
      h('div', { class: 'page-actions' },
        etat.peut('export.data')
          ? h('a', {
            class: 'bouton',
            href: '/api/exports/activites.xlsx?' + parametresExport.toString(),
          }, icone('telecharger'), h('span', {}, 'Excel'))
          : null,
        etat.peut('export.data')
          ? h('a', {
            class: 'bouton',
            href: '/api/exports/activites.csv?' + parametresExport.toString(),
          }, h('span', {}, 'CSV'))
          : null,
        etat.peut('activity.delete')
          ? h('button', {
            class: 'bouton' + (filtres.corbeille ? ' actif' : ''),
            onclick: () => appliquer({ corbeille: !filtres.corbeille }),
          }, icone('corbeille'), h('span', {}, 'Corbeille'))
          : null)),

    rangeePeriodes,
    // Chaque filtre est un « champ » étiqueté : c'est ce que la barre
    // attend pour les mettre en ligne, et c'est surtout ce qui dit à quoi
    // sert chaque liste déroulante sans avoir à l'ouvrir.
    h('div', { class: 'carte' },
      h('div', { class: 'filtres' },
        champ('Véhicule', champVehicule),
        champ('Type', champType),
        champ('Montants', champSens),
        champ('Du', champDu),
        champ('Au', champAu),
        champ('Rechercher', champQ, { large: true }))),
    corps);

  relire();
  return racine;
}

/* ------------------------------------------------------------------ */

async function ouvrirDetail(a, apres) {
  let donnees;
  try {
    donnees = await api.get('/api/activites/' + a.id);
  } catch (err) { signalerErreur(err, 'Lecture impossible'); return; }

  const act = donnees.activite;
  const m = modale({
    titre: act.prestation,
    sousTitre: dateFr(act.date) + ' · ' + act.vehiculeNom + ' · ' + act.typeLibelle,
    contenu: h('div', {},
      h('dl', { class: 'definitions' },
        h('dt', {}, 'Kilométrage'), h('dd', {}, act.kilometrage != null ? km(act.kilometrage) : '—'),
        h('dt', {}, 'Dépense'), h('dd', {}, montant(act.depenseCents, true)),
        h('dt', {}, 'Recette'), h('dd', {}, montant(act.recetteCents, true)),
        h('dt', {}, 'Résultat'),
        h('dd', { class: act.resultatCents < 0 ? 'resultat-negatif' : 'resultat-positif' },
          montantSigne(act.resultatCents)),
        act.notes ? h('dt', {}, 'Notes') : null,
        act.notes ? h('dd', {}, act.notes) : null,
        act.supprime ? h('dt', {}, 'Corbeille') : null,
        act.supprime ? h('dd', {}, 'Depuis le ' + dateFr(act.supprimeLe) +
          (act.motifSuppression ? ' — ' + act.motifSuppression : '')) : null),
      h('h3', { style: { marginTop: '16px' } }, 'Pièces jointes'),
      etat.peut('attachment.view')
        ? galeriePieces('activite', act.id, { modifiable: !act.supprime })
        : h('p', { class: 'ligne-note' }, 'Vous n’avez pas accès aux pièces jointes.')),
    actions: [
      h('button', { class: 'bouton', onclick: () => m.fermer() }, 'Fermer'),
      !act.supprime && etat.peut('activity.edit')
        ? h('button', {
          class: 'bouton principal',
          onclick: async () => { m.fermer(); await ouvrirModification(act, apres); },
        }, 'Modifier')
        : null,
    ].filter(Boolean),
  });
}

/**
 * La modification (§28).
 *
 * Elle ne recalcule rien a la main : le kilometrage du vehicule et les
 * statistiques se deduisent des activites vivantes, donc corriger celle-ci
 * corrige tout le reste sans une ligne de code de reprise.
 */
async function ouvrirModification(act, apres) {
  const champPrestation = saisie({ maxlength: 200, value: act.prestation });
  const champDate = saisie({ type: 'date', value: String(act.date).slice(0, 10), max: aujourdhui() });
  const champKm = saisie({ type: 'number', min: 0, max: 3000000, value: act.kilometrage ?? '' });
  const champDepense = saisie({ inputmode: 'decimal', value: (act.depenseCents / 100).toFixed(2) });
  const champRecette = saisie({ inputmode: 'decimal', value: (act.recetteCents / 100).toFixed(2) });
  const avis = h('p', { class: 'ligne-note', role: 'alert' });

  const enregistrer = async (confirmerKilometrage = false) => {
    fill(avis, '');
    const d = versCentimes(champDepense.value);
    const r = versCentimes(champRecette.value);
    if (d === null || r === null) { fill(avis, 'Un montant ne se lit pas.'); return; }

    try {
      await api.patch('/api/activites/' + act.id, {
        prestation: champPrestation.value.trim(),
        date: champDate.value,
        kilometrage: champKm.value === '' ? null : Number(champKm.value),
        depenseCents: d,
        recetteCents: r,
        confirmerKilometrage,
      });
      succes('Activité modifiée', champPrestation.value.trim());
      m.fermer();
      apres?.();
    } catch (err) {
      if (err.statut === 409 && String(err.code || '').startsWith('KILOMETRAGE_')) {
        const ok = await confirmer({
          titre: 'Kilométrage à confirmer',
          message: err.message,
          libelleConfirmation: 'Confirmer ce kilométrage',
        });
        if (ok) await enregistrer(true);
        return;
      }
      fill(avis, err?.message || 'Modification impossible.');
    }
  };

  const m = modale({
    titre: 'Modifier l’activité',
    contenu: h('div', {},
      h('label', { class: 'champ large' }, h('span', {}, 'Prestation'), champPrestation),
      h('div', { class: 'ligne-champs' },
        h('label', { class: 'champ' }, h('span', {}, 'Date'), champDate),
        h('label', { class: 'champ' }, h('span', {}, 'Kilométrage'), champKm)),
      h('div', { class: 'ligne-champs' },
        h('label', { class: 'champ' }, h('span', {}, 'Dépense (DH)'), champDepense),
        h('label', { class: 'champ' }, h('span', {}, 'Recette (DH)'), champRecette)),
      avis),
    actions: [
      h('button', { class: 'bouton', onclick: () => m.fermer() }, 'Annuler'),
      h('button', { class: 'bouton principal', onclick: () => enregistrer(false) }, 'Enregistrer'),
    ],
  });
}

async function supprimer(a, apres) {
  const motif = await demanderMotif({
    titre: 'Mettre à la corbeille ?',
    message: '« ' + a.prestation + ' » sortira de l’historique et des totaux. ' +
      'Elle reste restaurable, et le kilométrage du véhicule se recalcule aussitôt.',
    libelleConfirmation: 'Mettre à la corbeille',
  });
  if (!motif) return;
  try {
    await api.delete('/api/activites/' + a.id, { motif });
    succes('Activité mise à la corbeille', a.prestation);
    apres?.();
  } catch (err) { signalerErreur(err, 'Suppression impossible'); }
}

async function restaurer(a, apres) {
  try {
    await api.post('/api/activites/' + a.id + '/restaurer', {});
    succes('Activité restaurée', a.prestation);
    apres?.();
  } catch (err) { signalerErreur(err, 'Restauration impossible'); }
}

