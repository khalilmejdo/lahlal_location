/**
 * Service des fichiers statiques de l'interface.
 *
 * Le chemin demande est resolu puis verifie : tout resultat sortant du dossier
 * public est refuse, ce qui exclut la traversee de repertoire ("../../.env").
 * Les fichiers sont mis en cache memoire au premier acces — leur volume est
 * faible et connu — ce qui evite un acces disque par requete.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, config } from '../core/config.js';
import { sha256 } from '../core/crypto.js';
import { applySecurityHeaders } from './security.js';

const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** @type {Map<string, {buffer:Buffer, mime:string, etag:string}>} */
const cache = new Map();

/** Vide le cache (utile en developpement avec --watch). */
export function clearStaticCache() {
  cache.clear();
}

/**
 * Resout un chemin d'URL vers un fichier du dossier public.
 * @returns {string|null} chemin absolu, ou null si la cible est illegitime
 */
function resolveSafePath(urlPath) {
  // Retire la barre initiale, normalise, puis verifie l'appartenance.
  const relative = urlPath.replace(/^\/+/, '');
  if (relative.includes('\0')) return null;

  const absolute = path.resolve(PUBLIC_DIR, relative);
  const normalizedRoot = PUBLIC_DIR + path.sep;

  if (absolute !== PUBLIC_DIR && !absolute.startsWith(normalizedRoot)) return null;

  // Les fichiers caches ne sont jamais servis.
  if (path.basename(absolute).startsWith('.')) return null;

  return absolute;
}

/**
 * Pose la version du deploiement dans les adresses des modules.
 *
 * POURQUOI. Les ecrans se chargent a la demande — « await import('./views/
 * admin.js') » — et les fichiers etaient servis en « no-cache » : le
 * navigateur les gardait, mais redemandait a CHAQUE fois s'ils avaient change.
 * Vingt-neuf modules, 860 Ko, et autant d'allers-retours. Apres une pause, la
 * connexion est froide : chaque aller-retour repaie une poignee de main TLS,
 * et l'utilisateur attend devant un ecran vide alors que le serveur, lui,
 * repond en 20 ms.
 *
 * POURQUOI ON NE POUVAIT PAS SIMPLEMENT ALLONGER LE CACHE. C'est ce qui
 * existait — une heure — et cela a ete retire pour une bonne raison, ecrite
 * plus bas : « app.js » garde son nom d'une version a l'autre, si bien qu'un
 * navigateur pouvait servir l'ancien code pendant une heure apres une mise en
 * ligne. Et un rechargement force n'y aurait rien change : il aurait resservi
 * le meme fichier depuis le meme cache, en boucle.
 *
 * CE QUI LEVE LA CONTRADICTION. L'adresse porte la version : « ./views/
 * admin.js?v=15ec732 ». Une mise en ligne change la version, donc TOUTES les
 * adresses, donc le navigateur redemande tout — une fois. Entre deux mises en
 * ligne il ne redemande rien du tout. Le document d'accueil, lui, n'est jamais
 * mis en cache : c'est lui qui designe les nouvelles adresses.
 *
 * Sans version connue — en developpement, ou si SOURCE_COMMIT manque — rien
 * n'est reecrit et le comportement d'hier s'applique tel quel. Un cache long
 * ne s'obtient jamais par accident.
 *
 * Le remplacement se fait par FONCTION et non par chaine : une chaine de
 * remplacement interpreterait « $& » et « $1 » trouves dans le code servi.
 */
export function versionnerModule(source, version) {
  // Seuls les specificateurs d'import sont touches : « from './x.js' »,
  // « import './x.js' », « import('./x.js') ». Une chaine de caracteres qui
  // ressemble a un chemin, ailleurs dans le code, n'est pas un import.
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/)[^'"\n]+?\.m?js)\2/g,
    (_tout, avant, guillemet, chemin) =>
      avant + guillemet + chemin + '?v=' + version + guillemet,
  );
}

/** Idem pour le document d'accueil : les balises script et link. */
export function versionnerDocument(source, version) {
  return source.replace(
    /(<(?:script|link)\b[^>]*?\b(?:src|href)=")(\/[^"\n]+?\.(?:m?js|css))(")/g,
    (_tout, avant, chemin, apres) => avant + chemin + '?v=' + version + apres,
  );
}

async function loadFile(absolutePath) {
  const cached = cache.get(absolutePath);
  if (cached) return cached;

  let buffer;
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    buffer = await fs.readFile(absolutePath);
  } catch {
    return null;
  }

  // La version est posee dans les adresses AVANT le calcul de l'empreinte :
  // l'ETag doit porter sur ce qui est reellement envoye.
  const extension = path.extname(absolutePath).toLowerCase();
  if (config.version) {
    if (extension === '.js' || extension === '.mjs') {
      buffer = Buffer.from(versionnerModule(buffer.toString('utf8'), config.version), 'utf8');
    } else if (extension === '.html') {
      buffer = Buffer.from(versionnerDocument(buffer.toString('utf8'), config.version), 'utf8');
    }
  }

  const entry = {
    buffer,
    mime: MIME_TYPES[extension] || 'application/octet-stream',
    etag: '"' + sha256(buffer).slice(0, 32) + '"',
  };
  cache.set(absolutePath, entry);
  return entry;
}

/**
 * Tente de servir un fichier statique.
 *
 * `avantEnvoi` est appele UNE FOIS LE FICHIER RECONNU, et jamais avant. C'est
 * la que server/index.js consomme le compteur des fichiers. Il le consommait
 * avant d'appeler cette fonction, donc avant de savoir si l'adresse designait
 * un fichier : tout GET y passait, « /api/... » compris, et les 3 000 par
 * minute de ce compteur plafonnaient EN SILENCE le budget des ecrans, quel que
 * soit le reglage pose a l'ecran. Un exploitant qui relevait
 * « securite.debit_max » a 5 000 pour un bureau derriere une seule adresse en
 * obtenait 3 000 — mesure : 2 000 appels de /healthz, 899 de /api/auth/session,
 * et le 3 000e refuse alors que le budget regle valait 100 000. C'est le defaut
 * F-6 sous une autre forme : un ecran qui affiche une valeur que le serveur
 * n'applique pas.
 *
 * @param {import('./context.js').Context} ctx
 * @param {{ avantEnvoi?: () => void }} [opts]
 * @returns {Promise<boolean>} true si la reponse a ete emise
 */
export async function serveStatic(ctx, { avantEnvoi = null } = {}) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;

  const absolutePath = resolveSafePath(ctx.path);
  if (!absolutePath) return false;

  const file = await loadFile(absolutePath);
  if (!file) return false;

  // Le fichier existe : c'est seulement maintenant qu'il compte comme tel.
  if (avantEnvoi) avantEnvoi();

  applySecurityHeaders(ctx.res, { kind: 'app' });

  // Revalidation conditionnelle : le navigateur ne retelecharge un fichier
  // que lorsque son contenu a reellement change.
  if (ctx.req.headers['if-none-match'] === file.etag) {
    ctx.responded = true;
    ctx.res.writeHead(304, { ETag: file.etag });
    ctx.res.end();
    return true;
  }

  ctx.responded = true;
  ctx.res.writeHead(200, {
    'Content-Type': file.mime,
    'Content-Length': file.buffer.length,
    ETag: file.etag,
    // « no-cache » ne veut pas dire « ne pas mettre en cache » : le navigateur
    // conserve le fichier, mais demande a chaque fois s'il a change, et recoit
    // un 304 vide dans la quasi-totalite des cas. Le cout est une requete
    // conditionnelle ; le gain, qu'un deploiement soit visible tout de suite.
    //
    // L'ancienne valeur — une heure — supposait des ressources versionnees,
    // c'est-a-dire portant une empreinte dans leur nom. Elles ne le sont pas :
    // « app.js » garde son nom d'une version a l'autre. Pendant une heure
    // apres chaque mise en ligne, un navigateur pouvait donc servir l'ancien
    // code sans rien demander — et l'on croyait le correctif non deploye.
    //
    // ELLES LE SONT DESORMAIS, mais par leur ADRESSE et non par leur nom :
    // « /js/views/admin.js?v=15ec732 ». Une adresse qui porte la version
    // courante designe un contenu qui ne changera plus jamais — elle peut donc
    // etre gardee sans rien redemander. Une adresse sans version, ou portant
    // une version perimee, retombe sur « no-cache » : c'est ce qui rend le
    // cache long impossible a obtenir par accident, et un ancien code
    // impossible a servir apres une mise en ligne.
    //
    // JAMAIS UN DOCUMENT. Le document d'accueil est ce qui designe les
    // nouvelles adresses : garde un an, il continuerait de designer les
    // anciennes, et c'est la contradiction que la version dans l'adresse a
    // levee. « / » ne passe pas par ici, mais « /index.html?v=<courante> »
    // oui, et il ressortait « immutable » — verifie sur l'application
    // demarree. Un navigateur qui avait cette adresse en signet gardait
    // l'ancienne coquille apres chaque mise en ligne.
    'Cache-Control': ctx.query('v') && ctx.query('v') === config.version
      && !file.mime.startsWith('text/html')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  ctx.res.end(ctx.method === 'HEAD' ? undefined : file.buffer);
  return true;
}

/** Charge le document d'accueil de l'application monopage. */
export async function loadAppShell() {
  const file = await loadFile(path.join(PUBLIC_DIR, 'index.html'));
  return file ? file.buffer.toString('utf8') : null;
}
