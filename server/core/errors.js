/**
 * Erreurs applicatives typees.
 *
 * Regle de securite : le message d'une AppError est destine a l'utilisateur et
 * peut etre affiche tel quel. Toute autre exception est convertie en erreur 500
 * generique cote client, le detail n'allant que dans les journaux serveur.
 */

export class AppError extends Error {
  /**
   * @param {number} status  code HTTP
   * @param {string} message message affichable
   * @param {object} [opts]  { code, details, expose }
   */
  constructor(status, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = opts.code || httpCodeName(status);
    this.details = opts.details || null;
    this.expose = opts.expose !== false;
  }
}

function httpCodeName(status) {
  return (
    {
      400: 'REQUETE_INVALIDE',
      401: 'NON_AUTHENTIFIE',
      403: 'ACCES_REFUSE',
      404: 'INTROUVABLE',
      409: 'CONFLIT',
      413: 'CONTENU_TROP_VOLUMINEUX',
      415: 'TYPE_NON_SUPPORTE',
      422: 'VALIDATION',
      429: 'TROP_DE_REQUETES',
    }[status] || 'ERREUR'
  );
}

export const badRequest = (msg = 'Requête invalide.', details) =>
  new AppError(400, msg, { details });

export const unauthorized = (msg = 'Authentification requise.') => new AppError(401, msg);

export const forbidden = (msg = 'Vous n’avez pas les droits nécessaires pour cette action.') =>
  new AppError(403, msg);

export const notFound = (msg = 'Element introuvable.') => new AppError(404, msg);

export const conflict = (msg = 'Conflit avec l’état actuel de la donnée.', details) =>
  new AppError(409, msg, { details });

export const tooLarge = (msg = 'Contenu trop volumineux.') => new AppError(413, msg);

export const unsupportedMedia = (msg = 'Type de fichier non autorise.') => new AppError(415, msg);

export const tooManyRequests = (msg = 'Trop de requêtes. Reessayez dans un instant.', retryAfter) =>
  new AppError(429, msg, { details: retryAfter ? { retryAfter } : null });

/**
 * Une valeur que PostgreSQL n'a pas su convertir dans le type de la colonne.
 *
 * `?clientId=x` sur une colonne UUID, `?from=hier` sur une date : la valeur
 * est bien liee (aucune injection), mais la base la refuse — et ce refus
 * remontait en 500 « erreur inattendue » avec une reference d'incident,
 * sur onze listes (270 reponses mesurees). Ce n'est pas une panne : c'est la
 * requete qui est mal formee, et c'est ce que le code 400 dit. Les lectures
 * de filtres typees (ctx.queryUuid, ctx.queryDate, ctx.queryEntier) nomment
 * le parametre AVANT le SQL ; ceci est le filet, pour la route qui les
 * oublierait.
 *
 * Rend null si l'erreur n'est pas de cette famille.
 */
const CODES_DE_TYPE = {
  '22P02': 'Un parametre de la requête est mal formé : une valeur n’a pas la forme attendue (identifiant, nombre ou texte).',
  '22007': 'Un parametre de la requête est mal formé : une date est attendue au format AAAA-MM-JJ.',
  '22008': 'Un parametre de la requête est mal formé : cette date ou cette heure n’existe pas.',
  '22003': 'Une valeur dépasse la capacité du champ qui la reçoit.',
};
export function erreurDeTypePostgres(err) {
  const message = CODES_DE_TYPE[err?.code];
  if (!message) return null;
  return new AppError(400, message, { code: 'PARAMETRE_MAL_FORME', details: { pgCode: err.code } });
}

/**
 * La base ne repond pas, ou refuse d'ecrire : un 503 qui dit la cause.
 *
 * F-13 (recette) : le journal d'audit indisponible — droits retires sur la
 * table — rendait l'application inutilisable avec un 500 « erreur
 * inattendue » sur la connexion et sur toute ecriture ; le refus-ferme est
 * le bon choix, mais le message ne permettait pas de le diagnostiquer.
 * M-4 : au-dela de seize clients sur un ecran lourd, le pool abandonnait
 * apres douze secondes avec le meme 500 qu'un bug — ni 503, ni Retry-After.
 * Ces pannes ne sont pas des defauts du code : elles sont dites comme ce
 * qu'elles sont, avec un delai avant de reessayer.
 *
 * Rend null si l'erreur n'est pas de cette famille.
 */
const CODES_INDISPONIBLES = {
  '42501': (err) => 'la base refuse l’écriture : droits insuffisants' + (err.table ? ' sur la table « ' + err.table + ' »' : ''),
  '42P01': (err) => 'une table attendue n’existe pas' + (err.table ? ' (« ' + err.table + ' »)' : '') + ' : la base n’est pas migrée',
  '08000': () => 'la connexion à la base a été perdue',
  '08001': () => 'la base est injoignable',
  '08003': () => 'la connexion à la base a été perdue',
  '08006': () => 'la connexion à la base a été perdue',
  '57P01': () => 'la base s’arrête',
  '57P02': () => 'la base s’arrête',
  '57P03': () => 'la base démarre',
  '53300': () => 'la base n’accepte plus de connexion',
};
export function erreurBaseIndisponible(err) {
  if (!err) return null;
  let cause = CODES_INDISPONIBLES[err.code]?.(err) ?? null;
  const texte = String(err.message || '');
  if (!cause && /timeout exceeded when trying to connect/i.test(texte)) {
    cause = 'toutes les connexions à la base sont occupées';
  }
  if (!cause && /Connection terminated|ECONNREFUSED|ECONNRESET/i.test(texte)) {
    cause = 'la connexion à la base a été perdue';
  }
  if (!cause) return null;
  return new AppError(503,
    'Le service ne peut pas utiliser la base pour le moment : ' + cause + '. ' +
    'Rien n’a été enregistré. Réessayez dans un instant ; si cela persiste, prévenez l’administrateur.',
    { code: 'BASE_INDISPONIBLE', details: { retryAfter: 5, pgCode: err.code || null } });
}

/** Erreur de validation portant le detail champ par champ. */
export class ValidationError extends AppError {
  /** @param {Record<string,string>} fields */
  constructor(fields, msg = 'Certains champs sont invalides.') {
    super(422, msg, { code: 'VALIDATION', details: { fields } });
    this.name = 'ValidationError';
    this.fields = fields;
  }
}
