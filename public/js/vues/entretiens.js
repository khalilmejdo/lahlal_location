/**
 * Les entretiens et echeances (§10, §13, §14, §34, §35).
 *
 * Trois gestes vivent ici, et le troisieme est le plus important.
 *
 *   - la liste, filtrable par vehicule et par niveau d'alerte ;
 *   - la creation d'une echeance, ou l'intervalle PROPOSE la prochaine
 *     sans l'imposer (§11, §12) ;
 *   - « Entretien effectué » (§34), qui enregistre la realisation, cree
 *     l'activite qui porte son cout, et reporte l'echeance — d'un seul
 *     geste, dans une seule transaction cote serveur.
 *
 * Ce module est importe par la fiche d'un vehicule : ses deux formulaires y
 * sont ouverts directement, sans naviguer ailleurs.
 */
import {
  h, fill, api, etat, icone, dateFr, entier,
  etatVide, chargement, modale, champ, saisie, liste, zoneTexte,
  pastilleNiveau, signalerErreur, succes, demanderMotif, aujourdhui, versCentimes, tuile, rangeeChiffres,
} from '../core.js';
import { aller } from '../app.js';
import { selecteurPieces } from './pieces.js';

const NIVEAUX = [
  { value: '', label: 'Tous les états' },
  { value: 'DEPASSE', label: 'Dépassé' },
  { value: 'URGENT', label: 'Urgent' },
  { value: 'ATTENTION', label: 'Attention' },
  { value: 'NORMAL', label: 'Normal' },
];

/* ================================================================== */
/*  La liste                                                           */
/* ================================================================== */

export async function rendre({ parametres }) {
  const racine = h('div', {});
  const corps = h('div', {}, chargement());

  const filtres = {
    vehicule: parametres.vehicule ?? '',
    niveau: parametres.niveau ?? '',
    statut: parametres.statut ?? 'ACTIF',
  };

  const appliquer = (modif) => {
    Object.assign(filtres, modif);
    const qs = {};
    for (const [k, v] of Object.entries(filtres)) if (v) qs[k] = v;
    aller('entretiens', qs);
  };

  async function relire() {
    try {
      const { entretiens, compteurs } = await api.get('/api/entretiens', filtres);
      fill(corps, peindre(entretiens, compteurs));
    } catch (err) {
      fill(corps, etatVide('Liste indisponible.'));
      signalerErreur(err, 'Lecture des entretiens');
    }
  }

  const peindre = (entretiens, compteurs) => h('div', {},
    rangeeChiffres(
      tuileNiveau('danger', compteurs.DEPASSE, 'Dépassées'),
      tuileNiveau('accent', compteurs.URGENT, 'Urgentes'),
      tuileNiveau('attente', compteurs.ATTENTION, 'À surveiller'),
      tuileNiveau('succes', compteurs.NORMAL, 'Normales')),

    entretiens.length
      ? h('div', { class: 'carte' }, h('div', { class: 'carte-corps' },
        ...entretiens.map((e) => ligne(e, relire))))
      : etatVide('Aucune échéance ne correspond à cette sélection.'));

  // Une tuile à zéro reste grise : colorer un compteur vide en rouge
  // ferait croire à une alerte qui n'existe pas.
  const tuileNiveau = (variante, n, libelle) => tuile(String(n), libelle, n ? variante : '');

  const ligne = (e, apres) => h('div', { class: 'echeance niveau-' + e.etat.niveau },
    h('div', { class: 'echeance-tete' },
      h('span', { class: 'echeance-titre' },
        h('button', {
          class: 'bouton sourdine petit',
          onclick: () => aller('vehicules/' + e.vehiculeId),
          title: 'Ouvrir la fiche du véhicule',
        }, e.vehiculeNom),
        ' — ' + e.libelle),
      h('span', {},
        pastilleNiveau(e.etat.niveau),
        etat.peut('maintenance.close') && e.etat.surveille
          ? h('button', {
            class: 'bouton petit principal', style: { marginLeft: '8px' },
            onclick: async () => { if (await ouvrirClotureEntretien(e, null)) apres(); },
          }, 'Effectué')
          : null,
        etat.peut('maintenance.edit')
          ? h('button', {
            class: 'bouton petit', style: { marginLeft: '6px' }, title: 'Modifier',
            onclick: async () => {
              if (await ouvrirFormulaireEntretien({ existant: e })) apres();
            },
          }, icone('crayon'))
          : null,
        etat.peut('maintenance.delete')
          ? h('button', {
            class: 'bouton petit danger', style: { marginLeft: '6px' }, title: 'Supprimer',
            onclick: () => supprimer(e, apres),
          }, icone('corbeille'))
          : null)),
    h('span', { class: 'echeance-detail' },
      e.alerte?.detail || 'Pas d’échéance exploitable.',
      e.kilometrageVehicule != null ? ' · compteur ' + entier(e.kilometrageVehicule) + ' km' : '',
      e.derniereDate ? ' · dernière fois le ' + dateFr(e.derniereDate) : ''));

  fill(racine,
    h('div', { class: 'page-entete' },
      h('div', {},
        h('h1', {}, 'Entretiens et échéances'),
        h('p', {}, 'Ce qui arrive à échéance, au kilométrage ou à la date.')),
      h('div', { class: 'page-actions' },
        etat.peut('maintenance.create')
          ? h('button', {
            class: 'bouton principal',
            onclick: async () => { if (await ouvrirFormulaireEntretien({})) relire(); },
          }, icone('plus'), h('span', {}, 'Nouvelle échéance'))
          : null)),

    h('div', { class: 'carte' },
      h('div', { class: 'filtres' },
        champ('Véhicule', liste(
          [{ value: '', label: 'Tous les véhicules' },
            ...(etat.meta?.vehicules ?? []).map((v) => ({ value: v.id, label: v.nom }))],
          filtres.vehicule,
          { onchange: (e) => appliquer({ vehicule: e.target.value }) },
        )),
        champ('État', liste(NIVEAUX, filtres.niveau,
          { onchange: (e) => appliquer({ niveau: e.target.value }) })),
        champ('Suivi', liste(
          [{ value: 'ACTIF', label: 'Suivies' }, { value: 'CLOS', label: 'Closes' }],
          filtres.statut,
          { onchange: (e) => appliquer({ statut: e.target.value }) },
        )))),
    corps);

  relire();
  return racine;
}

/* ================================================================== */
/*  Creation et modification d'une echeance                            */
/* ================================================================== */

/**
 * @param {{vehicule?: object, existant?: object}} options
 * @returns {Promise<boolean>} vrai si quelque chose a ete enregistre
 */
export function ouvrirFormulaireEntretien({ vehicule = null, existant = null } = {}) {
  return new Promise((resolve) => {
    let repondu = false;
    const finir = (v) => { if (!repondu) { repondu = true; resolve(v); } };

    const vehicules = etat.meta?.vehicules ?? [];
    const types = etat.meta?.typesEntretien ?? [];
    const suggestions = etat.meta?.intervallesSugeres ?? {};

    const champVehicule = liste(
      vehicules.map((v) => ({ value: v.id, label: v.nom + ' — ' + v.immatriculation })),
      existant?.vehiculeId ?? vehicule?.id ?? vehicules[0]?.id,
    );
    if (existant || vehicule) champVehicule.disabled = true;

    const champType = liste(
      types.map((t) => ({ value: t.code, label: t.libelle })),
      existant?.typeCode ?? types[0]?.code,
    );
    const champLibelle = saisie({ maxlength: 120, required: true, value: existant?.libelle ?? '' });
    const champDerniereDate = saisie({ type: 'date', value: existant?.derniereDate?.slice(0, 10) ?? '' });
    const champDernierKm = saisie({ type: 'number', min: 0, max: 3000000, value: existant?.dernierKm ?? '' });
    const champIntervalleKm = saisie({ type: 'number', min: 100, max: 500000, value: existant?.intervalleKm ?? '' });
    const champIntervalleMois = saisie({ type: 'number', min: 1, max: 240, value: existant?.intervalleMois ?? '' });
    const champProchainKm = saisie({ type: 'number', min: 0, max: 3000000, value: existant?.prochainKm ?? '' });
    const champProchaineDate = saisie({ type: 'date', value: existant?.prochaineDate?.slice(0, 10) ?? '' });
    const champNotes = zoneTexte({ rows: 2, maxlength: 4000, value: existant?.notes ?? '' });
    const avis = h('p', { class: 'ligne-note', role: 'alert' });
    const apercu = h('p', { class: 'ligne-note' });

    /**
     * Ce que l'intervalle PROPOSERAIT, affiche a cote de la saisie.
     *
     * On ne remplit pas les champs a la place de l'utilisateur : §11 et §12
     * veulent que sa valeur soit respectee, et un champ pre-rempli se
     * valide sans etre lu. On montre la proposition, il la prend ou non.
     */
    const rafraichirApercu = () => {
      const km0 = champDernierKm.value === '' ? null : Number(champDernierKm.value);
      const pasKm = champIntervalleKm.value === '' ? null : Number(champIntervalleKm.value);
      const date0 = champDerniereDate.value || null;
      const pasMois = champIntervalleMois.value === '' ? null : Number(champIntervalleMois.value);

      const parts = [];
      if (km0 !== null && pasKm) parts.push(entier(km0 + pasKm) + ' km');
      if (date0 && pasMois) parts.push('le ' + dateFr(ajouterMois(date0, pasMois)));
      fill(apercu, parts.length
        ? 'Sans saisie de votre part, la prochaine échéance sera : ' + parts.join(' et ') + '.'
        : 'Renseignez une prochaine échéance, ou un intervalle et une dernière réalisation.');
    };

    for (const c of [champDernierKm, champIntervalleKm, champDerniereDate, champIntervalleMois]) {
      c.addEventListener('input', rafraichirApercu);
      c.addEventListener('change', rafraichirApercu);
    }

    // Le type suggere son intervalle habituel et son libelle, a la creation
    // seulement : sur une echeance existante, ce serait ecraser une decision.
    champType.addEventListener('change', () => {
      const t = types.find((x) => x.code === champType.value);
      if (!existant && t && !champLibelle.value.trim()) champLibelle.value = t.libelle;
      const s = suggestions[champType.value];
      if (!existant && s) {
        if (s.km && champIntervalleKm.value === '') champIntervalleKm.value = s.km;
        if (s.mois && champIntervalleMois.value === '') champIntervalleMois.value = s.mois;
      }
      rafraichirApercu();
    });
    if (!existant) champType.dispatchEvent(new Event('change'));

    const enregistrer = async () => {
      fill(avis, '');
      const corps = {
        vehiculeId: champVehicule.value,
        typeCode: champType.value,
        libelle: champLibelle.value.trim(),
        derniereDate: champDerniereDate.value || undefined,
        dernierKm: champDernierKm.value === '' ? undefined : Number(champDernierKm.value),
        intervalleKm: champIntervalleKm.value === '' ? undefined : Number(champIntervalleKm.value),
        intervalleMois: champIntervalleMois.value === '' ? undefined : Number(champIntervalleMois.value),
        prochainKm: champProchainKm.value === '' ? undefined : Number(champProchainKm.value),
        prochaineDate: champProchaineDate.value || undefined,
        notes: champNotes.value.trim() || undefined,
      };
      if (!corps.libelle) { fill(avis, 'Donnez un libellé à cette échéance.'); return; }

      try {
        if (existant) await api.patch('/api/entretiens/' + existant.id, corps);
        else await api.post('/api/entretiens', corps);
        succes(existant ? 'Échéance modifiée' : 'Échéance créée', corps.libelle);
        finir(true);
        m.fermer();
      } catch (err) {
        fill(avis, err?.message || 'Enregistrement impossible.');
      }
    };

    const m = modale({
      titre: existant ? 'Modifier l’échéance' : 'Nouvelle échéance',
      sousTitre: 'Un kilométrage, une date, ou les deux : l’alerte se déclenche dès que l’une arrive.',
      contenu: h('div', {},
        champ('Véhicule', champVehicule, { large: true }),
        h('div', { class: 'ligne-champs' }, champ('Type', champType), champ('Libellé', champLibelle)),

        h('h3', { style: { marginTop: '14px' } }, 'Dernière réalisation'),
        h('div', { class: 'ligne-champs' },
          champ('Date', champDerniereDate),
          champ('Kilométrage', champDernierKm)),

        h('h3', { style: { marginTop: '14px' } }, 'Intervalle habituel'),
        h('div', { class: 'ligne-champs' },
          champ('Tous les… (km)', champIntervalleKm),
          champ('Tous les… (mois)', champIntervalleMois)),
        apercu,

        h('h3', { style: { marginTop: '14px' } }, 'Prochaine échéance'),
        h('p', { class: 'ligne-note' },
          'Laissez vide pour appliquer l’intervalle. Une valeur saisie ici est respectée telle quelle.'),
        h('div', { class: 'ligne-champs' },
          champ('Au kilométrage', champProchainKm),
          champ('À la date', champProchaineDate)),

        champ('Notes', champNotes, { large: true }),
        avis),
      actions: [
        h('button', { class: 'bouton', onclick: () => { finir(false); m.fermer(); } }, 'Annuler'),
        h('button', { class: 'bouton principal', onclick: enregistrer }, 'Enregistrer'),
      ],
      surFermeture: () => finir(false),
    });

    rafraichirApercu();
  });
}

/* ================================================================== */
/*  « Entretien effectué » (§34)                                       */
/* ================================================================== */

export function ouvrirClotureEntretien(entretien, vehicule) {
  return new Promise((resolve) => {
    let repondu = false;
    const finir = (v) => { if (!repondu) { repondu = true; resolve(v); } };

    const cle = 'ent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    const kmVehicule = vehicule?.kilometrage ?? entretien.kilometrageVehicule ?? '';

    const champDate = saisie({ type: 'date', value: aujourdhui(), max: aujourdhui(), required: true });
    const champKm = saisie({ type: 'number', min: 0, max: 3000000, value: kmVehicule });
    const champCout = saisie({ inputmode: 'decimal', placeholder: '0,00' });
    const champNotes = zoneTexte({ rows: 2, maxlength: 4000, placeholder: 'Garage, pièces changées…' });
    const champProchainKm = saisie({ type: 'number', min: 0, max: 3000000 });
    const champProchaineDate = saisie({ type: 'date' });
    const champClore = h('input', { type: 'checkbox' });
    const apercu = h('p', { class: 'ligne-note' });
    const avis = h('p', { class: 'ligne-note', role: 'alert' });
    const pieces = selecteurPieces({ libelle: 'Facture, photos (facultatif)' });

    const rafraichirApercu = () => {
      const parts = [];
      const km0 = champKm.value === '' ? null : Number(champKm.value);
      if (km0 !== null && entretien.intervalleKm) parts.push(entier(km0 + entretien.intervalleKm) + ' km');
      if (champDate.value && entretien.intervalleMois) {
        parts.push('le ' + dateFr(ajouterMois(champDate.value, entretien.intervalleMois)));
      }
      fill(apercu, parts.length
        ? 'Sans saisie, la prochaine échéance sera : ' + parts.join(' et ') + '.'
        : 'Aucun intervalle enregistré : saisissez la prochaine échéance, ou clôturez.');
    };
    for (const c of [champKm, champDate]) c.addEventListener('input', rafraichirApercu);

    const enregistrer = async () => {
      fill(avis, '');
      const cout = versCentimes(champCout.value);
      if (cout === null) { fill(avis, 'Le coût ne se lit pas. Exemple : 180,00'); return; }

      try {
        const reponse = await api.post('/api/entretiens/' + entretien.id + '/effectue', {
          date: champDate.value,
          kilometrage: champKm.value === '' ? undefined : Number(champKm.value),
          coutCents: cout,
          notes: champNotes.value.trim() || undefined,
          prochainKm: champProchainKm.value === '' ? undefined : Number(champProchainKm.value),
          prochaineDate: champProchaineDate.value || undefined,
          clore: champClore.checked,
          idempotencyKey: cle,
        });
        // Les pieces se rattachent a l'entretien : elles documentent la
        // realisation, et on veut les retrouver depuis son historique.
        try {
          await pieces.envoyer('entretien', entretien.id);
        } catch (err) {
          signalerErreur(err, 'Entretien enregistré, mais les pièces n’ont pas pu être envoyées');
        }
        succes('Entretien enregistré', entretien.libelle +
          (reponse.entretien?.alerte?.detail ? ' — ' + reponse.entretien.alerte.detail : ''));
        finir(true);
        m.fermer();
      } catch (err) {
        fill(avis, err?.message || 'Enregistrement impossible.');
      }
    };

    const m = modale({
      titre: entretien.libelle + ' — effectué',
      sousTitre: 'La dépense est enregistrée comme activité du véhicule, et l’échéance est reportée.',
      contenu: h('div', {},
        h('div', { class: 'ligne-champs' },
          champ('Date de réalisation', champDate),
          champ('Kilométrage', champKm)),
        champ('Coût (DH)', champCout, { large: true, aide: 'Laissez à 0 si rien n’a été déboursé.' }),
        champ('Notes', champNotes, { large: true }),

        h('h3', { style: { marginTop: '14px' } }, 'Prochaine échéance'),
        apercu,
        h('div', { class: 'ligne-champs' },
          champ('Au kilométrage', champProchainKm),
          champ('À la date', champProchaineDate)),
        h('label', { class: 'case' }, champClore,
          h('span', {}, 'Ne pas reconduire : clôturer cette échéance')),

        pieces.noeud,
        avis),
      actions: [
        h('button', { class: 'bouton', onclick: () => { finir(false); m.fermer(); } }, 'Annuler'),
        h('button', { class: 'bouton principal', onclick: enregistrer }, 'Enregistrer'),
      ],
      surFermeture: () => finir(false),
    });

    rafraichirApercu();
  });
}

/* ------------------------------------------------------------------ */

async function supprimer(e, apres) {
  const motif = await demanderMotif({
    titre: 'Supprimer « ' + e.libelle + ' » ?',
    message: 'Une échéance déjà réalisée ne se supprime pas : elle se clôture, ' +
      'pour ne pas couper l’historique du véhicule.',
    libelleConfirmation: 'Supprimer',
  });
  if (!motif) return;
  try {
    await api.delete('/api/entretiens/' + e.id, { motif });
    succes('Échéance supprimée', e.libelle);
    apres?.();
  } catch (err) { signalerErreur(err, 'Suppression impossible'); }
}

/** Le meme calcul que server/core/text.js : le quantieme est borne. */
function ajouterMois(iso, mois) {
  const [a, m, j] = iso.split('-').map(Number);
  const cible = new Date(Date.UTC(a, m - 1 + mois, 1));
  const dernier = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(j, dernier));
  return cible.toISOString().slice(0, 10);
}

