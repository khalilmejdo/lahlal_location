/**
 * Utilitaires de traitement de texte.
 *
 * La normalisation sert a detecter les doublons du referentiel : le classeur
 * faisait cohabiter "SANLAM " avec espace final, "MED " et "MOHAMED",
 * "EL MILOUD" / "MILOUD" / "ELM" comme s'il s'agissait d'entites distinctes
 * (§6.2). Ici, deux libelles qui se normalisent de la meme facon sont signales
 * comme un doublon probable.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Minuscules, sans accent, espaces compresses. */
export function normalize(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalisation agressive : ne conserve que lettres et chiffres. */
export function normalizeStrict(input) {
  return normalize(input).replace(/[^a-z0-9]/g, '');
}

/** Identifiant technique lisible : "Maroc Assistance" -> "maroc-assistance". */
export function slugify(input, maxLength = 60) {
  const base = normalize(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, maxLength) || 'sans-nom';
}

/** Espaces normalises, sans modification de la casse ni des accents. */
export function cleanSpaces(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/\s+/g, ' ').trim();
}

/**
 * O-7 : retire les octets nuls d'une chaine venue du reseau.
 *
 * PostgreSQL refuse l'octet nul dans une colonne texte — pas au motif d'une
 * regle metier, mais parce que son encodage ne le represente pas. La requete
 * meurt donc en 500, avec une reference d'incident, sur une route ANONYME :
 * il suffisait d'un octet nul dans le message d'un visiteur. Et la classe est
 * plus large que l'audit ne le disait — POST /api/auth/login tombe pareil,
 * son identifiant etant de type « string » et non « text ». Un correctif loge
 * dans un seul convertisseur ne la fermait pas : la coupure se fait donc a
 * l'entree, la ou passent toutes les valeurs de toutes les routes.
 *
 * On retire plutot qu'on ne refuse : un octet nul n'est jamais une intention
 * de saisie, c'est un artefact d'encodage ou une sonde. Refuser rendrait un
 * 400 incomprehensible a un visiteur qui n'a rien tape de tel, et ferait
 * varier la reponse selon la presence du caractere — ce qui renseigne
 * l'attaquant plus surement que de l'ignorer.
 */
const CARACTERE_NUL = String.fromCharCode(0);

export function sansOctetNul(input) {
  if (typeof input !== 'string') return input;
  return input.includes(CARACTERE_NUL) ? input.split(CARACTERE_NUL).join('') : input;
}

/** Majuscules pour une immatriculation ou un code. */
export function upperCode(input) {
  return cleanSpaces(input).toUpperCase();
}

/**
 * Echappement HTML. Utilise par les gabarits d'impression, qui inserent des
 * donnees saisies par l'utilisateur (nom de client, observations) dans du HTML.
 */
export function escapeHtml(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tronque proprement, sur une limite de mot lorsque c'est possible. */
export function truncate(input, maxLength = 80) {
  const text = cleanSpaces(input);
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

/** Initiales d'un nom complet, pour les pastilles d'interface. */
export function initials(fullName) {
  const parts = cleanSpaces(fullName).split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Echappement des caracteres speciaux de LIKE / ILIKE.
 * Sans cela, un utilisateur saisissant "%" dans la recherche obtiendrait
 * toutes les lignes de la table.
 */
export function escapeLike(input) {
  return String(input ?? '').replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Motif ILIKE "contient", prêt à être passe en paramètre lie. */
export function likeContains(input) {
  return '%' + escapeLike(cleanSpaces(input)) + '%';
}

/* ------------------------------------------------------------------ */
/*  Dates                                                              */
/* ------------------------------------------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validé une date ISO "AAAA-MM-JJ" et vérifié qu'elle existe réellement. */
export function isValidIsoDate(input) {
  if (typeof input !== 'string') return false;
  const m = input.match(DATE_RE);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
  );
}

/**
 * Date du jour au format ISO, DANS LE FUSEAU DU SERVEUR.
 *
 * Elle valait `new Date().toISOString().slice(0, 10)`, c'est-a-dire la date
 * UTC. Le defaut que cela produit ne se voit qu'une heure par jour, et il
 * est total : au Maroc (UTC+1), entre minuit et une heure du matin, il est
 * deja demain localement et encore aujourd'hui en UTC. Une activite
 * enregistree a 00 h 30 portait donc une date que le serveur declarait
 * « dans le futur », et le refus etait sec — impossible de saisir la course
 * qu'on vient de finir.
 *
 * Toutes les dates de ce module sont des dates CALENDAIRES, pas des
 * instants : la journee de travail d'un chauffeur n'a rien a voir avec le
 * meridien de Greenwich. Le fuseau se pose par la variable d'environnement
 * TZ (voir .env.example) ; a defaut, c'est celui du systeme.
 */
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** Ajoute un nombre de jours a une date ISO. */
export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Ajoute un nombre de mois a une date ISO, en bornant le quantieme. */
export function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** "2026-08-19" -> "19/08/2026" (format d'affichage marocain). */
export function formatDateFr(isoDate) {
  if (!isoDate) return '';
  const value = String(isoDate).slice(0, 10);
  if (!DATE_RE.test(value)) return String(isoDate);
  const [y, m, d] = value.split('-');
  return d + '/' + m + '/' + y;
}

/** Horodatage lisible : "19/08/2026 a 14:32". */
export function formatDateTimeFr(input) {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    pad(date.getDate()) +
    '/' +
    pad(date.getMonth() + 1) +
    '/' +
    date.getFullYear() +
    ' a ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

/**
 * Restaure le zero initial d'un telephone marocain lu comme un nombre.
 *
 * Un numero marocain compte toujours dix chiffres et commence par 0, mobile
 * ou fixe. Lu comme un nombre plutot que comme du texte — colonne Excel
 * formatee en Nombre, modele de vision qui lit une suite de chiffres comme
 * une valeur — ce zero de tete disparait : « 0684118446 » devient
 * « 684118446 ». Une fois les separateurs retires, neuf chiffres tout
 * numeriques designent donc, sans ambiguite, le meme numero amputé.
 *
 * Trois lectures independantes recreaient cette meme regle (reprise d'une
 * facture papier, import du referentiel clients/chauffeurs, et desormais la
 * reprise d'un classeur d'archives) : elle vit ici, une fois.
 */
export function restituerZeroTelephone(valeur) {
  const t = typeof valeur === 'string' ? valeur.trim() : valeur;
  if (!t) return t || null;
  const compact = String(t).replace(/[\s.\-()]/g, '');
  return /^\d{9}$/.test(compact) ? '0' + compact : String(t);
}

/**
 * I-07 : ce qui peut etre range comme numero de telephone.
 *
 * Le complement de reprise ecrivait la colonne E de la feuille « base » dans
 * clients.phone sans rien regarder : sur un classeur dont une colonne manque
 * ou est en trop, « COLONNE EN TROP » entrait en base comme telephone. Un
 * numero se compose de chiffres et de separateurs usuels, avec au plus un
 * indicatif en tete ; de neuf a quinze chiffres — assez large pour un numero
 * etranger, assez etroit pour refuser un mot.
 */
export function telephonePlausible(valeur) {
  const t = String(valeur ?? '').trim();
  if (!t) return false;
  if (!/^\+?[0-9][0-9\s.\-()/]*$/.test(t)) return false;
  const chiffres = t.replace(/[^0-9]/g, '');
  return chiffres.length >= 9 && chiffres.length <= 15;
}

/**
 * I-22 : une date reconstruite depuis une cellule doit exister au calendrier.
 *
 * « 2026-13-45 » et « 31/02/2026 » traversaient les lecteurs tels quels, la
 * simulation annoncait zero document signale, et Postgres refusait le lot
 * entier (22008) au moment d'ecrire. La regle vit ici, une fois, pour les
 * deux lecteurs de classeur.
 */
export function dateCalendaireValide(annee, mois, jour) {
  const a = Number(annee);
  const m = Number(mois);
  const j = Number(jour);
  if (!Number.isInteger(a) || !Number.isInteger(m) || !Number.isInteger(j)) return false;
  if (m < 1 || m > 12 || j < 1) return false;
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

/**
 * I-24 : un nombre lu dans une cellule de texte.
 *
 * Une espace — ordinaire, insecable ou fine — n'est un separateur de
 * milliers que devant un groupe de trois chiffres : « 12 00 », une frappe
 * pour « 12,00 », devenait 1200, cent fois trop. Un point et une virgule
 * ensemble : le dernier des deux est la decimale (« 1.200,00 » comme
 * « 1,200.00 » valent 1200). Une virgule seule est la decimale, forme du
 * pays ; repetee, elle groupe les milliers. Une devise en queue (DH, DHS,
 * MAD) est ignoree. Tout le reste rend null : un texte n'est pas zero.
 */
export function nombreDepuisTexte(valeur) {
  if (valeur === null || valeur === undefined) return null;
  if (typeof valeur === 'number') return Number.isFinite(valeur) ? valeur : null;
  let t = String(valeur).trim().replace(/\s*(DHS?|MAD)\.?$/i, '').trim();
  if (!t) return null;

  if (/\d[\s\u00a0\u202f]\d/.test(t)) {
    if (!/^-?\d{1,3}([\s\u00a0\u202f]\d{3})+([.,]\d+)?$/.test(t)) return null;
    t = t.replace(/[\s\u00a0\u202f]/g, '');
  }

  const groupesDeTrois = (parties) => parties.slice(1).every((g) => g.length === 3);
  const point = t.lastIndexOf('.');
  const virgule = t.lastIndexOf(',');
  if (point !== -1 && virgule !== -1) {
    const decimale = point > virgule ? '.' : ',';
    const groupe = decimale === '.' ? ',' : '.';
    if (!groupesDeTrois(t.split(decimale)[0].split(groupe))) return null;
    t = t.split(groupe).join('').replace(',', '.');
  } else if (virgule !== -1) {
    const parties = t.split(',');
    if (parties.length > 2) {
      if (!groupesDeTrois(parties)) return null;
      t = parties.join('');
    } else {
      t = t.replace(',', '.');
    }
  } else if (point !== -1) {
    const parties = t.split('.');
    if (parties.length > 2) {
      if (!groupesDeTrois(parties)) return null;
      t = parties.join('');
    }
  }

  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
