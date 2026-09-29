/**
 * Configuration applicative.
 *
 * Charge le fichier .env (sans dependance externe) puis valide strictement les
 * parametres critiques : l'application refuse de demarrer si un secret est
 * absent, trop court, ou laisse a sa valeur d'exemple.
 *
 * Les variables deja presentes dans l'environnement (Docker, systemd) ont
 * toujours la priorite sur le fichier .env.
 *
 * Ce qui se regle ICI et ce qui se regle EN BASE
 * ----------------------------------------------
 * L'environnement porte l'infrastructure : port, base, secrets, bornes de
 * securite. Il ne porte AUCUN seuil metier. Les seuils d'alerte des echeances
 * — a partir de combien de kilometres une vidange devient « urgente » —
 * vivent dans la table `settings` et se reglent depuis l'application, parce
 * que ce sont des decisions d'exploitation qui changent sans redeploiement
 * (regle 17 du cahier des charges). Voir server/domain/seuils.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/* ------------------------------------------------------------------ */
/*  Lecture du fichier .env                                            */
/* ------------------------------------------------------------------ */

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

/* ------------------------------------------------------------------ */
/*  Helpers de lecture typee                                           */
/* ------------------------------------------------------------------ */

const str = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : String(v);
};

const bool = (key, fallback = false) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};

/**
 * Une variable posee mais illisible ne demarre pas sur un defaut muet.
 *
 * Reprise de lahlal_samuplus (K-12) : LOGIN_LOCKOUT_MINUTES=abc etait
 * remplace par quinze minutes sans un mot. Ce qui est pose et ne se lit pas
 * se note ici, et validateConfig() en fait une erreur de demarrage.
 */
const ENV_ILLISIBLES = [];

const int = (key, fallback) => {
  const brut = str(key, '').trim();
  if (brut === '') return fallback;
  if (!/^-?\d+$/.test(brut)) {
    ENV_ILLISIBLES.push(key + '=' + brut + ' (un entier est attendu)');
    return fallback;
  }
  return Number.parseInt(brut, 10);
};

/** Ramene une valeur dans un intervalle. */
const borne = (n, min, max) => Math.min(Math.max(n, min), max);

/**
 * Les planchers de la posture de securite, pour l'ecran ET pour
 * l'environnement.
 *
 * Reprise de lahlal_samuplus (F-2) : ce que l'ecran refuse d'enregistrer ne
 * doit pas pouvoir entrer par la porte de service.
 */
export const PLANCHERS_SECURITE = {
  sessionIdleMinutes: { min: 5, max: 480, env: 'SESSION_IDLE_MINUTES', ecran: true },
  sessionAbsoluteHours: { min: 1, max: 168, env: 'SESSION_ABSOLUTE_HOURS', ecran: true },
  loginMaxAttempts: { min: 3, max: 20, env: 'LOGIN_MAX_ATTEMPTS', ecran: true },
  passwordMinLength: { min: 10, max: 64, env: 'PASSWORD_MIN_LENGTH', ecran: true },
  loginLockoutMinutes: { min: 1, max: 1440, env: 'LOGIN_LOCKOUT_MINUTES', ecran: false },
  rateLimitMax: { min: 10, max: 100000, env: 'RATE_LIMIT_MAX', ecran: true },
  rateLimitWindowSeconds: { min: 1, max: 3600, env: 'RATE_LIMIT_WINDOW_SECONDS', ecran: true },
};

/**
 * La valeur d'environnement, dans l'unite de son plancher.
 *
 * config stocke des millisecondes ; les planchers sont exprimes dans l'unite
 * de la variable, celle que l'exploitant ecrit dans son fichier.
 */
export function valeurPosture(cle) {
  switch (cle) {
    case 'sessionIdleMinutes': return Math.round(config.security.sessionIdleMs / 60000);
    case 'sessionAbsoluteHours': return Math.round(config.security.sessionAbsoluteMs / 3600000);
    case 'loginMaxAttempts': return config.security.loginMaxAttempts;
    case 'passwordMinLength': return config.security.passwordMinLength;
    case 'loginLockoutMinutes': return Math.round(config.security.loginLockoutMs / 60000);
    case 'rateLimitMax': return config.security.rateLimitMax;
    case 'rateLimitWindowSeconds': return Math.round(config.security.rateLimitWindowMs / 1000);
    default: return null;
  }
}

const list = (key) =>
  str(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const nodeEnv = str('NODE_ENV', 'production');

/**
 * Empreinte du code en cours d'execution.
 *
 * Sans cette valeur, rien ne distingue une application deployee d'une
 * application dont le deploiement a echoue en silence.
 */
const versionDeployee =
  (str('SOURCE_COMMIT') || str('COOLIFY_GIT_COMMIT_SHA') || str('GIT_COMMIT') || '')
    .trim()
    .slice(0, 7) || null;

const dataDir = path.resolve(ROOT, str('DATA_DIR', './data'));

export const config = {
  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  version: versionDeployee,

  http: {
    port: int('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    trustProxy: bool('TRUST_PROXY', true),
    trustProxyHops: borne(int('TRUST_PROXY_HOPS', 1), 1, 5),
    // X-Real-IP n'est lu que si l'exploitant le declare : un client qui le
    // fabrique se presenterait sous une adresse neuve a chaque appel et
    // echapperait a toute limitation de debit.
    trustRealIp: bool('TRUST_REAL_IP', false),
    allowedOrigins: list('ALLOWED_ORIGINS'),
    // Le corps JSON. Les fichiers ont leur propre borne (storage.maxUploadBytes)
    // et ne passent pas par ici.
    bodyLimitBytes: int('BODY_LIMIT_KB', 512) * 1024,
  },

  db: {
    url: str('DATABASE_URL'),
    ssl: str('DATABASE_SSL', 'require').toLowerCase(), // off | require | verify
    caCert: str('DATABASE_CA_CERT'),
    poolMax: int('DATABASE_POOL_MAX', 8),
    statementTimeoutMs: int('DATABASE_STATEMENT_TIMEOUT_MS', 30000),
    connectionTimeoutMs: int('DATABASE_CONNECT_TIMEOUT_MS', 12000),
    idleTimeoutMs: int('DATABASE_IDLE_TIMEOUT_MS', 600000),
  },

  security: {
    secret: str('APP_SECRET'),
    passwordPepper: str('APP_PASSWORD_PEPPER'),
    secureCookies: bool('SECURE_COOKIES', true),
    enableHsts: bool('ENABLE_HSTS', true),
    sessionIdleMs: int('SESSION_IDLE_MINUTES', 45) * 60000,
    sessionAbsoluteMs: int('SESSION_ABSOLUTE_HOURS', 12) * 3600000,
    passwordMinLength: int('PASSWORD_MIN_LENGTH', 12),
    loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
    loginLockoutMs: int('LOGIN_LOCKOUT_MINUTES', 15) * 60000,
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_SECONDS', 60) * 1000,
    rateLimitMax: int('RATE_LIMIT_MAX', 300),
  },

  audit: {
    // L'ancre externe du journal (server/core/ancre-journal.js) : la tete de
    // chaine, ecrite hors de la base a chaque entree validee. La chaine de
    // condensats attrape une entree modifiee ; l'ancre attrape une queue
    // coupee par quelqu'un qui tient la base — raccourcir le journal sans
    // etre vu demande alors la base ET le disque. « off » rend le
    // comportement d'avant.
    ancreExterne: bool('AUDIT_ANCRE_EXTERNE', true),
  },

  storage: {
    dataDir,
    // Une photo de compteur prise au telephone pese couramment 3 a 5 Mo. Dix
    // laissent de la marge sans ouvrir la porte au televersement de masse ;
    // le client reduit d'ailleurs les images avant l'envoi.
    maxUploadBytes: int('UPLOAD_MAX_MB', 10) * 1024 * 1024,
    // Les types REELLEMENT acceptes se decident sur les octets d'en-tete du
    // fichier (server/domain/fichiers.js), jamais sur l'extension ni sur le
    // Content-Type annonce. Cette liste est la borne haute de ce que le
    // detecteur peut reconnaitre.
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'application/pdf',
    ],
  },

  bootstrap: {
    username: str('BOOTSTRAP_ADMIN_USERNAME', 'admin'),
    email: str('BOOTSTRAP_ADMIN_EMAIL', ''),
    password: str('BOOTSTRAP_ADMIN_PASSWORD'),
  },
};

/* ------------------------------------------------------------------ */
/*  Validation stricte au demarrage                                    */
/* ------------------------------------------------------------------ */

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Retourne la liste des erreurs bloquantes de configuration.
 * @param {{ requireDb?: boolean }} [opts]
 * @returns {string[]}
 */
export function validateConfig(opts = {}) {
  const { requireDb = true } = opts;
  const errors = [];

  const secrets = [
    ['APP_SECRET', config.security.secret, 'signature des sessions et jetons CSRF'],
    ['APP_PASSWORD_PEPPER', config.security.passwordPepper, 'poivre des mots de passe'],
  ];
  for (const [key, value, label] of secrets) {
    if (!value) {
      errors.push(key + ' est absent (' + label + '). Generez-le avec : npm run keygen');
    } else if (!HEX64.test(value)) {
      errors.push(key + ' doit contenir exactement 64 caracteres hexadecimaux (' + label + ').');
    }
  }

  const provided = secrets.map((s) => s[1]).filter(Boolean);
  if (provided.length === 2 && new Set(provided).size < 2) {
    errors.push('APP_SECRET et APP_PASSWORD_PEPPER doivent être distincts.');
  }

  if (requireDb) {
    if (!config.db.url) {
      errors.push('DATABASE_URL est requis (chaine de connexion PostgreSQL).');
    } else if (/MOT_DE_PASSE|xxxxxxxx|\[YOUR-PASSWORD\]/i.test(config.db.url)) {
      errors.push('DATABASE_URL contient encore une valeur d’exemple.');
    } else if (!/^postgres(ql)?:\/\//i.test(config.db.url)) {
      errors.push('DATABASE_URL doit commencer par postgresql://');
    }
  }
  if (!['off', 'require', 'verify'].includes(config.db.ssl)) {
    errors.push('DATABASE_SSL doit valoir off, require ou verify.');
  }
  if (config.db.ssl === 'verify' && !config.db.caCert) {
    errors.push('DATABASE_SSL=verify impose de fournir DATABASE_CA_CERT.');
  }

  if (config.security.enableHsts && !config.security.secureCookies) {
    errors.push('ENABLE_HSTS=true impose SECURE_COOKIES=true.');
  }

  for (const [cle, regle] of Object.entries(PLANCHERS_SECURITE)) {
    const valeur = valeurPosture(cle);
    if (valeur === null || !Number.isFinite(valeur)) {
      errors.push(regle.env + ' doit être un nombre.');
      continue;
    }
    if (valeur < regle.min || valeur > regle.max) {
      errors.push(
        regle.env + ' doit se situer entre ' + regle.min + ' et ' + regle.max +
        ' (valeur lue : ' + valeur + ').',
      );
    }
  }

  if (config.storage.maxUploadBytes < 256 * 1024 || config.storage.maxUploadBytes > 50 * 1024 * 1024) {
    errors.push('UPLOAD_MAX_MB doit se situer entre 1 et 50.');
  }

  for (const illisible of ENV_ILLISIBLES) {
    errors.push(illisible + ' : la valeur ne se lit pas, et le défaut ne s’applique pas en silence.');
  }
  if (config.security.sessionIdleMs > config.security.sessionAbsoluteMs) {
    errors.push('SESSION_IDLE_MINUTES ne peut pas exceder SESSION_ABSOLUTE_HOURS.');
  }

  return errors;
}

/** Avertissements non bloquants relatifs a la posture de securite. */
export function configWarnings() {
  const w = [];
  if (config.isProduction && !config.security.secureCookies) {
    w.push('SECURE_COOKIES=false en production : le cookie de session circulera en clair.');
  }
  if (config.isProduction && config.http.allowedOrigins.length === 0) {
    w.push('ALLOWED_ORIGINS est vide : la protection CSRF se limitera a une comparaison avec le Host.');
  }
  if (config.db.ssl === 'off') {
    w.push('DATABASE_SSL=off : la connexion à la base ne sera pas chiffree.');
  }
  if (!config.bootstrap.password) {
    w.push('BOOTSTRAP_ADMIN_PASSWORD absent : le premier administrateur ne pourra pas être créé automatiquement.');
  }
  if (config.http.trustProxy && config.http.trustProxyHops > 1) {
    w.push(
      'TRUST_PROXY_HOPS=' + config.http.trustProxyHops + ' : verifiez qu’il y a bien ' +
      config.http.trustProxyHops + ' proxys devant l’application. Un compte trop eleve ' +
      'laisse le client choisir l’adresse IP que voit la limitation de debit.',
    );
  }
  return w;
}

/** Interrompt le processus si la configuration est invalide. */
export function assertConfig(opts) {
  const errors = validateConfig(opts);
  if (errors.length) {
    console.error('\n  Configuration invalide - démarrage interrompu :\n');
    for (const e of errors) console.error('   - ' + e);
    console.error('\n  Voir .env.example, puis : npm run keygen\n');
    process.exit(1);
  }
}
