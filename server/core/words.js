/**
 * RG-12 : conversion d'un montant en toutes lettres.
 *
 * Portage de la fonction VBA `chiffrelettre()` du classeur d'origine, avec deux
 * corrections par rapport a celle-ci :
 *   1. la mention des centimes n'apparait que lorsqu'ils sont reellement non
 *      nuls (le code VBA les ajoutait dans certaines branches meme a zero) ;
 *   2. les accords du francais sont appliques systematiquement
 *      (quatre-vingts, deux cents, soixante et onze, millions au pluriel).
 *
 * Le resultat est genere par le serveur et n'est jamais saisissable : c'est ce
 * qui evite le cas de la facture "Lahrach" du classeur, dont le montant en
 * lettres avait ete tape a la main et ne correspondait pas au total.
 */

const UNITS = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
];

const TENS = {
  2: 'vingt',
  3: 'trente',
  4: 'quarante',
  5: 'cinquante',
  6: 'soixante',
};

/** Echelles longues : le rang 1 (mille) est invariable, les suivants s'accordent. */
const SCALES = [
  { singular: '', plural: '', invariable: true },
  { singular: 'mille', plural: 'mille', invariable: true },
  { singular: 'million', plural: 'millions', invariable: false },
  { singular: 'milliard', plural: 'milliards', invariable: false },
  { singular: 'billion', plural: 'billions', invariable: false },
  { singular: 'billiard', plural: 'billiards', invariable: false },
];

/* ------------------------------------------------------------------ */

/** 0 a 99 en lettres. */
function belowHundred(n) {
  if (n <= 16) return UNITS[n];

  if (n < 20) return 'dix-' + UNITS[n - 10];

  const tens = Math.floor(n / 10);
  const units = n % 10;

  // 70-79 et 90-99 se construisent sur soixante et quatre-vingt.
  if (tens === 7 || tens === 9) {
    const base = tens === 7 ? 'soixante' : 'quatre-vingt';
    const rest = n - (tens === 7 ? 60 : 80);
    // 71 s'ecrit « soixante et onze », mais 91 s'ecrit « quatre-vingt-onze » :
    // la liaison « et » ne se fait que sur la dizaine soixante.
    if (tens === 7 && rest === 11) return 'soixante et onze';
    return base + '-' + belowHundred(rest);
  }

  if (tens === 8) {
    if (units === 0) return 'quatre-vingts';
    return 'quatre-vingt-' + UNITS[units];
  }

  const word = TENS[tens];
  if (units === 0) return word;
  // "et un" pour 21, 31, 41, 51, 61 uniquement.
  if (units === 1) return word + ' et un';
  return word + '-' + UNITS[units];
}

/**
 * 0 a 999 en lettres.
 * @param {number} n
 * @param {boolean} allowPluralCent  autorise l'accord de "cent" au pluriel
 */
function belowThousand(n, allowPluralCent) {
  if (n < 100) return belowHundred(n);

  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const prefix = hundreds === 1 ? 'cent' : UNITS[hundreds] + ' cent';

  if (rest === 0) {
    // "deux cents" mais "deux cent mille" : le pluriel tombe si un mot suit.
    return hundreds > 1 && allowPluralCent ? prefix + 's' : prefix;
  }
  return prefix + ' ' + belowHundred(rest);
}

/**
 * Convertit un entier positif en lettres.
 * @param {number} value entier >= 0
 * @returns {string}
 */
export function integerToWords(value) {
  const n = Math.trunc(Math.abs(Number(value) || 0));
  if (n === 0) return 'zéro';

  // Decoupage en groupes de trois chiffres, du plus faible au plus fort.
  const groups = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  if (groups.length > SCALES.length) return String(n); // garde-fou : hors echelle

  const parts = [];
  for (let rank = groups.length - 1; rank >= 0; rank--) {
    const group = groups[rank];
    if (group === 0) continue;

    const scale = SCALES[rank];

    // "mille" et non "un mille" ; en revanche "un million" est correct.
    if (rank === 1 && group === 1) {
      parts.push('mille');
      continue;
    }

    // Le pluriel de "cent" tombe devant "mille" mais se maintient devant
    // "millions" (nom) et en fin de nombre.
    const allowPluralCent = rank !== 1;
    const words = belowThousand(group, allowPluralCent);

    if (rank === 0) {
      parts.push(words);
    } else {
      const scaleWord = scale.invariable || group === 1 ? scale.singular : scale.plural;
      parts.push(words + ' ' + scaleWord);
    }
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/*  Montants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Montant en centimes -> montant en toutes lettres, en dirhams et centimes.
 *
 *   103550  -> "mille trente-cinq dirhams et cinquante centimes"
 *    40000  -> "quatre cents dirhams"
 *      100  -> "un dirham"
 *        0  -> "zéro dirham"
 *
 * @param {number} cents
 * @param {{ currency?: string, capitalize?: boolean }} [opts]
 * @returns {string}
 */
export function amountToWords(cents, opts = {}) {
  const { currency = 'dirham', capitalize = true } = opts;

  const total = Math.trunc(Number(cents) || 0);
  const negative = total < 0;
  const abs = Math.abs(total);

  const units = Math.floor(abs / 100);
  const decimals = abs % 100;

  const unitWord = units > 1 ? currency + 's' : currency;
  const lettres = integerToWords(units);

  // « Deux millions DE dirhams », et non « deux millions dirhams ».
  //
  // En francais, un nom de nombre — million, milliard — devient un nom
  // commun lorsque rien ne le suit, et appelle alors « de » devant l'unite.
  // Des qu'un autre chiffre s'intercale, la preposition disparait : « huit
  // millions deux cent quatorze mille dirhams ». C'est une mention legale
  // portee par chaque facture (RG-12) : elle doit se lire correctement.
  const echelleNue = /(millions?|milliards?)$/.test(lettres);
  let text = lettres + (echelleNue ? ' de ' : ' ') + unitWord;

  // Les centimes ne sont mentionnes que s'ils existent (correction RG-12).
  if (decimals > 0) {
    text += ' et ' + integerToWords(decimals) + (decimals > 1 ? ' centimes' : ' centime');
  }

  if (negative) text = 'moins ' + text;

  return capitalize ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
