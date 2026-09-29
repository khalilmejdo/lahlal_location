/**
 * Le journal d'audit.
 *
 * Il repond a une seule question, mais il y repond vraiment : qui a changé
 * quoi, quand, et pourquoi. Chaque entree porte son diff champ par champ ;
 * un montant modifie montre l'avant et l'apres, pas seulement « modifié ».
 *
 * LA VERIFICATION DE LA CHAINE EST UN BOUTON, PAS UNE AFFIRMATION.
 *
 * Un journal qui se declare inviolable sans le demontrer ne vaut rien. Le
 * bouton recalcule les condensats et dit sur combien d'entrees il s'est
 * prononce — le nombre compte autant que le verdict.
 */
import {
  h, fill, api, dateHeureFr, etatVide, chargement, saisie, liste,
  signalerErreur, succes, montant,
} from '../core.js';

const SEVERITES = [
  { value: '', label: 'Toutes gravités' },
  { value: 'critical', label: 'Critique' },
  { value: 'warning', label: 'Avertissement' },
  { value: 'notice', label: 'Notable' },
  { value: 'info', label: 'Information' },
];

const CLASSE = { critical: 'critical', warning: 'warning', notice: 'notice', info: '' };

export async function rendre({ parametres }) {
  const racine = h('div', {});
  const corps = h('div', {}, chargement());

  const filtres = {
    q: parametres.q ?? '',
    severite: parametres.severite ?? '',
    entity: parametres.entity ?? '',
    offset: 0,
  };

  async function relire() {
    try {
      fill(corps, peindre(await api.get('/api/audit', { ...filtres, limit: 50 })));
    } catch (err) {
      fill(corps, etatVide('Journal indisponible.'));
      signalerErreur(err, 'Lecture du journal');
    }
  }

  const peindre = ({ entrees, pagination, journalPerdu }) => h('div', {},
    journalPerdu?.total
      ? h('div', { class: 'carte niveau-DEPASSE' },
        h('div', { class: 'carte-corps' },
          h('strong', {}, journalPerdu.total + ' entrée(s) du journal n’ont pas pu être écrites.'),
          h('p', { class: 'ligne-note' },
            'Le journal est incomplet sur cette période. Prévenez l’administrateur : ' +
            'c’est la base qui n’a pas accepté l’écriture, pas l’application qui l’a omise.')))
      : null,

    entrees.length
      ? h('div', { class: 'carte' },
        h('div', { class: 'carte-corps' },
          h('div', { class: 'chronologie' }, ...entrees.map(entree))),
        h('div', { class: 'pagination' },
          h('span', { class: 'info' },
            'Entrées ' + (pagination.offset + 1) + ' à ' +
            Math.min(pagination.offset + pagination.limit, pagination.total) +
            ' sur ' + pagination.total),
          h('div', { class: 'groupe-boutons' },
            h('button', {
              class: 'bouton petit', disabled: pagination.offset === 0,
              onclick: () => { filtres.offset = Math.max(0, filtres.offset - 50); relire(); },
            }, 'Précédent'),
            h('button', {
              class: 'bouton petit',
              disabled: pagination.offset + pagination.limit >= pagination.total,
              onclick: () => { filtres.offset += 50; relire(); },
            }, 'Suivant'))))
      : etatVide('Aucune entrée ne correspond à cette sélection.'));

  const entree = (e) => h('div', { class: 'chrono-entree ' + (CLASSE[e.severite] ?? '') },
    h('div', { class: 'quand' },
      dateHeureFr(e.le) + ' · ' + e.action + (e.ip ? ' · ' + e.ip : '')),
    h('div', { class: 'quoi' }, e.resume),
    h('div', { class: 'qui' }, e.par || 'système'),
    e.changements ? diff(e.changements) : null);

  const diff = (changements) => h('div', { class: 'chrono-diff' },
    ...Object.entries(changements).map(([cle, v]) => h('div', { class: 'champ-diff' },
      h('span', { class: 'cle' }, cle),
      h('span', { class: 'avant' }, valeur(cle, v?.from)),
      h('span', {}, '→'),
      h('span', { class: 'apres' }, valeur(cle, v?.to)))));

  /** Un montant en centimes se lit en dirhams, pas en entier brut. */
  const valeur = (cle, v) => {
    if (v === null || v === undefined || v === '') return '(vide)';
    if (/_cents$/.test(cle) && Number.isFinite(Number(v))) return montant(Number(v), true);
    return String(v);
  };

  const verifier = async () => {
    try {
      const r = await api.get('/api/audit/verifier');
      if (r.ok || r.valide) succes('Chaîne vérifiée', r.message || 'Aucune altération détectée.');
      else signalerErreur(new Error(r.message || 'La chaîne présente une anomalie.'), 'Vérification');
    } catch (err) { signalerErreur(err, 'Vérification impossible'); }
  };

  const champQ = saisie({ type: 'search', value: filtres.q, placeholder: 'Rechercher…' });
  let minuteur = null;
  champQ.addEventListener('input', (e) => {
    clearTimeout(minuteur);
    const v = e.target.value;
    minuteur = setTimeout(() => { filtres.q = v; filtres.offset = 0; relire(); }, 350);
  });

  fill(racine,
    h('div', { class: 'page-entete' },
      h('div', {},
        h('h1', {}, 'Journal d’audit'),
        h('p', {}, 'Qui a changé quoi, quand, et pourquoi. Ce journal ne se modifie pas.')),
      h('div', { class: 'page-actions' },
        h('button', { class: 'bouton', onclick: verifier }, 'Vérifier la chaîne'))),

    h('div', { class: 'filtres' },
      champQ,
      liste(SEVERITES, filtres.severite, {
        onchange: (e) => { filtres.severite = e.target.value; filtres.offset = 0; relire(); },
      }),
      liste([
        { value: '', label: 'Toutes les entités' },
        { value: 'vehicule', label: 'Véhicules' },
        { value: 'activite', label: 'Activités' },
        { value: 'entretien', label: 'Entretiens' },
        { value: 'user', label: 'Comptes' },
        { value: 'settings', label: 'Paramètres' },
      ], filtres.entity, {
        onchange: (e) => { filtres.entity = e.target.value; filtres.offset = 0; relire(); },
      })),
    corps);

  relire();
  return racine;
}
