/**
 * Les pieces jointes : ce qui est accepte, et ce qui ne l'est pas.
 *
 * Repris de lahlal_samuplus, ou la regle tient en une phrase :
 *
 *     LE TYPE D'UN FICHIER EST CELUI DE SES OCTETS, JAMAIS CELUI DE SON NOM.
 *
 * Ni l'extension ni le Content-Type annonce par le navigateur ne sont
 * consultes pour decider. Tous deux sont ecrits par le client, donc par
 * quiconque sait former une requete : un script renomme « recu.jpg » et
 * annonce « image/jpeg » passerait les deux controles.
 *
 * Ce module est pur — il prend un tampon, il rend un verdict — pour que la
 * regle s'exerce sans serveur, sans base et sans fichier sur le disque.
 */

import { config } from '../core/config.js';

/* ------------------------------------------------------------------ */
/*  Signatures binaires                                                */
/* ------------------------------------------------------------------ */

/**
 * Les formats acceptes, et comment on les reconnait.
 *
 * `previsualisable` dit si un navigateur sait afficher une miniature du
 * fichier (§30). Le HEIC est accepte — c'est le format natif des photos
 * d'iPhone, et refuser la photo d'un compteur parce qu'elle vient d'un
 * iPhone n'aurait aucun sens — mais aucun navigateur hors Safari ne sait le
 * peindre : il recoit donc l'icone generique, comme un PDF.
 */
export const SIGNATURES = [
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    previsualisable: true,
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    ext: 'png',
    previsualisable: true,
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    previsualisable: true,
    test: (b) =>
      b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mime: 'image/heic',
    ext: 'heic',
    previsualisable: false,
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' &&
      ['heic', 'heix', 'mif1', 'heim', 'hevc', 'heis'].includes(b.toString('ascii', 8, 12)),
  },
  {
    mime: 'application/pdf',
    ext: 'pdf',
    previsualisable: false,
    test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  },
];

const PAR_MIME = new Map(SIGNATURES.map((s) => [s.mime, s]));

/** Le navigateur sait-il peindre une miniature de ce type ? */
export const estPrevisualisable = (mime) => PAR_MIME.get(mime)?.previsualisable === true;

/**
 * Le type reel d'un tampon, ou null si aucune signature ne correspond.
 *
 * Douze octets sont necessaires : c'est ce qu'exige la plus longue des
 * signatures (RIFF....WEBP). Un fichier plus court n'est aucun des formats
 * acceptes, quel que soit son nom.
 */
export function detecterType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buffer)) || null;
}

/* ------------------------------------------------------------------ */
/*  Le nom du fichier                                                  */
/* ------------------------------------------------------------------ */

/**
 * Un nom de fichier sur lequel on peut compter.
 *
 * Le nom d'origine n'est conserve que pour etre RE-AFFICHE et propose au
 * telechargement ; il ne sert jamais a construire un chemin — les pieces
 * vivent en base, pas sur le disque. Il est malgre tout nettoye :
 *
 *   - les separateurs de chemin, pour qu'un « ../../etc/passwd » recopie
 *     dans un en-tete Content-Disposition ne ressemble a rien d'exploitable ;
 *   - l'octet nul, qui tronque les chaines en C et a servi mille fois a
 *     faire passer « x.php\0.jpg » pour une image ;
 *   - les caracteres de controle, qui permettraient d'injecter un retour a
 *     la ligne dans un en-tete HTTP.
 *
 * L'extension est REECRITE d'apres le type reel detecte : un PDF renomme
 * « photo.jpg » sera restitue en « photo.pdf ».
 */
export function nomSur(nomOrigine, extension) {
  const brut = String(nomOrigine ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '-')
    .replace(/^\.+/, '')
    .trim();

  // On retire l'extension annoncee, quelle qu'elle soit : c'est le type reel
  // qui decide de celle qui sera rendue.
  const sansExt = brut.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();
  const base = (sansExt || 'piece-jointe').slice(0, 80);
  return base + '.' + extension;
}

/* ------------------------------------------------------------------ */
/*  Le verdict complet                                                 */
/* ------------------------------------------------------------------ */

/** Nombre maximal de pieces par envoi. Une activite peut en porter plus : */
/*  c'est la taille d'UN envoi qui est bornee, pas celle du dossier.        */
export const MAX_FICHIERS_PAR_ENVOI = 8;

/**
 * @typedef {object} Verdict
 * @property {boolean} ok
 * @property {string}  [motif]   pourquoi c'est refuse, en clair
 * @property {string}  [code]    TROP_GROS | VIDE | TYPE_REFUSE
 * @property {object}  [fichier] le descriptif retenu, si accepte
 */

/**
 * Examine un fichier recu.
 *
 * `content` est le nom que porte le tampon dans les parties multipart
 * (server/http/body.js) ; `buffer` est accepte pour que les essais puissent
 * appeler la fonction sans imiter la forme du corps HTTP.
 *
 * @param {{filename?:string, content?:Buffer, buffer?:Buffer}} recu
 * @param {number} [tailleMax]  defaut : config.storage.maxUploadBytes
 * @returns {Verdict}
 */
export function examiner(recu, tailleMax = config.storage.maxUploadBytes) {
  const buffer = recu?.content ?? recu?.buffer;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, code: 'VIDE', motif: 'Le fichier est vide.' };
  }

  // La taille d'abord : inutile d'inspecter cent mégaoctets pour decouvrir
  // ensuite qu'ils sont refuses.
  if (buffer.length > tailleMax) {
    return {
      ok: false,
      code: 'TROP_GROS',
      motif:
        'Le fichier pèse ' + mo(buffer.length) + ' ; la limite est de ' + mo(tailleMax) + '. ' +
        'Reprenez la photo en qualité moindre, ou envoyez-la en plusieurs fois.',
    };
  }

  const type = detecterType(buffer);
  if (!type) {
    return {
      ok: false,
      code: 'TYPE_REFUSE',
      motif:
        'Ce fichier n’est ni une photo (JPEG, PNG, WEBP, HEIC) ni un PDF. ' +
        'Son extension n’y change rien : c’est son contenu qui est examiné.',
    };
  }

  return {
    ok: true,
    fichier: {
      nom: nomSur(recu.filename, type.ext),
      mime: type.mime,
      taille: buffer.length,
      previsualisable: type.previsualisable,
      buffer,
    },
  };
}

/** « 12,4 Mo », « 840 Ko » — pour un message lisible par qui n'est pas informaticien. */
function mo(octets) {
  if (octets >= 1024 * 1024) {
    return (octets / (1024 * 1024)).toFixed(1).replace('.', ',') + ' Mo';
  }
  return Math.round(octets / 1024) + ' Ko';
}
