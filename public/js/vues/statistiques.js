/**
 * Les statistiques (§20, §21).
 *
 * Trois lectures de la meme selection : par periode, par vehicule, par type.
 * Les filtres se combinent, et le serveur fait toutes les sommes — l'ecran
 * ne recalcule rien, sinon les deux finiraient par ne plus dire la meme
 * chose.
 *
 * LES BARRES SE COMPARENT ENTRE ELLES, PAS A UN ABSOLU.
 *
 * Chaque barre est rapportee au plus grand resultat de la liste, en valeur
 * absolue : c'est ce qui rend « Remorquage 2 300 DH » lisible a cote de
 * « Entretien -900 DH ». Une echelle fixe aurait ecrase toutes les lignes
 * des qu'une seule est grosse.
 */
import {
  h, donnee, fill, api, etat, icone, montant, montantSigne, dateFr,
  etatVide, chargement, saisie, liste, signalerErreur, aujourdhui, km, tuile, rangeeChiffres, champ,
} from '../core.js';
import { t } from '../i18n.js';
import { aller } from '../app.js';

export async function rendre({ parametres }) {
  const racine = h('div', {});
  const corps = h('div', {}, chargement());

  const debutAnnee = aujourdhui().slice(0, 4) + '-01-01';
  const filtres = {
    du: parametres.du ?? debutAnnee,
    au: parametres.au ?? aujourdhui(),
    vehicule: parametres.vehicule ?? '',
    type: parametres.type ?? '',
    // « Combien j'ai dépensé cette semaine » et « combien ce mois-ci » sont
    // deux questions différentes : la seconde ne répond pas à la première.
    granularite: parametres.granularite === 'semaine' ? 'semaine' : 'mois',
  };

  const appliquer = (modif) => {
    Object.assign(filtres, modif);
    const qs = {};
    for (const [k, v] of Object.entries(filtres)) if (v) qs[k] = v;
    aller('statistiques', qs);
  };

  async function relire() {
    try {
      fill(corps, peindre(await api.get('/api/statistiques', filtres)));
    } catch (err) {
      fill(corps, etatVide(err?.message || 'Statistiques indisponibles.'));
      signalerErreur(err, 'Lecture des statistiques');
    }
  }

  const peindre = ({ total, parVehicule, parType, parPeriode, granularite, periode }) => h('div', {},
    rangeeChiffres(
      tuile(String(total.nbActivites), 'Activités'),
      tuile(montant(total.recettesCents, true), 'Recettes', 'succes'),
      tuile(montant(total.depensesCents, true), 'Dépenses', 'danger'),
      tuile(montantSigne(total.resultatCents), 'Résultat',
        total.resultatCents < 0 ? 'danger' : 'accent')),

    total.nbActivites === 0
      ? etatVide('Aucune activité sur cette période.')
      : h('div', {},
        blocClassement('Par véhicule', parVehicule.map((v) => ({
          libelle: v.nom,
          secondaire: v.nbActivites + ' activité(s)' +
            (v.kilometresParcourus != null ? ' · ' + km(v.kilometresParcourus) : ''),
          valeur: v.resultatCents,
          surClic: () => aller('vehicules/' + v.id),
        }))),
        blocClassement('Par type d’activité', parType.map((t) => ({
          libelle: t.libelle,
          secondaire: t.nbActivites + ' activité(s)',
          valeur: t.resultatCents,
          surClic: () => aller('activites', { type: t.code, du: filtres.du, au: filtres.au }),
        }))),
        blocPeriodes(parPeriode, granularite),
        blocDetail(parVehicule, periode)));

  /* --- Un classement en barres --- */

  const blocClassement = (titre, lignes) => {
    if (!lignes.length) return null;
    const maxi = Math.max(...lignes.map((l) => Math.abs(l.valeur)), 1);

    return h('section', { class: 'carte' },
      h('div', { class: 'carte-entete' }, h('h2', {}, titre)),
      h('div', { class: 'carte-corps' },
        h('div', { class: 'classement' }, ...lignes.map((l) => h('div', { class: 'classement-ligne' },
          h('button', {
            class: 'classement-libelle bouton sourdine petit',
            style: { textAlign: 'left' },
            onclick: l.surClic,
            title: 'Voir le détail',
          }, donnee(l.libelle)),
          h('div', { class: 'classement-piste' },
            h('div', {
              class: 'classement-remplissage',
              style: {
                width: Math.round((Math.abs(l.valeur) / maxi) * 100) + '%',
                background: l.valeur < 0 ? 'var(--danger)' : 'var(--succes)',
              },
            })),
          h('div', { class: 'classement-valeur' },
            h('div', { class: l.valeur < 0 ? 'resultat-negatif' : 'resultat-positif' },
              montantSigne(l.valeur)),
            h('div', { class: 'secondaire' }, donnee(l.secondaire))))))));
  };

  /* --- La serie mensuelle, en colonnes --- */

  /**
   * La série mensuelle, en colonnes.
   *
   * La structure n'est pas libre : « graphe-colonnes » est positionné en
   * absolu et ne tient que s'il est posé dans « graphe-zone », qui lui
   * donne sa hauteur. Sorti de là, il s'échappe et les barres couvrent la
   * page entière — ce qui s'est produit avant que cette structure soit
   * respectée. Les étiquettes vivent SOUS la zone, pas dans les colonnes.
   */
  const blocPeriodes = (periodes, granularite) => {
    if (periodes.length < 2) return null;
    const maxi = Math.max(...periodes.map((m) => Math.max(m.recettesCents, m.depensesCents)), 1);
    const hauteur = (cents) => Math.max(2, Math.round((cents / maxi) * 100)) + '%';

    const graduations = [1, 0.5, 0].map((part) => h('span', {
      class: 'graphe-graduation',
      style: { bottom: Math.round(part * 100) + '%' },
    }, montant(Math.round(maxi * part))));

    return h('section', { class: 'carte' },
      h('div', { class: 'carte-entete' },
        h('h2', {}, granularite === 'semaine' ? 'Semaine par semaine' : 'Mois par mois'),
        h('div', { class: 'graphe-legende' },
          h('span', { class: 'graphe-legende-item' },
            h('span', { class: 'puce', style: { background: 'var(--succes)' } }),
            h('span', {}, 'Recettes')),
          h('span', { class: 'graphe-legende-item' },
            h('span', { class: 'puce', style: { background: 'var(--danger)' } }),
            h('span', {}, 'Dépenses')))),
      h('div', { class: 'carte-corps' },
        h('div', { class: 'graphe-cadre' },
          h('div', { class: 'graphe-axe' }, ...graduations),
          h('div', { class: 'graphe-zone' },
            h('div', { class: 'graphe-colonnes' }, ...periodes.map((m) => h('div', { class: 'graphe-colonne' },
              h('div', { class: 'graphe-barres' },
                h('div', {
                  class: 'graphe-barre',
                  style: { height: hauteur(m.recettesCents), background: 'var(--succes)' },
                }),
                h('div', {
                  class: 'graphe-barre',
                  style: { height: hauteur(m.depensesCents), background: 'var(--danger)' },
                })),
              // L'infobulle donne les trois chiffres : deux barres de treize
              // pixels n'en portent aucun.
              h('div', { class: 'graphe-bulle' },
                h('div', { class: 'graphe-bulle-titre' },
                  libellePeriode(m, granularite),
                  // Un numéro de semaine seul ne dit pas quand : la date de
                  // début le dit, et le serveur la rend avec la ligne.
                  granularite === 'semaine' && m.debut
                    ? ' — du ' + dateFr(m.debut)
                    : ''),
                h('div', { class: 'graphe-bulle-ligne' }, 'Recettes : ', donnee(montant(m.recettesCents, true))),
                h('div', { class: 'graphe-bulle-ligne' }, 'Dépenses : ', donnee(montant(m.depensesCents, true))),
                h('div', { class: 'graphe-bulle-ligne' },
                  'Résultat : ', donnee(montantSigne(m.resultatCents))))))))),
        h('div', { class: 'graphe-libelles' },
          ...periodes.map((m) => h('div', { class: 'graphe-etiquette' }, libellePeriode(m, granularite))))));
  };

  /* --- Le tableau detaille, pour qui veut les chiffres exacts --- */

  const blocDetail = (parVehicule, periode) => h('section', { class: 'carte' },
    h('div', { class: 'carte-entete' },
      h('h2', {}, 'Détail par véhicule'),
      h('span', { class: 'ligne-note' },
        'Du ', donnee(dateFr(periode.du || '—')), ' au ', donnee(dateFr(periode.au)))),
    h('div', { class: 'table-enveloppe' },
      h('table', { class: 'donnees' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Véhicule'),
          h('th', { class: 'num' }, 'Activités'),
          h('th', { class: 'num' }, 'Kilomètres'),
          h('th', { class: 'num' }, 'Recettes'),
          h('th', { class: 'num' }, 'Dépenses'),
          h('th', { class: 'num' }, 'Résultat'))),
        h('tbody', {}, ...parVehicule.map((v) => h('tr', {},
          h('td', { dataset: { libelle: 'Véhicule' } }, donnee(v.nom)),
          h('td', { class: 'num', dataset: { libelle: 'Activités' } }, String(v.nbActivites)),
          h('td', { class: 'num', dataset: { libelle: 'Kilomètres' } },
            v.kilometresParcourus != null ? km(v.kilometresParcourus) : '—'),
          h('td', { class: 'num', dataset: { libelle: 'Recettes' } }, montant(v.recettesCents)),
          h('td', { class: 'num', dataset: { libelle: 'Dépenses' } }, montant(v.depensesCents)),
          h('td', {
            class: 'num ' + (v.resultatCents < 0 ? 'resultat-negatif' : 'resultat-positif'),
            dataset: { libelle: 'Résultat' },
          },
            montantSigne(v.resultatCents, false))))))));

  /* --- L'ecran --- */

  const vehicules = etat.meta?.vehicules ?? [];
  const types = etat.meta?.typesActivite ?? [];

  fill(racine,
    h('div', { class: 'page-entete' },
      h('div', {},
        h('h1', {}, 'Statistiques'),
        h('p', {}, 'Ce que la flotte a coûté et rapporté, par véhicule et par type.')),
      h('div', { class: 'page-actions' },
        etat.peut('export.data')
          ? h('a', {
            class: 'bouton',
            href: '/api/exports/activites.xlsx?' + new URLSearchParams(
              Object.fromEntries(Object.entries(filtres).filter(([, v]) => v))).toString(),
          }, icone('telecharger'), h('span', {}, 'Exporter'))
          : null)),

    h('div', { class: 'carte' },
      h('div', { class: 'filtres' },
        champ('Du', saisie({
          type: 'date', value: filtres.du, onchange: (e) => appliquer({ du: e.target.value }),
        })),
        champ('Au', saisie({
          type: 'date', value: filtres.au, onchange: (e) => appliquer({ au: e.target.value }),
        })),
        champ('Véhicule', liste(
          [{ value: '', label: 'Tous les véhicules' },
            ...vehicules.map((v) => ({ value: v.id, label: donnee(v.nom) }))],
          filtres.vehicule, { onchange: (e) => appliquer({ vehicule: e.target.value }) },
        )),
        champ('Type', liste(
          [{ value: '', label: 'Tous les types' },
            ...types.map((t) => ({ value: t.code, label: donnee(t.libelle) }))],
          filtres.type, { onchange: (e) => appliquer({ type: e.target.value }) },
        )),
        champ('Découpage', liste(
          [{ value: 'mois', label: 'Par mois' }, { value: 'semaine', label: 'Par semaine' }],
          filtres.granularite, { onchange: (e) => appliquer({ granularite: e.target.value }) },
        )))),
    corps);

  relire();
  return racine;
}

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/**
 * L'étiquette d'une colonne : « sept. 26 », ou « S39 » pour une semaine.
 *
 * Une semaine se nomme par son numéro — c'est ainsi qu'on en parle — mais
 * un numéro seul ne dit pas quand : l'infobulle donne la date de début, que
 * le serveur rend avec la ligne.
 */
function libellePeriode(ligne, granularite) {
  if (granularite === 'semaine') {
    const numero = String(ligne.periode).split('S')[1];
    return t('S') + numero;
  }
  const [a, m] = String(ligne.periode).split('-').map(Number);
  // Le nom du mois est un libellé d'interface : il se traduit. La fonction
  // rend une chaîne — elle sert aussi dans un attribut `title`, qui n'en
  // accepte pas d'autre — donc la traduction se fait ici, pas à l'affichage.
  return t(MOIS[m - 1]) + ' ' + String(a).slice(2);
}
