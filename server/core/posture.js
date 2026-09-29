/**
 * La posture de securite, reglable depuis l'ecran.
 *
 * Delai d'inactivite, duree maximale d'une session, nombre d'echecs avant
 * verrouillage, longueur minimale d'un mot de passe : ces quatre valeurs
 * n'existaient que dans les variables d'environnement. Les changer imposait
 * d'ouvrir la console de l'hebergeur et de redemarrer l'application — donc,
 * en pratique, de ne jamais les changer. L'ecran de diagnostic les affichait
 * sans pouvoir y toucher.
 *
 * Elles vivent desormais dans les parametres, reservees au
 * super-administrateur (« securite.configure »). L'environnement reste la
 * valeur de depart : un parametre absent, vide ou illisible retombe sur lui,
 * jamais sur zero.
 *
 * Un cache, et pourquoi. Les endroits qui lisent ces valeurs — verification
 * d'une session a chaque requete, comptage des echecs de connexion — sont
 * synchrones et sur le chemin critique. Une lecture en base a chaque requete
 * serait payee mille fois pour une valeur qui change deux fois par an. Le
 * cache se remplit au demarrage et se rafraichit a chaque enregistrement des
 * parametres.
 */
import { all } from '../db/index.js';
import { config, PLANCHERS_SECURITE } from './config.js';
import { log } from './logger.js';

/**
 * Les quatre reglages, leurs bornes et leur valeur de repli.
 *
 * Les bornes ne sont pas decoratives : une session de zero minute
 * deconnecterait a chaque clic, un mot de passe de quatre caracteres ne
 * protegerait rien.
 *
 * F-2 : elles ne sont plus ecrites ici. Declarees dans cette table, elles ne
 * valaient que pour ce qui passe par cet ecran ; les memes grandeurs arrivant
 * par l'environnement n'etaient bornees par rien, et LOGIN_LOCKOUT_MINUTES=0
 * donnait un verrou de zero seconde sans que validateConfig() ne dise rien.
 * Les planchers sont desormais declares une seule fois, dans config.js, et lus
 * des deux cotes : la porte principale et la porte de service ne peuvent plus
 * dire deux choses differentes.
 */
export const REGLAGES_POSTURE = {
  'securite.session_inactivite_min': {
    champ: 'sessionIdleMinutes',
    ...PLANCHERS_SECURITE.sessionIdleMinutes,
    defaut: () => Math.round(config.security.sessionIdleMs / 60000),
  },
  'securite.session_duree_h': {
    champ: 'sessionAbsoluteHours',
    ...PLANCHERS_SECURITE.sessionAbsoluteHours,
    defaut: () => Math.round(config.security.sessionAbsoluteMs / 3600000),
  },
  'securite.tentatives_max': {
    champ: 'loginMaxAttempts',
    ...PLANCHERS_SECURITE.loginMaxAttempts,
    defaut: () => config.security.loginMaxAttempts,
  },
  'securite.mot_de_passe_min': {
    champ: 'passwordMinLength',
    ...PLANCHERS_SECURITE.passwordMinLength,
    defaut: () => config.security.passwordMinLength,
  },
  // Le budget de requetes par adresse et par fenetre. Il se releve depuis
  // l'ecran parce que le cas qui l'exige est un cas d'exploitation : plusieurs
  // personnes derriere une meme sortie internet partagent une adresse, donc un
  // budget. Attendre un redeploiement pour cela n'aurait pas de sens.
  //
  // Il ne compte QUE les appels de l'application : les fichiers servis depuis
  // le cache memoire ont leur propre compteur, hors de portee de ce reglage.
  'securite.debit_max': {
    champ: 'rateLimitMax',
    ...PLANCHERS_SECURITE.rateLimitMax,
    defaut: () => config.security.rateLimitMax,
  },
  'securite.debit_fenetre_s': {
    champ: 'rateLimitWindowSeconds',
    ...PLANCHERS_SECURITE.rateLimitWindowSeconds,
    defaut: () => Math.round(config.security.rateLimitWindowMs / 1000),
  },
};

/**
 * Construit la posture a partir des valeurs brutes lues en base.
 *
 * Fonction pure : elle se verifie sans base, ce qui compte pour des reglages
 * dont une erreur ouvrirait l'application au lieu de la fermer.
 *
 * @param {Map<string,string>|null} brut
 */
export function construirePosture(brut) {
  const valeurs = brut instanceof Map ? brut : new Map();
  const sortie = {};

  for (const [cle, regle] of Object.entries(REGLAGES_POSTURE)) {
    const n = Number.parseInt(String(valeurs.get(cle) ?? '').trim(), 10);
    // Hors bornes vaut absent : une valeur aberrante ne doit pas s'appliquer
    // au pretexte qu'elle a ete ecrite.
    sortie[regle.champ] = Number.isFinite(n) && n >= regle.min && n <= regle.max
      ? n
      : regle.defaut();
  }

  // Une inactivite plus longue que la duree absolue n'aurait aucun effet :
  // la session expirerait avant d'avoir eu le temps d'etre inactive. Plutot
  // qu'un reglage sans effet, on la ramene a la duree absolue — la meme
  // coherence qu'assertConfig() exige de l'environnement.
  const plafondMinutes = sortie.sessionAbsoluteHours * 60;
  if (sortie.sessionIdleMinutes > plafondMinutes) sortie.sessionIdleMinutes = plafondMinutes;

  sortie.sessionIdleMs = sortie.sessionIdleMinutes * 60000;
  sortie.sessionAbsoluteMs = sortie.sessionAbsoluteHours * 3600000;

  return sortie;
}

let courante = null;

/**
 * La posture appliquee, lisible sans attendre.
 *
 * Avant le premier chargement — et si la base est injoignable — rend les
 * valeurs de l'environnement. L'application demarre donc toujours avec une
 * posture definie, jamais avec des zeros.
 */
export function posture() {
  if (!courante) courante = construirePosture(null);
  return courante;
}

/** Relit les parametres et met le cache a jour. */
export async function chargerPosture() {
  try {
    const lignes = await all("SELECT key, value FROM settings WHERE key LIKE 'securite.%'");
    courante = construirePosture(new Map(lignes.map((l) => [l.key, l.value])));
  } catch (err) {
    // Une base injoignable ne doit pas laisser l'application sans posture :
    // elle repart de l'environnement, et le dit.
    log.warn('Posture de securite illisible, valeurs d’environnement appliquees', {
      error: err.message,
    });
    courante = construirePosture(null);
  }
  return courante;
}
