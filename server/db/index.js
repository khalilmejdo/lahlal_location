/**
 * Acces a la base PostgreSQL (Supabase).
 *
 * Regles de securite appliquees ici, sans exception dans le reste du code :
 *   - toute requete passe par des parametres lies ($1, $2...) ; aucune valeur
 *     utilisateur n'est jamais concatenee dans une chaine SQL ;
 *   - les identifiants SQL dynamiques (tri, colonnes) ne sont acceptes que
 *     depuis des listes blanches declarees par l'appelant ;
 *   - un statement_timeout empeche qu'une requete pathologique n'immobilise
 *     le pool de connexions.
 */
import pg from 'pg';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { conflict, AppError } from '../core/errors.js';

const { Pool, types } = pg;

/* ------------------------------------------------------------------ */
/*  Typage des resultats                                               */
/* ------------------------------------------------------------------ */

// PostgreSQL renvoie BIGINT/NUMERIC sous forme de chaine pour ne pas perdre de
// precision. Nos montants sont des entiers de centimes qui tiennent largement
// dans un Number : on les convertit pour eviter des "12" + 5 = "125" ailleurs.
//
// O-7 (recette e2550ad) : au-dela de 2^53, Number() arrondit en silence —
// 9007199254740993 en base devenait 9007199254740992 dans le corps HTTP, et
// deux factures aux montants distincts s'affichaient identiques. Le schema
// borne desormais ces colonnes (section 18) ; ici, un entier que Number ne
// represente pas est refuse au lieu d'etre fausse. Un tel cas ne vient que
// d'une ecriture faite hors de l'application : il se dit, il ne se maquille pas.
const entierRepresentable = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) && /^-?\d+$/.test(v)) {
    throw new AppError(500, 'Valeur entiere hors de la plage representable par l’application (' + v + ') : ' +
      'la base porte un nombre que l’ecran ne pourrait afficher sans le fausser.', { code: 'VALEUR_NON_REPRESENTABLE' });
  }
  return n;
};
types.setTypeParser(20, (v) => (v === null ? null : entierRepresentable(v))); // int8 / bigint
types.setTypeParser(1700, (v) => (v === null ? null : (/^-?\d+$/.test(v) ? entierRepresentable(v) : Number(v)))); // numeric
// Les dates (type DATE) sont conservees en chaine ISO "AAAA-MM-JJ" : une
// conversion en objet Date reintroduirait un decalage de fuseau horaire.
types.setTypeParser(1082, (v) => v);

/* ------------------------------------------------------------------ */
/*  Pool                                                               */
/* ------------------------------------------------------------------ */

let pool = null;

function sslOption() {
  if (config.db.ssl === 'off') return false;
  if (config.db.ssl === 'verify') {
    return { rejectUnauthorized: true, ca: config.db.caCert.replace(/\\n/g, '\n') };
  }
  // "require" : la connexion est chiffree, la chaine de certification n'est pas
  // verifiee. C'est le mode par defaut documente par Supabase.
  return { rejectUnauthorized: false };
}

export function getPool() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: config.db.url,
    ssl: sslOption(),
    max: config.db.poolMax,
    idleTimeoutMillis: config.db.idleTimeoutMs,
    connectionTimeoutMillis: config.db.connectionTimeoutMs,
    statement_timeout: config.db.statementTimeoutMs,
    application_name: 'samuplus-gestion',
    // Toutes les dates applicatives sont manipulees en UTC.
    options: '-c timezone=UTC',
  });

  pool.on('error', (err) => {
    // Une connexion inactive coupee par Supabase ne doit pas tuer le processus.
    log.error('Erreur sur une connexion inactive du pool', { error: err.message });
  });

  return pool;
}

/* ------------------------------------------------------------------ */
/*  Execution                                                          */
/* ------------------------------------------------------------------ */

const SLOW_QUERY_MS = 1000;

/**
 * Execute une requete parametree.
 * @param {string} text
 * @param {Array<any>} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params = []) {
  const started = Date.now();
  try {
    const result = await getPool().query(text, params);
    const elapsed = Date.now() - started;
    if (elapsed > SLOW_QUERY_MS) {
      log.warn('Requête lente', { ms: elapsed, sql: text.slice(0, 160).replace(/\s+/g, ' ') });
    }
    return result;
  } catch (err) {
    // Le SQL est journalise cote serveur, jamais renvoye au client.
    log.error('Echec SQL', {
      error: err.message,
      code: err.code,
      sql: text.slice(0, 300).replace(/\s+/g, ' '),
    });
    throw err;
  }
}

/** Toutes les lignes. */
export async function all(text, params) {
  return (await query(text, params)).rows;
}

/** Premiere ligne, ou null. */
export async function one(text, params) {
  const rows = await all(text, params);
  return rows.length ? rows[0] : null;
}

/** Premiere colonne de la premiere ligne, ou null. */
export async function value(text, params) {
  const row = await one(text, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

/** Nombre de lignes affectees. */
export async function execute(text, params) {
  return (await query(text, params)).rowCount;
}

/* ------------------------------------------------------------------ */
/*  Transactions                                                       */
/* ------------------------------------------------------------------ */

/**
 * Execute `fn` dans une transaction. La fonction recoit un client offrant la
 * meme interface (query / all / one / value / execute).
 *
 * Toute exception declenche un ROLLBACK : une facture ne peut pas etre creee
 * a moitie, ni un numero de sequence consomme sans document associe.
 *
 * @template T
 * @param {(tx: TxClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function transaction(fn) {
  const client = await getPool().connect();
  // B-8 : un client sorti du pool n'a plus d'ecouteur « error » — pg-pool le
  // retire a la sortie et ne le remet qu'au retour. Si le serveur coupe la
  // connexion pendant une requete (arret de Postgres, pg_terminate_backend,
  // reseau), la requete en cours est bien rejetee — mais le client emet AUSSI
  // « error », et sans ecouteur Node tue le processus : le serveur entier, ou
  // une migration dont le .catch() ne voyait jamais l'erreur. L'ecouteur ne
  // fait que noter : la requete rejetee porte deja l'erreur a qui l'attend,
  // et pg-pool ecarte de lui-meme un client devenu inutilisable au release().
  const surCoupure = (err) => log.warn('Connexion coupee pendant une transaction', { error: err.message });
  client.on('error', surCoupure);
  // Ce qui doit se faire APRES le COMMIT, et seulement s'il a lieu : l'ancre
  // externe du journal d'audit, par exemple — posee dans la transaction, un
  // ROLLBACK la laisserait en avance sur la base.
  const apresValidation = [];
  const tx = makeTxClient(client, apresValidation);
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    for (const suite of apresValidation) {
      try {
        await suite();
      } catch (err) {
        // La transaction est validee : ce qui echoue ici ne la defait pas, et
        // ne doit pas transformer une operation reussie en erreur.
        log.error('Echec d’une suite apres validation', { error: err.message });
      }
    }
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error('Echec du ROLLBACK', { error: rollbackErr.message });
    }
    // E-2 : deux ecritures concurrentes sur la meme ligne peuvent echouer
    // sur un conflit de serialisation ou un interblocage. Ce n'est pas une
    // panne : la transaction n'a rien ecrit, et la meme requete rejouee
    // aboutira. Sans traduction, elle remontait en 500 avec une reference
    // d'incident — l'operateur ne savait pas si son reglement etait passe,
    // alors que le cumul, lui, restait juste.
    //
    // Pose ici plutot que dans une route : toutes les ecritures de
    // l'application passent par cette fonction, et le prochain point de
    // concurrence n'aura pas a y penser.
    if (err && (err.code === '40001' || err.code === '40P01')) {
      log.warn('Ecriture concurrente rejouable', { code: err.code });
      throw conflict(
        'Une autre écriture a touché les mêmes données au même instant. '
        + 'Rien n’a été enregistré : renouvelez l’opération.',
      );
    }
    throw err;
  } finally {
    client.removeListener('error', surCoupure);
    client.release();
  }
}

/** @typedef {ReturnType<typeof makeTxClient>} TxClient */
function makeTxClient(client, apresValidation = []) {
  const run = async (text, params = []) => {
    try {
      return await client.query(text, params);
    } catch (err) {
      log.error('Echec SQL (transaction)', {
        error: err.message,
        code: err.code,
        sql: text.slice(0, 300).replace(/\s+/g, ' '),
      });
      throw err;
    }
  };
  return {
    raw: client,
    query: run,
    all: async (t, p) => (await run(t, p)).rows,
    one: async (t, p) => {
      const rows = (await run(t, p)).rows;
      return rows.length ? rows[0] : null;
    },
    value: async (t, p) => {
      const rows = (await run(t, p)).rows;
      if (!rows.length) return null;
      const keys = Object.keys(rows[0]);
      return keys.length ? rows[0][keys[0]] : null;
    },
    execute: async (t, p) => (await run(t, p)).rowCount,
    /** Enregistre une suite a jouer apres le COMMIT, et jamais sans lui. */
    apresValidation: (fn) => { apresValidation.push(fn); },
  };
}

/* ------------------------------------------------------------------ */
/*  Aides a la construction de requetes                                */
/* ------------------------------------------------------------------ */

/**
 * Construit progressivement une clause WHERE parametree.
 *
 *   const w = new Where();
 *   w.add('a.vehicule_id = ?', vehiculeId);
 *   w.addIf(recherche, 'a.prestation ILIKE ?', () => '%' + recherche + '%');
 *   const rows = await all('SELECT * FROM activites a ' + w.sql(), w.params);
 */
export class Where {
  constructor(startIndex = 1) {
    this.clauses = [];
    this.params = [];
    this.index = startIndex;
  }

  /** Ajoute une condition ; chaque "?" consomme un parametre dans l'ordre. */
  add(clause, ...values) {
    let i = 0;
    const rendered = clause.replace(/\?/g, () => {
      i += 1;
      return '$' + this.index++;
    });
    if (i !== values.length) {
      throw new Error(
        'Where.add : ' + i + ' emplacement(s) pour ' + values.length + ' valeur(s) fournie(s).',
      );
    }
    this.clauses.push(rendered);
    this.params.push(...values);
    return this;
  }

  /** N'ajoute la condition que si `condition` est vraie. */
  addIf(condition, clause, valuesFn) {
    if (condition === undefined || condition === null || condition === '' || condition === false) {
      return this;
    }
    const values = typeof valuesFn === 'function' ? valuesFn() : valuesFn;
    return this.add(clause, ...(Array.isArray(values) ? values : [values]));
  }

  /** Reserve le prochain emplacement de parametre (pour LIMIT / OFFSET). */
  next(valueToPush) {
    this.params.push(valueToPush);
    return '$' + this.index++;
  }

  sql(prefix = 'WHERE') {
    return this.clauses.length ? prefix + ' ' + this.clauses.join(' AND ') : '';
  }
}

/**
 * Resout un critere de tri contre une liste blanche.
 * Empeche toute injection via un parametre `sort` de l'URL.
 *
 * @param {string|undefined} requested  ex. "date_mission:desc"
 * @param {Record<string,string>} allowed  ex. { date_mission: 'm.date_mission' }
 * @param {string} fallback  clause ORDER BY par defaut
 */
export function orderBy(requested, allowed, fallback) {
  if (!requested || typeof requested !== 'string') return fallback;
  const [field, dirRaw] = requested.split(':');

  // F-3 : allowed[field] traversait la chaine de prototypes. « constructor »,
  // « toString », « hasOwnProperty » y rendaient une FONCTION, verite, dont la
  // conversion en chaine partait telle quelle dans le SQL :
  //     ?sort=constructor:asc  ->  « function Object() { [native code] } ASC »
  // soit une 500 (syntax error at or near "Object") sur les six listes, pour
  // dix caracteres. Ce n'est pas une injection — rien de la valeur ne se
  // retrouve execute — mais une route publique qui tombe reste une route qui
  // tombe. Seule une cle PROPRE de la liste blanche, et dont la valeur est une
  // chaine, est desormais acceptee.
  const column = Object.hasOwn(allowed, field) ? allowed[field] : null;
  // Une cle peut designer plusieurs colonnes — le numero d'une facture, c'est
  // son type, son annee et son rang. Chacune prend le sens demande ; une liste
  // qui contiendrait autre chose que des chaines est refusee comme le reste.
  const colonnes = Array.isArray(column) ? column : [column];
  if (!colonnes.length || colonnes.some((c) => !c || typeof c !== 'string')) return fallback;
  const dir = String(dirRaw || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return colonnes.map((c) => c + ' ' + dir + ' NULLS LAST').join(', ');
}

/* ------------------------------------------------------------------ */
/*  Cycle de vie                                                       */
/* ------------------------------------------------------------------ */

/** Verifie que la base repond. Utilise par /healthz et au demarrage. */
export async function ping() {
  const started = Date.now();
  await query('SELECT 1');
  return Date.now() - started;
}

export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
