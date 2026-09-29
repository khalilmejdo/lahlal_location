/**
 * Journalisation applicative.
 *
 * Sortie JSON sur une ligne : directement exploitable par les journaux Render.
 * Une liste de champs sensibles est expurgee avant ecriture, afin qu'aucun mot
 * de passe, jeton de session ni nom de beneficiaire ne finisse dans les logs.
 */
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || '').toLowerCase()]
  ?? (config.isProduction ? LEVELS.info : LEVELS.debug);

/** Champs dont la valeur ne doit jamais etre journalisee. */
const REDACTED_KEYS = new Set([
  'password',
  'motdepasse',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'token',
  'csrf',
  'csrftoken',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'databaseurl',
  'connectionstring',
  // Donnees personnelles (loi 09-08). Les formes accentuees
  // servent au texte libre ; les identifiants de code, eux, sont toujours
  // sans accent dans ce projet (clientIce, beneficiaryName…), d'ou les deux
  // graphies de chaque mot.
  'beneficiary',
  'beneficiaire',
  'bénéficiaire',
  'assure',
  'assuré',
  'patient',
  'phone',
  'telephone',
  'téléphone',
  'ice',
]);

const sansAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Decoupe une cle en mots (camelCase, snake_case, kebab-case) et rend la
 * forme sans separateurs en tete : « clientIce » -> ['clientice', 'client', 'ice'].
 *
 * Une correspondance exacte au premier element preserve le comportement
 * d'origine (« databaseUrl » est sensible dans son ensemble, ni « database »
 * ni « url » ne le sont separement) ; la correspondance par mot attrape ce
 * que l'ancienne comparaison exacte manquait : une cle composee dont un seul
 * segment est sensible, comme clientIce, assurePhone ou telephoneAssure.
 */
function motsDeCle(key) {
  const normalisee = sansAccents(String(key))
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const mots = normalisee.split(/\s+/).filter(Boolean);
  return [mots.join(''), ...mots];
}

const estSensible = (key) => motsDeCle(key).some((m) => REDACTED_KEYS.has(m));

function redact(input, depth = 0) {
  if (depth > 4) return '[profondeur max]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => redact(v, depth + 1));

  if (typeof input === 'object') {
    if (input instanceof Error) {
      return { message: input.message, name: input.name, stack: input.stack };
    }
    const out = {};
    for (const [key, val] of Object.entries(input)) {
      out[key] = estSensible(key) ? '[expurge]' : redact(val, depth + 1);
    }
    return out;
  }

  if (typeof input === 'string' && input.length > 2000) {
    return input.slice(0, 2000) + '... [tronque]';
  }
  return input;
}

function emit(level, message, context) {
  if (LEVELS[level] < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: String(message),
    ...(context ? { ctx: redact(context) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg, ctx) => emit('debug', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
};
