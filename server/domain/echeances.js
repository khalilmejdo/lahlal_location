/**
 * Les echeances, le compte a rebours et les quatre niveaux d'alerte.
 *
 * C'est le coeur du module, et tout y est PUR : aucune lecture de base,
 * aucune date implicite, aucun seuil code en dur. La consequence est qu'on
 * peut exercer la regle complete — « a 162 300 km la vidange passe au
 * rouge » — sans demarrer ni serveur ni PostgreSQL.
 *
 * Trois idees le structurent.
 *
 * 1. UNE ECHEANCE A DEUX AXES, ET ILS SONT INDEPENDANTS (§9).
 *    Un kilometrage, une date, ou les deux. Une vidange n'a qu'un
 *    kilometrage, une assurance n'a qu'une date, une revision a les deux.
 *    Chaque axe se calcule pour lui-meme, puis le niveau retenu est le PIRE
 *    des deux : « l'alerte est declenchee des qu'UNE des deux conditions
 *    arrive a echeance ».
 *
 * 2. L'INTERVALLE PROPOSE, IL N'IMPOSE PAS (§11, §12).
 *    Une vidange faite a 150 000 km avec un intervalle de 10 000 propose
 *    160 000. Si l'utilisateur ecrit 158 000, c'est 158 000 qui s'applique,
 *    et rien ne la ramenera a 160 000 par la suite. Les deux colonnes
 *    `prochain_km` et `prochaine_date` font foi ; les intervalles ne servent
 *    qu'a les pre-remplir.
 *
 * 3. LES SEUILS SONT DES DONNEES, PAS DU CODE (§15, regle 17).
 *    Ils arrivent en argument, lus de la table `settings`. Les valeurs de
 *    ce fichier ne sont que le repli du premier demarrage.
 */

import { addMonths, isValidIsoDate } from '../core/text.js';

/* ------------------------------------------------------------------ */
/*  Les quatre niveaux                                                 */
/* ------------------------------------------------------------------ */

export const NIVEAUX = ['NORMAL', 'ATTENTION', 'URGENT', 'DEPASSE'];

/** Du plus calme au plus grave : sert a retenir le pire de deux axes. */
const GRAVITE = { NORMAL: 0, ATTENTION: 1, URGENT: 2, DEPASSE: 3 };

export const LIBELLES_NIVEAU = {
  NORMAL: 'Normal',
  ATTENTION: 'Attention',
  URGENT: 'Urgent',
  DEPASSE: 'Dépassé',
};

/** Le pire de plusieurs niveaux. Sans aucun, « NORMAL ». */
export const pireNiveau = (...niveaux) =>
  niveaux
    .filter((n) => n && GRAVITE[n] !== undefined)
    .reduce((pire, n) => (GRAVITE[n] > GRAVITE[pire] ? n : pire), 'NORMAL');

/* ------------------------------------------------------------------ */
/*  Les seuils                                                         */
/* ------------------------------------------------------------------ */

/**
 * Les seuils par defaut, ceux du cahier des charges (§15).
 *
 * « attention » est la distance a partir de laquelle on commence a regarder,
 * « urgent » celle a partir de laquelle il faut agir. En dessous de zero,
 * l'echeance est passee et le niveau ne se discute plus.
 */
export const SEUILS_PAR_DEFAUT = Object.freeze({
  kmAttention: 2000,
  kmUrgent: 500,
  joursAttention: 30,
  joursUrgent: 15,
  // De combien le compteur peut reculer sans que l'application s'en emeuve.
  // Zero : le moindre recul demande confirmation (§4).
  reculToleKm: 0,
});

/**
 * Bornes de chaque seuil. Une valeur hors bornes vaut absent : une saisie
 * aberrante ne s'applique pas au pretexte qu'elle a ete ecrite. C'est la
 * regle deja retenue dans lahlal_samuplus pour la posture de securite.
 */
export const BORNES_SEUILS = Object.freeze({
  kmAttention: { cle: 'alerte.km_attention', min: 100, max: 100000 },
  kmUrgent: { cle: 'alerte.km_urgent', min: 0, max: 50000 },
  joursAttention: { cle: 'alerte.jours_attention', min: 1, max: 365 },
  joursUrgent: { cle: 'alerte.jours_urgent', min: 0, max: 180 },
  reculToleKm: { cle: 'kilometrage.tolerance_recul', min: 0, max: 10000 },
});

/**
 * Construit les seuils a partir des lignes brutes de `settings`.
 *
 * Fonction pure : elle se verifie sans base, ce qui compte pour des reglages
 * dont une erreur ferait taire une alerte au lieu de la lever.
 *
 * @param {Array<{key:string,value:string}>|Map<string,string>|null} lignes
 */
export function lireSeuils(lignes) {
  const brut = lignes instanceof Map
    ? lignes
    : new Map((Array.isArray(lignes) ? lignes : []).map((l) => [l.key, l.value]));

  const sortie = { ...SEUILS_PAR_DEFAUT };
  for (const [champ, regle] of Object.entries(BORNES_SEUILS)) {
    const n = Number.parseInt(String(brut.get(regle.cle) ?? '').trim(), 10);
    if (Number.isFinite(n) && n >= regle.min && n <= regle.max) sortie[champ] = n;
  }

  // Un seuil « urgent » plus lointain que le seuil « attention » inverserait
  // les couleurs : on passerait au rouge avant l'orange, puis on reviendrait
  // a l'orange en se rapprochant. Plutot que de refuser la configuration, on
  // rabat l'urgent sur l'attention — le pire qui puisse alors arriver est de
  // perdre le palier intermediaire, jamais de perdre l'alerte.
  if (sortie.kmUrgent > sortie.kmAttention) sortie.kmUrgent = sortie.kmAttention;
  if (sortie.joursUrgent > sortie.joursAttention) sortie.joursUrgent = sortie.joursAttention;

  return sortie;
}

/* ------------------------------------------------------------------ */
/*  Le niveau d'un axe                                                 */
/* ------------------------------------------------------------------ */

/**
 * Le niveau atteint par une distance restante, kilometres ou jours.
 *
 * ZERO EST DEJA DEPASSE, et c'est un choix.
 *
 * Le cahier des charges est explicite pour le kilometrage (§47) : lorsque le
 * vehicule ATTEINT 162 300 km, la vidange doit s'afficher en rouge. Zero
 * kilometre restant n'est donc pas « il reste zero » mais « c'est
 * maintenant ». La meme regle vaut pour les dates, par coherence : une
 * echeance du jour se montre en rouge plutot qu'en orange. L'ecart
 * qu'introduirait la regle inverse — une assurance encore valable le dernier
 * jour — se paie d'un jour d'avance sur le rappel, ce qui est le bon sens du
 * cote ou l'on se trompe.
 *
 * @param {number} restant  kilometres ou jours restants, negatif si passe
 * @param {{attention:number,urgent:number}} seuils
 */
export function niveauPourRestant(restant, seuils) {
  if (!Number.isFinite(restant)) return 'NORMAL';
  if (restant <= 0) return 'DEPASSE';
  if (restant < seuils.urgent) return 'URGENT';
  if (restant <= seuils.attention) return 'ATTENTION';
  return 'NORMAL';
}

/** Nombre de jours entiers entre deux dates ISO (b - a). */
export function joursEntre(a, b) {
  if (!isValidIsoDate(a) || !isValidIsoDate(b)) return null;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const msA = Date.UTC(ya, ma - 1, da);
  const msB = Date.UTC(yb, mb - 1, db);
  return Math.round((msB - msA) / 86400000);
}

/* ------------------------------------------------------------------ */
/*  L'etat complet d'une echeance                                      */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} AxeEcheance
 * @property {number}  restant  kilometres ou jours restants (negatif si passe)
 * @property {string}  niveau   NORMAL | ATTENTION | URGENT | DEPASSE
 * @property {string}  texte    « 1 250 km restants », « Échue depuis 3 jours »
 */

/**
 * L'etat d'un entretien : ses deux axes, et le niveau retenu.
 *
 * @param {object} entretien
 * @param {number|null} entretien.prochainKm
 * @param {string|null} entretien.prochaineDate      ISO
 * @param {string}      [entretien.statut]           CLOS : plus de surveillance
 * @param {number|null} kilometrageActuel            celui du vehicule, vue v_vehicules
 * @param {string}      aujourdHui                   date ISO, passee explicitement
 * @param {object}      seuils                       cf. lireSeuils()
 * @returns {{niveau:string, km:AxeEcheance|null, date:AxeEcheance|null, surveille:boolean}}
 */
export function etatEcheance(entretien, kilometrageActuel, aujourdHui, seuils = SEUILS_PAR_DEFAUT) {
  const vide = { niveau: 'NORMAL', km: null, date: null, surveille: false };

  // Un entretien clos ne surveille plus rien : il reste dans l'historique,
  // il sort des alertes.
  if (!entretien || entretien.statut === 'CLOS') return vide;

  let km = null;
  const prochainKm = entierOuNull(entretien.prochainKm);
  if (prochainKm !== null && Number.isFinite(kilometrageActuel)) {
    const restant = prochainKm - kilometrageActuel;
    km = {
      restant,
      niveau: niveauPourRestant(restant, {
        attention: seuils.kmAttention,
        urgent: seuils.kmUrgent,
      }),
      texte: texteKm(restant),
    };
  }

  let date = null;
  const prochaineDate = entretien.prochaineDate ? String(entretien.prochaineDate).slice(0, 10) : null;
  if (prochaineDate && isValidIsoDate(prochaineDate) && isValidIsoDate(aujourdHui)) {
    const restant = joursEntre(aujourdHui, prochaineDate);
    date = {
      restant,
      niveau: niveauPourRestant(restant, {
        attention: seuils.joursAttention,
        urgent: seuils.joursUrgent,
      }),
      texte: texteJours(restant),
    };
  }

  // Aucun axe exploitable : l'entretien declare une echeance kilometrique
  // mais le vehicule n'a aucun releve, par exemple. Il n'est pas « normal »,
  // il n'est simplement pas surveillable — et le dire evite de le compter
  // comme sain dans le tableau de bord.
  if (!km && !date) return vide;

  return {
    niveau: pireNiveau(km?.niveau, date?.niveau),
    km,
    date,
    surveille: true,
  };
}

const entierOuNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Espace fine insecable entre les milliers, comme partout ailleurs. */
const groupe = (n) => String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function texteKm(restant) {
  if (restant > 0) return groupe(restant) + ' km restants';
  if (restant === 0) return 'Échéance atteinte';
  return 'Dépassée de ' + groupe(restant) + ' km';
}

function texteJours(restant) {
  if (restant > 1) return restant + ' jours restants';
  if (restant === 1) return '1 jour restant';
  if (restant === 0) return 'Échéance aujourd’hui';
  if (restant === -1) return 'Échue depuis 1 jour';
  return 'Échue depuis ' + Math.abs(restant) + ' jours';
}

/* ------------------------------------------------------------------ */
/*  Proposer la prochaine echeance                                     */
/* ------------------------------------------------------------------ */

/**
 * Ce que le formulaire PROPOSE apres une realisation (§11, §34).
 *
 * L'appelant est libre de ne pas s'en servir : si l'utilisateur a saisi une
 * valeur, c'est la sienne qui part en base. Cette fonction ne decide rien,
 * elle pre-remplit.
 *
 * @param {{km?:number|null, date?:string|null, intervalleKm?:number|null, intervalleMois?:number|null}} realisation
 * @returns {{prochainKm:number|null, prochaineDate:string|null}}
 */
export function prochaineEcheanceProposee({ km = null, date = null, intervalleKm = null, intervalleMois = null } = {}) {
  const base = entierOuNull(km);
  const pasKm = entierOuNull(intervalleKm);
  const pasMois = entierOuNull(intervalleMois);

  return {
    prochainKm: base !== null && pasKm !== null && pasKm > 0 ? base + pasKm : null,
    prochaineDate:
      date && isValidIsoDate(String(date).slice(0, 10)) && pasMois !== null && pasMois > 0
        ? addMonths(String(date).slice(0, 10), pasMois)
        : null,
  };
}

/* ------------------------------------------------------------------ */
/*  La coherence du kilometrage                                        */
/* ------------------------------------------------------------------ */

/**
 * Le kilometrage saisi est-il en recul sur ce que l'on sait deja ? (§4)
 *
 * On ne REFUSE pas : un compteur se remplace, un releve se corrige, une
 * saisie ancienne peut etre fausse. On demande confirmation, et l'on garde
 * la trace que la valeur a ete forcee.
 *
 * Rend null quand il n'y a rien a signaler.
 *
 * @param {number|null} saisi
 * @param {number|null} dernierConnu
 * @param {number} tolerance  cf. seuils.reculToleKm
 * @returns {{ecart:number, message:string}|null}
 */
export function reculKilometrage(saisi, dernierConnu, tolerance = 0) {
  const a = entierOuNull(saisi);
  const b = entierOuNull(dernierConnu);
  if (a === null || b === null) return null;
  const ecart = b - a;
  if (ecart <= tolerance) return null;
  return {
    ecart,
    message:
      'Le dernier kilométrage connu est ' + groupe(b) + ' km, et vous saisissez ' +
      groupe(a) + ' km, soit ' + groupe(ecart) + ' km de moins. ' +
      'Confirmez si le compteur a été remplacé ou si un relevé précédent était erroné.',
  };
}

/**
 * Un saut en avant demesure est tout aussi suspect qu'un recul.
 *
 * Il n'est pas dans le cahier des charges, mais c'est la meme faute de
 * frappe vue dans l'autre sens : 1 523 000 pour 152 300. Un chiffre en trop
 * et le vehicule paraitrait avoir depasse toutes ses echeances d'un coup —
 * exactement l'inverse de ce que ces alertes doivent produire.
 *
 * Le seuil est volontairement large : on ne vise que l'aberration.
 */
export const SAUT_KM_SUSPECT = 50000;

export function sautKilometrage(saisi, dernierConnu, seuil = SAUT_KM_SUSPECT) {
  const a = entierOuNull(saisi);
  const b = entierOuNull(dernierConnu);
  if (a === null || b === null) return null;
  const ecart = a - b;
  if (ecart <= seuil) return null;
  return {
    ecart,
    message:
      'Vous saisissez ' + groupe(a) + ' km, soit ' + groupe(ecart) + ' km de plus que le ' +
      'dernier relevé (' + groupe(b) + ' km). Vérifiez la saisie avant de confirmer.',
  };
}

/* ------------------------------------------------------------------ */
/*  Rendu pour l'ecran                                                 */
/* ------------------------------------------------------------------ */

/**
 * La ligne d'alerte telle que la notification et le tableau de bord
 * l'affichent (§13, §24).
 *
 * Elle vit ici, avec le calcul, plutot que dans chaque vue : les trois
 * ecrans qui la montrent diraient sinon trois choses differentes du meme
 * entretien.
 */
export function libelleAlerte(entretien, etat) {
  if (!etat?.surveille) return null;
  const parties = [];
  if (etat.km) parties.push(etat.km.texte);
  if (etat.date) parties.push(etat.date.texte);
  return {
    niveau: etat.niveau,
    titre: entretien.libelle,
    detail: parties.join(' · '),
  };
}
