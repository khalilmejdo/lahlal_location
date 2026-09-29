/**
 * Primitives cryptographiques de l'application.
 *
 * Tout repose sur node:crypto : aucune dependance externe n'est impliquee
 * dans la protection des mots de passe ou des sessions.
 *
 *  - Mots de passe : scrypt (memory-hard) + sel aleatoire + poivre applicatif.
 *  - Jetons        : 256 bits d'entropie, stockes uniquement sous forme de
 *                    condensat SHA-256 (un vol de base ne donne pas de session).
 *  - Empreintes    : SHA-256, pour verifier qu'une piece jointe restituee est
 *                    bien celle qui a ete televersee.
 *
 * CE QUI N'EST PAS REPRIS DE lahlal_samuplus, ET POURQUOI
 * -------------------------------------------------------
 * Le socle porte un chiffrement AES-256-GCM, un index aveugle HMAC et un
 * masquage « phi.view ». Tout cela protege le nom d'un beneficiaire de
 * transport sanitaire — une donnee de sante. Ce module ne manipule aucune
 * donnee de cette nature : des immatriculations, des kilometrages, des
 * montants. Reprendre la machinerie aurait ajoute une cle a gerer, une
 * rotation a conduire et un masque a tester, pour ne rien proteger de plus.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

/* ------------------------------------------------------------------ */
/*  Derivation des cles                                                */
/* ------------------------------------------------------------------ */

let cachedKeys = null;

function keys() {
  if (cachedKeys) return cachedKeys;
  const secret = Buffer.from(config.security.secret, 'hex');
  cachedKeys = {
    // Cle de signature derivee par HKDF plutot que le secret brut : un usage
    // ne peut pas contaminer l'autre le jour ou un second en apparait.
    signKey: Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'flotte:sign:v1', 32)),
    pepper: Buffer.from(config.security.passwordPepper, 'hex'),
  };
  return cachedKeys;
}

/* ------------------------------------------------------------------ */
/*  Comparaisons et jetons                                             */
/* ------------------------------------------------------------------ */

/** Comparaison a temps constant de deux chaines. */
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // On compare quand meme pour ne pas fuir la longueur par le temps de reponse.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Jeton opaque aleatoire, encode en base64url. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Code numerique aleatoire non biaise (mot de passe temporaire). */
export function randomDigits(length = 6) {
  let out = '';
  while (out.length < length) out += String(crypto.randomInt(0, 10));
  return out;
}

/** Condensat d'un jeton, tel que stocke en base. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** SHA-256 d'un contenu binaire ou texte (empreinte d'une piece jointe). */
export function sha256(data) {
  return crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'))
    .digest('hex');
}

/** HMAC-SHA-256 signe avec la cle de signature applicative. */
export function sign(value) {
  return crypto.createHmac('sha256', keys().signKey).update(String(value), 'utf8').digest('base64url');
}

/** Verifie une signature HMAC a temps constant. */
export function verifySignature(value, signature) {
  return timingSafeEqual(sign(value), signature);
}

/* ------------------------------------------------------------------ */
/*  Mots de passe : scrypt                                             */
/* ------------------------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
// scrypt consomme environ 128 * N * r octets ; on autorise explicitement
// cette empreinte, la valeur par defaut de Node etant trop basse.
const SCRYPT_MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

function scryptDerive(password, salt, params) {
  // Le poivre est concatene au mot de passe : il n'est pas stocke en base,
  // donc un vol de la seule base ne permet pas d'attaquer les condensats.
  const material = Buffer.concat([Buffer.from(String(password), 'utf8'), keys().pepper]);
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      material,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
}

/**
 * Calcule le condensat d'un mot de passe.
 * Format stocke : scrypt$N$r$p$sel_b64$condensat_b64
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptDerive(password, salt, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verifie un mot de passe. Ne leve jamais : retourne false en cas de format
 * inattendu, pour ne pas transformer une donnee corrompue en erreur 500.
 */
export async function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const params = {
      N: Number.parseInt(parts[1], 10),
      r: Number.parseInt(parts[2], 10),
      p: Number.parseInt(parts[3], 10),
      keylen: 32,
    };
    if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
      return false;
    }
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const derived = await scryptDerive(password, salt, { ...params, keylen: expected.length });
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Indique si un condensat a ete produit avec des parametres obsoletes. */
export function needsRehash(stored) {
  if (typeof stored !== 'string') return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number.parseInt(parts[1], 10) < SCRYPT.N;
}

/* ------------------------------------------------------------------ */
/*  Identifiants                                                       */
/* ------------------------------------------------------------------ */

/**
 * UUID v7 : identifiant unique dont les 48 premiers bits sont l'horodatage.
 * Les cles primaires restent ainsi ordonnees chronologiquement, ce qui evite
 * la fragmentation des index PostgreSQL propre aux UUID v4.
 */
export function newId() {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
