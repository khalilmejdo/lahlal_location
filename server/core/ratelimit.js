/**
 * Limitation de debit en memoire.
 *
 * L'application est prevue pour tourner sur une seule instance Render : un
 * compteur en memoire est donc suffisant et evite d'ajouter une dependance a
 * un cache externe. Si l'application venait a etre repliquee sur plusieurs
 * instances, ce module serait le seul point a remplacer par un compteur
 * partage — la protection contre le bourrage d'identifiants resterait par
 * ailleurs assuree par le verrouillage de compte en base, lui bien partage.
 */
import { posture } from './posture.js';

/** @type {Map<string, {count:number, resetAt:number}>} */
const buckets = new Map();

// Purge periodique : sans elle, la table croitrait indefiniment avec le nombre
// d'adresses IP rencontrees.
const CLEANUP_INTERVAL_MS = 120000;
let cleanupTimer = null;

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, CLEANUP_INTERVAL_MS);
  // Ne maintient pas le processus en vie a lui seul.
  cleanupTimer.unref?.();
}

/**
 * Consomme une unite dans le compteur identifie par `key`.
 *
 * @param {string} key
 * @param {{ max?: number, windowMs?: number }} [opts]
 * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number, resetAt: number }}
 */
export function consume(key, opts = {}) {
  const max = opts.max ?? posture().rateLimitMax;
  const windowMs = opts.windowMs ?? posture().rateLimitWindowSeconds * 1000;

  startCleanup();

  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  const allowed = bucket.count <= max;
  return {
    allowed,
    remaining: Math.max(0, max - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    resetAt: bucket.resetAt,
  };
}

/** Consulte un compteur sans le consommer. */
export function peek(key, opts = {}) {
  const max = opts.max ?? posture().rateLimitMax;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= Date.now()) {
    return { count: 0, remaining: max, resetAt: 0 };
  }
  return { count: bucket.count, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

/** Remet un compteur a zero (connexion reussie, par exemple). */
export function reset(key) {
  buckets.delete(key);
}

/** Nombre de compteurs actifs, pour la page de diagnostic. */
export function activeBuckets() {
  return buckets.size;
}

/* ------------------------------------------------------------------ */
/*  Profils de limitation                                              */
/* ------------------------------------------------------------------ */

/**
 * Profils appliques selon la sensibilite de la route.
 * L'authentification est volontairement tres restrictive : c'est la porte
 * d'entree la plus attaquee.
 */
export const PROFILES = {
  /**
   * Navigation normale dans l'application.
   *
   * Lu a CHAQUE requete, et non fige au demarrage. Ce profil etait construit
   * une fois, a l'import, depuis config : un budget releve depuis l'ecran se
   * serait enregistre, affiche, journalise en severite critique — et ne se
   * serait applique qu'au redeploiement suivant. C'est exactement le defaut
   * F-6, et posture() existe pour qu'il ne se reproduise pas : elle rend le
   * reglage courant, et retombe sur l'environnement tant que rien n'a ete
   * pose.
   */
  get standard() {
    const p = posture();
    return { max: p.rateLimitMax, windowMs: p.rateLimitWindowSeconds * 1000 };
  },
  /**
   * Fichiers servis depuis le cache memoire : modules, styles, images.
   *
   * Ils comptaient dans le budget « standard », et une page de cette
   * application en demande plusieurs dizaines : trois actualisations
   * suffisaient a fermer l'application a son propre utilisateur, coquille
   * HTML comprise. Ils ont donc leur propre compteur, large, parce qu'un
   * fichier en cache ne coute ni requete SQL ni calcul — le garde-fou est la
   * pour un martelement, pas pour une navigation.
   */
  statique: { max: 3000, windowMs: 60000 },
  /** Tentatives de connexion, par adresse IP. */
  login: { max: 10, windowMs: 300000 },
  /** Operations d'ecriture sensibles (validation, avoir, suppression). */
  sensitive: { max: 60, windowMs: 60000 },
  /** Televersement de pieces jointes. */
  upload: { max: 30, windowMs: 300000 },
  /** Exports et rapports, plus couteux a produire. */
  export: { max: 20, windowMs: 300000 },
};
