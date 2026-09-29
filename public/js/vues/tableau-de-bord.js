/**
 * Le tableau de bord (§16, §38).
 *
 * L'ORDRE DES BLOCS EST L'ORDRE DU §38, et il compte : sur telephone, on
 * lit ce qui vient en premier. Les alertes urgentes ouvrent l'ecran, les
 * chiffres du mois suivent, puis la flotte, puis les dernieres activites.
 * Mettre les chiffres en tete aurait ete plus flatteur et moins utile : on
 * ouvre cette application pour savoir ce qui presse.
 *
 * Un seul appel reseau alimente tout l'ecran (§33).
 */
import {
  h, fill, api, etat, icone, montant, montantSigne, dateFr, km,
  etatVide, pastilleNiveau, debutDuMois, aujourdhui, tuile, rangeeChiffres,
} from '../core.js';
import { aller } from '../app.js';

export async function rendre() {
  const donnees = await api.get('/api/tableau-de-bord', {
    du: debutDuMois(),
    au: aujourdhui(),
  });

  const { chiffres, flotte, alertes, compteurs, activitesRecentes, periode } = donnees;

  return h('div', {},
    h('div', { class: 'page-entete' },
      h('div', {},
        h('h1', {}, 'Tableau de bord'),
        h('p', {}, 'Du ' + dateFr(periode.du) + ' au ' + dateFr(periode.au))),
      h('div', { class: 'page-actions' },
        etat.peut('stats.view')
          ? h('button', { class: 'bouton', onclick: () => aller('statistiques') },
            icone('rapport'), h('span', {}, 'Statistiques'))
          : null)),

    blocAlertes(alertes, compteurs),
    blocChiffres(chiffres),
    blocFlotte(flotte),
    blocActivites(activitesRecentes),
  );
}

/* ------------------------------------------------------------------ */

function blocAlertes(alertes, compteurs) {
  const pressantes = alertes.filter((a) => a.niveau === 'DEPASSE' || a.niveau === 'URGENT');
  const proches = alertes.filter((a) => a.niveau === 'ATTENTION');

  if (!alertes.length) {
    return h('section', { class: 'carte' },
      h('div', { class: 'carte-entete' }, h('h2', {}, 'Échéances')),
      h('div', { class: 'carte-corps' },
        h('p', { class: 'ligne-note' },
          compteurs.NORMAL
            ? compteurs.NORMAL + ' échéance(s) suivie(s), aucune ne presse.'
            : 'Aucune échéance suivie. Ajoutez-en depuis la fiche d’un véhicule.')));
  }

  const ligne = (a) => h('button', {
    type: 'button',
    class: 'echeance niveau-' + a.niveau,
    style: { width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' },
    onclick: () => aller('vehicules/' + a.vehiculeId),
  },
  h('div', { class: 'echeance-tete' },
    h('span', { class: 'echeance-titre' }, a.libelle + ' — ' + a.vehiculeNom),
    pastilleNiveau(a.niveau)),
  h('span', { class: 'echeance-detail' }, a.detail || ''));

  return h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' },
      h('h2', {}, icone('alerte'), h('span', {}, ' Échéances à traiter')),
      h('span', { class: 'pastille ' + (compteurs.DEPASSE ? 'danger' : 'attente') },
        alertes.length + ' à surveiller')),
    h('div', { class: 'carte-corps' },
      ...pressantes.map(ligne),
      ...proches.map(ligne)));
}

/* ------------------------------------------------------------------ */

function blocChiffres(c) {
  return rangeeChiffres(
    tuile(montant(c.recettesCents, true), 'Recettes du mois', 'succes'),
    tuile(montant(c.depensesCents, true), 'Dépenses du mois', 'danger'),
    tuile(montantSigne(c.resultatCents), 'Résultat', c.resultatCents < 0 ? 'danger' : 'accent'),
    tuile(String(c.nbActivites), 'Activités', 'info'));
}

/* ------------------------------------------------------------------ */

function blocFlotte(flotte) {
  if (!flotte.nbVehicules) {
    return h('section', { class: 'carte' },
      h('div', { class: 'carte-corps' },
        etatVide(
          'Aucun véhicule. Commencez par en créer un : tout le reste s’y rattache.',
          etat.peut('vehicle.create')
            ? h('button', { class: 'bouton principal', onclick: () => aller('vehicules') },
              'Créer un véhicule')
            : null)));
  }

  return h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' },
      h('h2', {}, flotte.nbVehicules + ' véhicule(s)'),
      h('button', { class: 'bouton petit', onclick: () => aller('vehicules') }, 'Tout voir')),
    h('div', { class: 'carte-corps' },
      h('div', { class: 'grille c3' },
        ...flotte.vehicules.map((v) => h('button', {
          type: 'button',
          class: 'carte niveau-' + v.niveau,
          style: { textAlign: 'left', cursor: 'pointer' },
          onclick: () => aller('vehicules/' + v.id),
        },
        h('div', { class: 'carte-corps' },
          h('div', { class: 'echeance-tete' },
            h('strong', {}, v.nom),
            pastilleNiveau(v.niveau)),
          h('p', { class: 'ligne-note' }, v.immatriculation + ' · ' + km(v.kilometrage)),
          v.prochaineEcheance
            ? h('p', { class: 'echeance-detail' },
              v.prochaineEcheance.libelle + ' : ' + (v.prochaineEcheance.detail || ''))
            : h('p', { class: 'ligne-note' }, 'Aucune échéance suivie.')))))));
}

/* ------------------------------------------------------------------ */

function blocActivites(activites) {
  if (!activites.length) {
    return h('section', { class: 'carte' },
      h('div', { class: 'carte-entete' }, h('h2', {}, 'Dernières activités')),
      h('div', { class: 'carte-corps' },
        h('p', { class: 'ligne-note' },
          'Rien d’enregistré pour l’instant. Le bouton « Nouvelle activité » est en bas à droite.')));
  }

  return h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' },
      h('h2', {}, 'Dernières activités'),
      etat.peut('activity.view')
        ? h('button', { class: 'bouton petit', onclick: () => aller('activites') }, 'Tout voir')
        : null),
    h('div', { class: 'carte-corps' },
      h('div', { class: 'chronologie' },
        ...activites.map((a) => h('div', {
          class: 'chrono-entree ' + (a.resultatCents < 0 ? 'warning' : 'notice'),
        },
        h('div', { class: 'quand' }, dateFr(a.date) + ' · ' + a.vehiculeNom),
        h('div', { class: 'quoi' },
          a.prestation,
          a.kilometrage != null ? ' — ' + km(a.kilometrage) : '',
          ' — ',
          h('span', { class: a.resultatCents < 0 ? 'resultat-negatif' : 'resultat-positif' },
            montantSigne(a.resultatCents))),
        h('div', { class: 'qui' }, a.typeLibelle))))));
}

