/**
 * Le socle de l'interface : construction du DOM, appels a l'API, messages.
 *
 * Repris des idiomes de lahlal_samuplus — h(), fill(), api, notifier(),
 * modale() — avec la meme feuille de style, mais sans son domaine : ni TVA,
 * ni exercice comptable, ni traduction. Ce qui restait couple a la
 * facturation n'a pas ete recopie « au cas ou » : du code mort dans un
 * fichier charge par chaque ecran est du poids paye a chaque ouverture.
 *
 * AUCUN innerHTML AVEC DES DONNEES. La seule exception est icone(), qui
 * dessine un trace pris dans une table interne de ce fichier. Tout le reste
 * passe par createTextNode : il n'y a donc pas de chemin par lequel une
 * prestation, une note ou un nom de fichier puisse devenir du balisage.
 */

import { t, noterManquante } from './i18n.js';

/* ================================================================== */
/*  1. Construction du DOM                                             */
/* ================================================================== */

/**
 * Attributs dont le contenu s'affiche, et se traduit donc.
 *
 * Les autres — « value », « name », « data-* » — portent des identifiants
 * ou des valeurs métier : les traduire enverrait « الطوموبيل » là où le
 * serveur attend « VEHICULE ».
 */
const ATTRIBUTS_TRADUITS = new Set(['placeholder', 'title', 'aria-label', 'alt']);

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (ATTRIBUTS_TRADUITS.has(key)) {
      noterManquante(value);
      node.setAttribute(key, t(String(value)));
    } else if (key === 'value' && (tag === 'textarea' || tag === 'select')) {
      // Un <textarea> n'a pas d'attribut « value » : son contenu est son
      // texte, et le poser en attribut laisse le champ vide sans erreur —
      // puis le formulaire renvoie la chaine vide et efface la note
      // enregistree. Un <select> a le meme piege avant que ses options
      // n'existent : on le repose apres.
      node.value = String(value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  append(node, children);
  return node;
}

/**
 * Ajoute des enfants, en traduisant le texte au passage.
 *
 * C'est l'UNIQUE endroit où une chaîne devient visible : rien n'est inséré
 * via innerHTML dans cette application. Traduire ici suffit donc à traduire
 * toute l'interface, sans réécrire un seul écran.
 */
function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    if (child instanceof Node) { node.append(child); continue; }
    const brut = String(child);
    noterManquante(brut);
    node.append(document.createTextNode(t(brut)));
  }
}

/**
 * Du texte qui est une DONNÉE, et non un libellé d'interface.
 *
 * Toute chaîne passée à `h()` ou `fill()` traverse le traducteur. C'est
 * juste pour un libellé — c'est même tout l'objet de la fonction — et faux
 * pour ce qu'un utilisateur a écrit. Une prestation nommée « Vidange », un
 * véhicule appelé « Location », une note d'exploitation : si le texte
 * coïncide avec une entrée du dictionnaire, il est REMPLACÉ, et la personne
 * qui relit sa propre saisie ne lit plus ce qu'elle a écrit.
 *
 * Rendre un nœud de texte suffit : `append()` laisse passer un Node sans y
 * toucher. C'est le correctif O-3 de lahlal_samuplus, repris ici avant que
 * le défaut n'existe.
 */
export function donnee(valeur) {
  return document.createTextNode(valeur === null || valeur === undefined ? '' : String(valeur));
}

/**
 * Une donnée affichée DANS LE FIL D'UNE PHRASE, isolée de son sens
 * d'écriture.
 *
 * En darija, la page se lit de droite à gauche, et le navigateur réordonne
 * ce qu'il ne sait pas rattacher : l'immatriculation « 1234-A-56 » posée au
 * milieu d'une ligne arabe ressort « A-56 · … · 1234 », et une date
 * « 29/09/2026 » se disloque de la même façon. Constaté sur la fiche d'un
 * véhicule rendue par Chrome.
 *
 * `<bdi>` est l'élément prévu pour un texte dont on ne connaît pas le sens :
 * il le lit selon ses propres caractères, sans rien changer à une page de
 * gauche à droite. Il est en ligne — il ne déplace rien.
 *
 * `donnee()` reste un simple nœud de texte : elle sert là où un élément
 * n'est pas admis, à commencer par le contenu d'un `<option>`.
 */
export function donneeIsolee(valeur) {
  return h('bdi', {}, donnee(valeur));
}

/** Remplace le contenu d'un element. */
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export const $ = (sel, scope = document) => scope.querySelector(sel);
export const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

/* ================================================================== */
/*  2. Icones                                                          */
/* ================================================================== */

const TRACES = {
  tableau: 'M3 3h18v18H3zM3 9h18M9 21V9',
  voiture: 'M4.3 12l1.7-4.4A2 2 0 017.9 6.3h8.2a2 2 0 011.9 1.3L19.7 12'
    + 'M3.2 12h17.6a1 1 0 011 1v3.1a1 1 0 01-1 1H3.2a1 1 0 01-1-1V13a1 1 0 011-1z'
    + 'M7.2 17.1v1.5M16.8 17.1v1.5M5.6 14.6h1.7M16.7 14.6h1.7',
  activite: 'M3 3v18h18M7 14l4-4 3 3 5-6',
  cle: 'M14.7 6.3a4 4 0 01-5 5.4L4 17.4V20h2.6l5.7-5.7a4 4 0 015.4-5L15 12l-3-3z',
  alerte: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01',
  rapport: 'M18 20V10M12 20V4M6 20v-6M3 20h18',
  administration: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.14.34.4.63.73.82',
  journal: 'M12 8v4l3 3M12 3a9 9 0 109 9 9 9 0 00-9-9',
  recherche: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  menu: 'M3 12h18M3 6h18M3 18h18',
  theme: 'M12 3a9 9 0 109 9 7 7 0 01-9-9z',
  plus: 'M12 5v14M5 12h14',
  croix: 'M18 6L6 18M6 6l12 12',
  coche: 'M20 6L9 17l-5-5',
  appareil: 'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3M21 15l-5-5L5 21',
  piece: 'M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48',
  telecharger: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  imprimer: 'M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z',
  retour: 'M19 12H5M12 19l-7-7 7-7',
  corbeille: 'M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6',
  crayon: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z',
  calendrier: 'M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zM16 2v4M8 2v4M3 10h18',
  compteur: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 12l4-4M12 12h.01',
  deconnexion: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  utilisateur: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 3a4 4 0 100 8 4 4 0 000-8',
  oeil: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 100 6 3 3 0 000-6z',
  oeilBiffe: 'M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22',
};

/** Icone SVG. Les traces proviennent d'une table interne, jamais du reseau. */
export function icone(nom, taille = 17) {
  const d = TRACES[nom] || TRACES.tableau;
  const span = document.createElement('span');
  span.className = 'icone';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="' + taille + '" height="' + taille +
    '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    'stroke-linejoin="round"><path d="' + d.replace(/"/g, '') + '"/></svg>';
  return span;
}

/* ================================================================== */
/*  3. Formatage                                                       */
/* ================================================================== */

/**
 * Des centimes vers « 1 035,50 ».
 *
 * Meme regle que server/core/money.js : l'espace fine insecable separe les
 * milliers, la virgule les decimales. Les deux cotes doivent afficher le
 * meme nombre de la meme facon, sinon on doute du calcul.
 */
export function montant(cents, avecDevise = false) {
  const v = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const negatif = v < 0;
  const abs = Math.abs(v);
  const entiers = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const dec = String(abs % 100).padStart(2, '0');
  return (negatif ? '-' : '') + entiers + ',' + dec + (avecDevise ? ' DH' : '');
}

/** Le meme, avec un signe explicite : « +200,00 DH ». Pour un resultat. */
export function montantSigne(cents, avecDevise = true) {
  const v = Math.trunc(cents || 0);
  return (v > 0 ? '+' : '') + montant(v, avecDevise);
}

/** Un entier avec ses milliers separes : 152300 -> « 152 300 ». */
export const entier = (n) =>
  n === null || n === undefined || n === ''
    ? ''
    : String(Math.trunc(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Un kilometrage prêt a lire. */
export const km = (n) => (n === null || n === undefined ? '—' : entier(n) + ' km');

/** « 2026-09-29 » -> « 29/09/2026 ». */
export function dateFr(iso) {
  if (!iso) return '';
  const v = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return String(iso);
  const [a, m, j] = v.split('-');
  return j + '/' + m + '/' + a;
}

export function dateHeureFr(valeur) {
  if (!valeur) return '';
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  if (Number.isNaN(d.getTime())) return String(valeur);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
    ' à ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export const aujourdhui = () => {
  // La date LOCALE, pas celle d'UTC : a 1 h du matin au Maroc, toISOString()
  // rend encore la veille, et le formulaire proposerait hier par defaut.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

/** Le premier jour du mois courant, pour les filtres de periode. */
export const debutDuMois = () => aujourdhui().slice(0, 8) + '01';

/**
 * Une saisie humaine (« 1 035,50 ») vers des centimes.
 *
 * La conversion se fait ICI, avant l'envoi : l'API ne parle qu'en centimes
 * entiers. Rend null si la saisie ne se lit pas, pour que l'appelant
 * distingue « rien » de « zero ».
 */
export function versCentimes(saisie) {
  if (saisie === null || saisie === undefined || String(saisie).trim() === '') return 0;
  const propre = String(saisie).replace(/[\s'`  ]/g, '').replace(',', '.');
  if (!/^-?\d*\.?\d*$/.test(propre) || propre === '' || propre === '.' || propre === '-') return null;
  const n = Number(propre);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/* ================================================================== */
/*  4. Etat partage                                                    */
/* ================================================================== */

export const etat = {
  utilisateur: null,
  csrfToken: null,
  meta: null,
  seuils: null,
  parametres: null,

  peut(permission) {
    return Boolean(this.utilisateur?.permissions?.includes(permission));
  },
  peutUnDes(...permissions) {
    return permissions.some((p) => this.peut(p));
  },
};

/* ================================================================== */
/*  5. Appels a l'API                                                  */
/* ================================================================== */

export class ErreurApi extends Error {
  constructor(statut, charge) {
    super(charge?.error?.message || 'Erreur inattendue du serveur.');
    this.name = 'ErreurApi';
    this.statut = statut;
    this.code = charge?.error?.code || 'ERREUR';
    this.details = charge?.error?.details || null;
  }

  /** Erreurs de validation, indexees par champ. */
  get champs() {
    return this.details?.fields || null;
  }
}

async function requete(methode, chemin, { corps, fichiers, parametres } = {}) {
  let url = chemin;
  if (parametres) {
    const qs = new URLSearchParams();
    for (const [cle, valeur] of Object.entries(parametres)) {
      if (valeur === undefined || valeur === null || valeur === '') continue;
      qs.set(cle, String(valeur));
    }
    const chaine = qs.toString();
    if (chaine) url += (url.includes('?') ? '&' : '?') + chaine;
  }

  const entetes = { Accept: 'application/json' };
  // Le jeton CSRF voyage dans l'en-tete, et seulement la : c'est ce que le
  // serveur lit, et il le lit avant d'analyser le corps.
  if (etat.csrfToken) entetes['X-CSRF-Token'] = etat.csrfToken;

  let charge;
  if (fichiers?.length) {
    const form = new FormData();
    for (const [cle, valeur] of Object.entries(corps || {})) {
      if (valeur !== undefined && valeur !== null) form.append(cle, String(valeur));
    }
    for (const f of fichiers) form.append('fichier', f, f.name);
    charge = form; // pas de Content-Type : le navigateur pose la limite
  } else if (corps !== undefined) {
    entetes['Content-Type'] = 'application/json';
    charge = JSON.stringify(corps);
  }

  let reponse;
  try {
    reponse = await fetch(url, {
      method: methode,
      headers: entetes,
      body: charge,
      credentials: 'same-origin',
    });
  } catch {
    // Une coupure reseau n'est pas une erreur du serveur : elle se dit
    // autrement, parce que ce qu'il faut faire n'est pas le meme.
    throw new ErreurApi(0, {
      error: {
        code: 'RESEAU',
        message: 'La connexion au serveur a été perdue. Vérifiez votre réseau et réessayez.',
      },
    });
  }

  if (reponse.status === 204) return null;

  const type = reponse.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!reponse.ok) throw new ErreurApi(reponse.status, null);
    return reponse;
  }

  const donnees = await reponse.json();

  if (!reponse.ok) {
    if (reponse.status === 401) {
      etat.utilisateur = null;
      etat.csrfToken = null;
      // Ce qu'il faut savoir n'est pas que la session a expire : c'est si ce
      // qu'on venait de faire a ete enregistre. Sur une ecriture, le serveur
      // n'a rien ecrit — et sans ce mot, on croira que c'est passe.
      window.dispatchEvent(new CustomEvent('session-perdue', {
        detail: { ecriture: methode !== 'GET' },
      }));
    }
    throw new ErreurApi(reponse.status, donnees);
  }

  return donnees;
}

export const api = {
  get: (chemin, parametres) => requete('GET', chemin, { parametres }),
  post: (chemin, corps) => requete('POST', chemin, { corps }),
  put: (chemin, corps) => requete('PUT', chemin, { corps }),
  patch: (chemin, corps) => requete('PATCH', chemin, { corps }),
  delete: (chemin, corps) => requete('DELETE', chemin, { corps }),
  televerser: (chemin, corps, fichiers) => requete('POST', chemin, { corps, fichiers }),
};

/* ================================================================== */
/*  6. Notifications                                                   */
/* ================================================================== */

export function notifier(type, titre, message, { duree = null } = {}) {
  const conteneur = $('#conteneur-notifications');
  if (!conteneur) return;

  const boite = h('div', { class: 'notification ' + type, role: 'status' },
    h('strong', {}, titre),
    message ? h('p', {}, message) : null,
    h('button', {
      type: 'button',
      class: 'bouton-fermer',
      'aria-label': 'Fermer',
      onclick: () => boite.remove(),
    }));

  conteneur.append(boite);
  // Une erreur reste jusqu'a ce qu'on la ferme : elle demande une decision.
  const delai = duree ?? (type === 'erreur' ? 12000 : 5000);
  if (delai > 0) setTimeout(() => boite.remove(), delai);
}

export const succes = (t, m) => notifier('succes', t, m);
export const info = (t, m) => notifier('info', t, m);
export const attention = (t, m) => notifier('attention', t, m);
export const erreur = (t, m) => notifier('erreur', t, m);

/**
 * Affiche une erreur d'API de la facon dont elle doit l'etre.
 *
 * Les erreurs de validation portent le detail par champ : les recopier dans
 * une notification n'aide personne, c'est au formulaire de les montrer a
 * cote des champs. Ici, on dit ce qui s'est passe.
 */
export function signalerErreur(err, contexte = 'Opération impossible') {
  if (!(err instanceof ErreurApi)) {
    erreur(contexte, err?.message || 'Erreur inattendue.');
    return;
  }
  if (err.statut === 401) return; // l'ecran de connexion prend le relais
  const champs = err.champs;
  const detail = champs
    ? Object.entries(champs).map(([c, m]) => c + ' : ' + m).join(' · ')
    : err.message;
  erreur(contexte, detail);
}

/* ================================================================== */
/*  7. Modales                                                         */
/* ================================================================== */

const SELECTEUR_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Une modale, avec son piege de focus.
 *
 * Le piege n'est pas un detail d'accessibilite : sans lui, la tabulation
 * sort de la boite et va cliquer dans la page qui est derriere — laquelle
 * est censee etre inerte.
 */
export function modale({ titre, sousTitre, contenu, actions = [], taille = '', surFermeture }) {
  const conteneur = $('#conteneur-modales');
  const focusAvant = document.activeElement;

  const boite = h('div', { class: 'modale ' + taille, role: 'dialog', 'aria-modal': 'true' });

  // Le fond n'est pas un frère de la boîte : il la CONTIENT. C'est lui qui
  // couvre l'écran et qui la centre (« display: grid; place-items: center »
  // dans la feuille de style). En faire deux éléments côte à côte laissait
  // le voile se peindre par-dessus la boîte, qui apparaissait grisée et mal
  // placée — constaté sur la capture en format téléphone.
  const fond = h('div', {
    class: 'modale-fond',
    onclick: (e) => { if (e.target === fond) fermer(); },
  }, boite);

  const entete = h('div', { class: 'modale-entete' },
    h('div', {},
      h('h2', {}, titre),
      sousTitre ? h('p', {}, sousTitre) : null),
    h('button', { type: 'button', class: 'bouton-fermer', 'aria-label': 'Fermer', onclick: () => fermer() }));

  const corps = h('div', { class: 'modale-corps' }, contenu);
  const pied = actions.length ? h('div', { class: 'modale-pied' }, actions) : null;

  fill(boite, entete, corps, pied);

  function surTouche(e) {
    if (e.key === 'Escape') { e.preventDefault(); fermer(); return; }
    if (e.key !== 'Tab') return;
    const cibles = [...boite.querySelectorAll(SELECTEUR_FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!cibles.length) return;
    const premier = cibles[0];
    const dernier = cibles[cibles.length - 1];
    if (e.shiftKey && document.activeElement === premier) { e.preventDefault(); dernier.focus(); }
    else if (!e.shiftKey && document.activeElement === dernier) { e.preventDefault(); premier.focus(); }
  }

  function fermer(resultat) {
    document.removeEventListener('keydown', surTouche, true);
    fond.remove();
    if (!conteneur.children.length) document.body.classList.remove('modale-ouverte');
    focusAvant?.focus?.();
    surFermeture?.(resultat);
  }

  document.addEventListener('keydown', surTouche, true);
  conteneur.append(fond);
  document.body.classList.add('modale-ouverte');

  // Le premier champ, pas le bouton de fermeture : on ouvre une modale pour
  // saisir, pas pour la refermer.
  const premierChamp = boite.querySelector('input, select, textarea');
  (premierChamp || boite.querySelector('.modale-pied button') || boite).focus?.();

  return { fermer, boite, corps };
}

/** Une confirmation. Rend une promesse : true si l'on confirme. */
export function confirmer({ titre, message, libelleConfirmation = 'Confirmer', danger = false }) {
  return new Promise((resolve) => {
    let repondu = false;
    const finir = (v) => { if (!repondu) { repondu = true; resolve(v); } };

    const m = modale({
      titre,
      contenu: h('p', {}, message),
      actions: [
        h('button', { type: 'button', class: 'bouton', onclick: () => { finir(false); m.fermer(); } }, 'Annuler'),
        h('button', {
          type: 'button',
          class: 'bouton ' + (danger ? 'danger' : 'principal'),
          onclick: () => { finir(true); m.fermer(); },
        }, libelleConfirmation),
      ],
      surFermeture: () => finir(false),
    });
  });
}

/**
 * Demande un motif. Rend le texte saisi, ou null si l'on renonce.
 *
 * Tout geste destructeur en demande un (§29) : c'est ce que le journal
 * d'audit conservera, et c'est la seule chose qui, dans six mois, dira
 * pourquoi cette activite a ete mise a la corbeille.
 */
export function demanderMotif({ titre, message, libelleConfirmation = 'Valider', danger = true }) {
  return new Promise((resolve) => {
    let repondu = false;
    const finir = (v) => { if (!repondu) { repondu = true; resolve(v); } };

    const champ = h('textarea', {
      class: 'saisie',
      rows: 3,
      maxlength: 500,
      placeholder: 'Motif (obligatoire, au moins 3 caractères)',
    });
    const avis = h('p', { class: 'ligne-note' });

    const valider = () => {
      const texte = champ.value.trim();
      if (texte.length < 3) {
        fill(avis, 'Le motif doit comporter au moins trois caractères.');
        champ.classList.add('en-erreur');
        champ.focus();
        return;
      }
      finir(texte);
      m.fermer();
    };

    const m = modale({
      titre,
      contenu: h('div', {}, message ? h('p', {}, message) : null, champ, avis),
      actions: [
        h('button', { type: 'button', class: 'bouton', onclick: () => { finir(null); m.fermer(); } }, 'Annuler'),
        h('button', {
          type: 'button',
          class: 'bouton ' + (danger ? 'danger' : 'principal'),
          onclick: valider,
        }, libelleConfirmation),
      ],
      surFermeture: () => finir(null),
    });
  });
}

/* ================================================================== */
/*  8. Fragments d'interface reutilises                                */
/* ================================================================== */

/** Un champ de formulaire : etiquette, controle, et son aide eventuelle. */
export function champ(etiquette, controle, { aide = null, large = false } = {}) {
  const id = controle.id || ('champ-' + Math.random().toString(36).slice(2, 9));
  controle.id = id;
  return h('label', { class: 'champ' + (large ? ' large' : ''), for: id },
    h('span', {}, etiquette),
    controle,
    aide ? h('small', { class: 'ligne-note' }, aide) : null);
}

export function saisie(attrs = {}) {
  return h('input', { class: 'saisie', ...attrs });
}

export function liste(options, valeur, attrs = {}) {
  const select = h('select', { class: 'saisie', ...attrs },
    ...options.map((o) => h('option', { value: o.value }, o.label)));
  // Apres construction des options, sinon la valeur ne « prend » pas.
  if (valeur !== undefined && valeur !== null) select.value = String(valeur);
  return select;
}

export function zoneTexte(attrs = {}) {
  return h('textarea', { class: 'saisie', rows: 3, ...attrs });
}

export function bouton(libelle, surClic, { classe = '', icone: nomIcone = null, titre = null } = {}) {
  return h('button', { type: 'button', class: 'bouton ' + classe, onclick: surClic, title: titre },
    nomIcone ? icone(nomIcone) : null,
    libelle ? h('span', {}, libelle) : null);
}

/** Un etat vide qui dit quoi faire, et pas seulement qu'il n'y a rien. */
export function etatVide(message, action = null) {
  return h('div', { class: 'vide' }, h('p', {}, message), action);
}

export function chargement(message = 'Chargement…') {
  return h('div', { class: 'chargement' }, h('span', {}, message));
}

/**
 * Une tuile d'indicateur.
 *
 * La structure n'est pas libre : la feuille de style attend une étiquette
 * et une valeur, dans cet ordre et sous ces noms. Écrire un <strong> suivi
 * d'un <span> donne deux textes collés l'un à l'autre — « 1 330,00 DHRecettes
 * du mois » — parce qu'aucune règle ne s'applique. Le helper existe pour
 * qu'aucun écran n'ait à s'en souvenir.
 *
 * Les tuiles se posent dans un conteneur « grille c4 chiffres » : c'est
 * « grille » qui les met en rangée, « chiffres » qui aligne les chiffres.
 */
export function tuile(valeur, etiquette, variante = '') {
  return h('div', { class: 'tuile ' + variante },
    h('div', { class: 'etiquette' }, etiquette),
    h('div', { class: 'valeur' }, valeur));
}

/** La rangée d'indicateurs, avec sa grille et son alignement numérique. */
export function rangeeChiffres(...tuiles) {
  return h('section', { class: 'grille c4 chiffres' }, ...tuiles.filter(Boolean));
}

/** Les quatre niveaux d'alerte, leur couleur et leur nom en français. */
const CLASSE_NIVEAU = {
  NORMAL: 'succes',
  ATTENTION: 'attente',
  URGENT: 'accent',
  DEPASSE: 'danger',
};

const LIBELLE_NIVEAU = {
  NORMAL: 'Normal',
  ATTENTION: 'Attention',
  URGENT: 'Urgent',
  DEPASSE: 'Dépassé',
};

export const classeNiveau = (niveau) => CLASSE_NIVEAU[niveau] || '';
export const libelleNiveau = (niveau) => LIBELLE_NIVEAU[niveau] || niveau;

export function pastille(texte, variante = '') {
  return h('span', { class: 'pastille ' + variante }, texte);
}

/**
 * La pastille d'un niveau d'échéance.
 *
 * Elle affiche « Dépassé », jamais « DEPASSE » : le code appartient à
 * l'API, le mot à l'écran.
 */
export function pastilleNiveau(niveau, texte) {
  return pastille(texte ?? libelleNiveau(niveau), classeNiveau(niveau));
}

/**
 * Le compte à rebours d'une échéance, mis en mots (§14, §36).
 *
 * LA FORMULATION VIT ICI, PAS SUR LE SERVEUR.
 *
 * Le serveur rend des NOMBRES — kilomètres restants, jours restants — et
 * le niveau qui en découle. C'est lui qui sait comparer une échéance à un
 * compteur ; ce n'est pas à lui de choisir les mots. Tant que l'application
 * ne parlait que français, la différence ne se voyait pas : en darija, un
 * « Dépassée de 4 300 km » venu du serveur restait français au milieu d'un
 * écran arabe.
 *
 * Le serveur garde ses propres textes pour l'état imprimable, qui est un
 * document français destiné à être classé.
 *
 * @param {{surveille?:boolean, km?:{restant:number}, date?:{restant:number}}|null} etat
 * @returns {Node|null} les deux axes, séparés par un point médian
 */
export function texteEcheance(etat) {
  if (!etat?.surveille) return null;

  const morceaux = [];
  if (etat.km) morceaux.push(texteKilometres(etat.km.restant));
  if (etat.date) morceaux.push(texteJours(etat.date.restant));
  if (!morceaux.length) return null;

  const ligne = h('span', {});
  morceaux.forEach((m, i) => {
    if (i) ligne.append(document.createTextNode(' · '));
    ligne.append(m);
  });
  return ligne;
}

function texteKilometres(restant) {
  if (restant > 0) return h('span', {}, donnee(entier(restant) + ' km'), ' restants');
  if (restant === 0) return h('span', {}, 'Échéance atteinte');
  return h('span', {}, 'Dépassée de ', donnee(entier(Math.abs(restant)) + ' km'));
}

function texteJours(restant) {
  if (restant > 1) return h('span', {}, donnee(restant), ' jours restants');
  if (restant === 1) return h('span', {}, '1 jour restant');
  if (restant === 0) return h('span', {}, 'Échéance aujourd’hui');
  if (restant === -1) return h('span', {}, 'Échue depuis 1 jour');
  return h('span', {}, 'Échue depuis ', donnee(Math.abs(restant)), ' jours');
}

/**
 * Un tableau.
 *
 * SUR TÉLÉPHONE, IL N'EST PLUS UN TABLEAU : chaque ligne devient une carte,
 * et chaque cellule affiche l'en-tête de sa colonne devant sa valeur (voir
 * la feuille de style, section « Téléphone »). C'est pourquoi chaque
 * cellule porte `data-libelle` : sans lui, la carte ne serait qu'une pile
 * de nombres sans nom.
 *
 * Le helper le pose tout seul à partir des colonnes déclarées — un écran
 * qui construit ses lignes à la main doit y penser, lui.
 */
export function tableau(colonnes, lignes, { vide = 'Aucune ligne.' } = {}) {
  if (!lignes.length) return etatVide(vide);
  return h('div', { class: 'table-enveloppe' },
    h('table', { class: 'donnees' },
      h('thead', {}, h('tr', {}, ...colonnes.map((c) =>
        h('th', { class: c.align === 'right' ? 'num' : null }, c.titre)))),
      h('tbody', {}, ...lignes.map((cellules) => h('tr', {},
        ...cellules.map((cellule, i) => {
          if (cellule instanceof HTMLTableCellElement) {
            if (!cellule.dataset.libelle) cellule.dataset.libelle = colonnes[i]?.titre ?? '';
            return cellule;
          }
          return h('td', {
            class: colonnes[i]?.align === 'right' ? 'num' : null,
            dataset: { libelle: colonnes[i]?.titre ?? '' },
          }, cellule);
        }))))));
}
