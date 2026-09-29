/**
 * Les vehicules : la liste (§37) et la fiche dediee (§17).
 *
 * LA LISTE DOIT SE LIRE EN QUELQUES SECONDES.
 *
 * C'est l'exigence du §44, et elle exclut le tableau de douze colonnes. Une
 * carte par vehicule : son nom, son compteur, sa prochaine echeance, et un
 * lisere de couleur qui dit son etat. Ce qui ne tient pas en trois lignes
 * appartient a la fiche.
 */
import {
  h, donnee, donneeIsolee, texteEcheance, fill, api, etat, icone, montant, montantSigne, dateFr, km, entier,
  etatVide, pastilleNiveau, chargement, modale, champ, saisie, liste, zoneTexte,
  signalerErreur, succes, demanderMotif, confirmer, tuile, rangeeChiffres,
} from '../core.js';
import { aller } from '../app.js';
import { galeriePieces } from './pieces.js';
import { ouvrirFormulaireActivite } from './activite-formulaire.js';
import { ouvrirFormulaireEntretien } from './entretiens.js';

const STATUTS = [
  { value: 'DISPONIBLE', label: 'Disponible' },
  { value: 'EN_SERVICE', label: 'En service' },
  { value: 'MAINTENANCE', label: 'En maintenance' },
  { value: 'IMMOBILISE', label: 'Immobilisé' },
  { value: 'VENDU', label: 'Vendu' },
];

const libelleStatut = (code) => STATUTS.find((s) => s.value === code)?.label ?? code;

export async function rendre({ segments }) {
  return segments.length ? fiche(segments[0]) : listeVehicules();
}

/* ================================================================== */
/*  La liste                                                           */
/* ================================================================== */

async function listeVehicules() {
  const racine = h('div', {});
  const corps = h('div', {}, chargement());
  let avecArchives = false;
  let recherche = '';

  const champRecherche = saisie({
    type: 'search',
    placeholder: 'Immatriculation, marque, modèle…',
    oninput: (e) => { recherche = e.target.value; relire(); },
  });

  async function relire() {
    try {
      const { vehicules } = await api.get('/api/vehicules', {
        archives: avecArchives ? '1' : '',
        q: recherche,
      });
      fill(corps, peindre(vehicules));
    } catch (err) {
      fill(corps, etatVide('Liste indisponible.'));
      signalerErreur(err, 'Lecture des véhicules');
    }
  }

  const peindre = (vehicules) => {
    if (!vehicules.length) {
      return etatVide(
        recherche ? 'Aucun véhicule ne correspond à « ' + recherche + ' ».' : 'Aucun véhicule.',
        etat.peut('vehicle.create') && !recherche
          ? h('button', { class: 'bouton principal', onclick: () => formulaireVehicule(null, relire) },
            'Créer le premier véhicule')
          : null);
    }
    return h('div', { class: 'grille c3' }, ...vehicules.map(carte));
  };

  const carte = (v) => h('button', {
    type: 'button',
    class: 'carte niveau-' + v.niveau,
    style: { textAlign: 'left', cursor: 'pointer' },
    onclick: () => aller('vehicules/' + v.id),
  },
  h('div', { class: 'carte-corps' },
    h('div', { class: 'echeance-tete' },
      h('strong', {}, donneeIsolee(v.nom)),
      v.archive ? h('span', { class: 'pastille' }, 'Archivé') : pastilleNiveau(v.niveau)),
    h('p', { class: 'ligne-note' },
      donneeIsolee(v.immatriculation +
        (v.marque ? ' · ' + v.marque : '') + (v.modele ? ' ' + v.modele : '')),
      ' · ', libelleStatut(v.statut)),
    h('p', {}, icone('compteur'), h('span', {}, donneeIsolee(' ' + km(v.kilometrage)))),
    v.prochaineEcheance
      ? h('p', { class: 'echeance-detail' },
        donneeIsolee(v.prochaineEcheance.libelle), ' : ',
        texteEcheance(v.prochaineEcheance.etat) ?? donneeIsolee(v.prochaineEcheance.detail || ''))
      : h('p', { class: 'ligne-note' }, 'Aucune échéance suivie.')));

  fill(racine,
    h('div', { class: 'page-entete' },
      h('div', {}, h('h1', {}, 'Véhicules')),
      h('div', { class: 'page-actions' },
        etat.peut('vehicle.create')
          ? h('button', { class: 'bouton principal', onclick: () => formulaireVehicule(null, relire) },
            icone('plus'), h('span', {}, 'Nouveau véhicule'))
          : null)),
    h('div', { class: 'carte' },
      h('div', { class: 'filtres' },
        champ('Rechercher', champRecherche, { large: true }),
        h('label', { class: 'case' },
          h('input', {
            type: 'checkbox',
            onchange: (e) => { avecArchives = e.target.checked; relire(); },
          }),
          h('span', {}, 'Afficher les archivés')))),
    corps);

  relire();
  return racine;
}

/* ================================================================== */
/*  La fiche (§17)                                                     */
/* ================================================================== */

async function fiche(id) {
  const racine = h('div', {}, chargement());

  async function relire() {
    let donnees;
    try {
      donnees = await api.get('/api/vehicules/' + id);
    } catch (err) {
      fill(racine, etatVide(err?.message || 'Ce véhicule est introuvable.'));
      return;
    }
    const { vehicule: v, activites, statistiques: s, pagination } = donnees;

    fill(racine,
      h('div', { class: 'page-entete' },
        h('div', {},
          h('button', { class: 'bouton sourdine petit', onclick: () => aller('vehicules') },
            icone('retour'), h('span', {}, 'Véhicules')),
          h('h1', {}, donneeIsolee(v.nom)),
          h('p', {},
            donneeIsolee(v.immatriculation +
              (v.marque ? ' · ' + v.marque : '') + (v.modele ? ' ' + v.modele : '') +
              (v.annee ? ' · ' + v.annee : '')),
            ' · ', libelleStatut(v.statut),
            v.archive ? ' · archivé' : '')),
        h('div', { class: 'page-actions' },
          etat.peut('activity.create') && !v.archive
            ? h('button', {
              class: 'bouton principal',
              onclick: async () => {
                const creee = await ouvrirFormulaireActivite({ vehiculeId: v.id });
                if (creee) { succes('Activité enregistrée', creee.prestation); relire(); }
              },
            }, icone('plus'), h('span', {}, 'Activité'))
            : null,
          etat.peut('export.data')
            ? h('a', {
              class: 'bouton', href: '/api/exports/vehicule/' + v.id, target: '_blank', rel: 'noopener',
            }, icone('imprimer'), h('span', {}, 'État imprimable'))
            : null,
          etat.peut('vehicle.edit')
            ? h('button', { class: 'bouton', onclick: () => formulaireVehicule(v, relire) },
              icone('crayon'), h('span', {}, 'Modifier'))
            : null,
          etat.peut('vehicle.archive')
            ? h('button', {
              class: 'bouton ' + (v.archive ? '' : 'danger'),
              onclick: () => (v.archive ? reactiver(v, relire) : archiver(v, relire)),
            }, v.archive ? 'Réactiver' : 'Archiver')
            : null)),

      // Les chiffres du vehicule (§17).
      rangeeChiffres(
        tuile(km(v.kilometrage), 'Compteur', 'info'),
        tuile(montant(s.recettesCents, true), 'Recettes', 'succes'),
        tuile(montant(s.depensesCents, true), 'Dépenses', 'danger'),
        tuile(montantSigne(s.resultatCents), 'Résultat', s.resultatCents < 0 ? 'danger' : 'accent'),
        tuile(String(s.nbActivites), 'Activités'),
        tuile(s.kilometresParcourus != null ? km(s.kilometresParcourus) : '—', 'Parcourus')),

      blocEcheances(v, relire),
      blocTimeline(activites, pagination),
      blocPieces(v),
      v.notes ? h('section', { class: 'carte' },
        h('div', { class: 'carte-entete' }, h('h2', {}, 'Notes')),
        h('div', { class: 'carte-corps' }, h('p', {}, donnee(v.notes)))) : null);
  }

  relire();
  return racine;
}

/* ------------------------------------------------------------------ */

function blocEcheances(v, relire) {
  const entretiens = v.entretiens ?? [];

  return h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' },
      h('h2', {}, 'Entretiens et échéances'),
      etat.peut('maintenance.create') && !v.archive
        ? h('button', {
          class: 'bouton petit',
          onclick: async () => {
            const cree = await ouvrirFormulaireEntretien({ vehicule: v });
            if (cree) relire();
          },
        }, icone('plus'), h('span', {}, 'Échéance'))
        : null),
    h('div', { class: 'carte-corps' },
      entretiens.length
        ? h('div', {}, ...entretiens.map((e) => ligneEcheance(e, v, relire)))
        : h('p', { class: 'ligne-note' },
          'Aucune échéance. Ajoutez-en une pour être prévenu avant la prochaine vidange ' +
          'ou la fin de l’assurance.')));
}

/**
 * Une echeance, avec sa barre de progression.
 *
 * La barre se remplit a mesure qu'on approche : elle est a zero quand
 * l'echeance est loin, pleine quand elle est atteinte. Elle se calcule sur
 * l'axe le plus avance des deux, et sur le seuil « attention » comme
 * echelle — au-dela, il n'y a rien a montrer.
 */
function ligneEcheance(e, v, relire) {
  const seuils = etat.seuils ?? { kmAttention: 2000, joursAttention: 30 };
  const parts = [];
  if (e.etat.km) parts.push(1 - Math.min(1, Math.max(0, e.etat.km.restant) / Math.max(seuils.kmAttention, 1)));
  if (e.etat.date) parts.push(1 - Math.min(1, Math.max(0, e.etat.date.restant) / Math.max(seuils.joursAttention, 1)));
  const avancement = parts.length ? Math.max(...parts) : 0;

  return h('div', { class: 'echeance niveau-' + e.etat.niveau },
    h('div', { class: 'echeance-tete' },
      h('span', { class: 'echeance-titre' }, donneeIsolee(e.libelle)),
      h('span', {},
        pastilleNiveau(e.etat.niveau),
        etat.peut('maintenance.close') && !v.archive && e.etat.surveille
          ? h('button', {
            class: 'bouton petit',
            style: { marginLeft: '8px' },
            onclick: async () => {
              const { ouvrirClotureEntretien } = await import('./entretiens.js');
              const fait = await ouvrirClotureEntretien(e, v);
              if (fait) relire();
            },
          }, 'Effectué')
          : null)),
    h('span', { class: 'echeance-detail' },
      texteEcheance(e.etat) ?? 'Pas d’échéance exploitable.',
      e.derniereDate ? h('span', {}, ' · dernière fois le ', donnee(dateFr(e.derniereDate))) : '',
      e.dernierKm != null ? donnee(' à ' + entier(e.dernierKm) + ' km') : ''),
    e.etat.surveille
      ? h('div', { class: 'echeance-piste' },
        h('div', { class: 'echeance-remplissage', style: { width: Math.round(avancement * 100) + '%' } }))
      : null);
}

/* ------------------------------------------------------------------ */

function blocTimeline(activites, pagination) {
  return h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' },
      h('h2', {}, 'Activité récente'),
      h('span', { class: 'ligne-note' }, pagination.total + ' au total')),
    h('div', { class: 'carte-corps' },
      activites.length
        ? h('div', { class: 'chronologie' }, ...activites.map((a) =>
          h('div', { class: 'chrono-entree ' + (a.resultatCents < 0 ? 'warning' : 'notice') },
            h('div', { class: 'quand' },
              donneeIsolee(dateFr(a.date) + ' · ' + a.typeLibelle),
              a.nbPieces ? ' · ' + a.nbPieces + ' pièce(s)' : ''),
            h('div', { class: 'quoi' },
              donneeIsolee(a.prestation),
              a.kilometrage != null ? donneeIsolee(' — ' + km(a.kilometrage)) : '',
              ' — ',
              h('span', { class: a.resultatCents < 0 ? 'resultat-negatif' : 'resultat-positif' },
                montantSigne(a.resultatCents))),
            a.kilometrageForce
              ? h('div', { class: 'qui' }, 'Kilométrage confirmé malgré un avertissement')
              : null)))
        : h('p', { class: 'ligne-note' }, 'Aucune activité enregistrée pour ce véhicule.')));
}

function blocPieces(v) {
  if (!etat.peut('attachment.view')) return null;
  return h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' }, h('h2', {}, 'Documents du véhicule')),
    h('div', { class: 'carte-corps' }, galeriePieces('vehicule', v.id)));
}

/* ================================================================== */
/*  Creation et modification                                           */
/* ================================================================== */

function formulaireVehicule(existant, apres) {
  const champImmat = saisie({ maxlength: 20, required: true, value: existant?.immatriculation ?? '' });
  const champLibelle = saisie({ maxlength: 60, value: existant?.libelle ?? '', placeholder: 'Renault Master' });
  const champMarque = saisie({ maxlength: 60, value: existant?.marque ?? '' });
  const champModele = saisie({ maxlength: 60, value: existant?.modele ?? '' });
  const champAnnee = saisie({ type: 'number', min: 1950, max: 2100, value: existant?.annee ?? '' });
  const champStatut = liste(STATUTS, existant?.statut ?? 'DISPONIBLE');
  const champKm = saisie({
    type: 'number', min: 0, max: 3000000,
    value: existant?.kilometrageInitial ?? 0,
  });
  const champNotes = zoneTexte({ rows: 2, maxlength: 4000, value: existant?.notes ?? '' });
  const avis = h('p', { class: 'ligne-note', role: 'alert' });

  const enregistrer = async () => {
    fill(avis, '');
    const corps = {
      immatriculation: champImmat.value.trim(),
      libelle: champLibelle.value.trim() || undefined,
      marque: champMarque.value.trim() || undefined,
      modele: champModele.value.trim() || undefined,
      annee: champAnnee.value === '' ? undefined : Number(champAnnee.value),
      statut: champStatut.value,
      kilometrageInitial: champKm.value === '' ? 0 : Number(champKm.value),
      notes: champNotes.value.trim() || undefined,
    };
    try {
      if (existant) await api.patch('/api/vehicules/' + existant.id, corps);
      else await api.post('/api/vehicules', corps);
      succes(existant ? 'Véhicule modifié' : 'Véhicule créé', corps.libelle || corps.immatriculation);
      m.fermer();
      apres?.();
    } catch (err) {
      fill(avis, err?.message || 'Enregistrement impossible.');
      signalerErreur(err, 'Enregistrement impossible');
    }
  };

  const m = modale({
    titre: existant ? 'Modifier le véhicule' : 'Nouveau véhicule',
    contenu: h('div', {},
      champ('Immatriculation', champImmat, { large: true }),
      champ('Nom d’usage', champLibelle, { large: true, aide: 'Facultatif — « Ambulance 1 », « Le Master ».' }),
      h('div', { class: 'ligne-champs' }, champ('Marque', champMarque), champ('Modèle', champModele)),
      h('div', { class: 'ligne-champs' }, champ('Année', champAnnee), champ('Statut', champStatut)),
      champ('Kilométrage au compteur', champKm, {
        large: true,
        aide: existant
          ? 'Le relevé de départ. Ensuite, ce sont les activités qui font avancer le compteur.'
          : 'Le relevé d’aujourd’hui. Ensuite, ce sont les activités qui le font avancer.',
      }),
      champ('Notes', champNotes, { large: true }),
      avis),
    actions: [
      h('button', { class: 'bouton', onclick: () => m.fermer() }, 'Annuler'),
      h('button', { class: 'bouton principal', onclick: enregistrer }, 'Enregistrer'),
    ],
  });
}

async function archiver(v, apres) {
  const motif = await demanderMotif({
    titre: 'Archiver ' + v.nom + ' ?',
    message: 'Le véhicule sortira des écrans de saisie. Son historique — activités, ' +
      'entretiens, pièces — est conservé et reste consultable.',
    libelleConfirmation: 'Archiver',
  });
  if (!motif) return;
  try {
    await api.post('/api/vehicules/' + v.id + '/archiver', { motif });
    succes('Véhicule archivé', v.nom);
    apres?.();
  } catch (err) { signalerErreur(err, 'Archivage impossible'); }
}

async function reactiver(v, apres) {
  const ok = await confirmer({
    titre: 'Réactiver ' + v.nom + ' ?',
    message: 'Il réapparaîtra dans les écrans de saisie.',
    libelleConfirmation: 'Réactiver',
  });
  if (!ok) return;
  try {
    await api.post('/api/vehicules/' + v.id + '/reactiver', {});
    succes('Véhicule réactivé', v.nom);
    apres?.();
  } catch (err) { signalerErreur(err, 'Réactivation impossible'); }
}

