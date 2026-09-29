/**
 * Arithmetique monetaire.
 *
 * Aucun calcul n'utilise de nombre a virgule flottante : les montants sont des
 * entiers de centimes (1 035,50 DH -> 103550). C'est ce qui garantit que le
 * resultat affiche — recette moins depense — tombe au centime, quel que soit
 * le nombre d'activites additionnees.
 *
 * PAS DE TVA ICI, VOLONTAIREMENT
 * ------------------------------
 * lahlal_samuplus porte un barème de TVA, des taux en points de base et une
 * comptabilite officielle. Rien de tout cela n'a sa place dans ce module : le
 * cahier des charges (§7) demande explicitement de n'enregistrer que des
 * depenses reellement engagees et des recettes reellement percues, sans
 * aucun calcul fiscal. Reprendre le barème « au cas ou » aurait fabrique une
 * comptabilite que personne n'a demandee — et donne a ces montants une
 * apparence officielle qu'ils n'ont pas.
 */

export const CENTS = 100;

/* ------------------------------------------------------------------ */
/*  Arrondis                                                           */
/* ------------------------------------------------------------------ */

/** Arrondi commercial : la moitie s'eloigne de zero (2,5 -> 3 ; -2,5 -> -3). */
export function roundHalfUp(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/* ------------------------------------------------------------------ */
/*  Montants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Un debordement n'est pas un montant : il se refuse (null), comme une saisie
 * illisible. Reprise de lahlal_samuplus (C-08) : roundHalfUp(Infinity) rend 0,
 * et un montant demesure devenait zero sans un mot.
 */
function centimesFinis(valeur) {
  return Number.isFinite(valeur) ? roundHalfUp(valeur) : null;
}

/**
 * Convertit une saisie utilisateur en centimes.
 * Accepte "1 035,50", "1035.5", "1'035.50", 1035.5. Retourne null si invalide.
 * @returns {number|null}
 */
export function parseAmountToCents(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return centimesFinis(input * CENTS);
  }
  const cleaned = String(input)
    .replace(/[\s '`  ]/g, '')
    .replace(',', '.');
  if (!/^-?\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.' || cleaned === '-') {
    return null;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return centimesFinis(n * CENTS);
}

/** Formate des centimes en chaine francaise : 103550 -> "1 035,50". */
export function formatCents(cents, opts = {}) {
  const { withCurrency = false, currency = 'DH' } = opts;
  const value = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const negative = value < 0;
  const abs = Math.abs(value);
  const units = Math.trunc(abs / CENTS);
  const decimals = String(abs % CENTS).padStart(2, '0');
  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const text = (negative ? '-' : '') + grouped + ',' + decimals;
  return withCurrency ? text + ' ' + currency : text;
}

/**
 * Le resultat d'une activite, signe.
 *
 * Une seule definition, ici, pour l'ecran comme pour le serveur comme pour
 * l'export : c'est la seule facon que le « +200 DH » de la fiche soit le meme
 * nombre que celui du tableau de bord et que celui du fichier Excel.
 */
export const resultatCents = (recetteCents, depenseCents) =>
  Math.trunc(recetteCents || 0) - Math.trunc(depenseCents || 0);

/** Centimes -> nombre decimal (export CSV/Excel, API). */
export const centsToNumber = (cents) => Math.trunc(cents || 0) / CENTS;

/**
 * La borne haute d'un montant saisissable : dix millions de dirhams.
 *
 * Elle n'est pas decorative. Sans elle, une saisie de dix-huit chiffres passe
 * en base — BIGINT l'accepte — et fausse toutes les sommes de la periode sans
 * qu'aucun ecran ne la signale comme aberrante.
 */
export const MONTANT_MAX_CENTS = 1000000000;
