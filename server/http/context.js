/**
 * Contexte de requete : tout ce dont un gestionnaire de route a besoin,
 * regroupe dans un objet unique, plus les aides de reponse.
 */
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomToken, isUuid } from '../core/crypto.js';
import { sansOctetNul, isValidIsoDate } from '../core/text.js';
import { config } from '../core/config.js';
import { badRequest } from '../core/errors.js';
import { applySecurityHeaders, applyNoStore, clientIp, effectiveHost, effectiveProtocol } from './security.js';

/* ------------------------------------------------------------------ */
/*  Cookies                                                            */
/* ------------------------------------------------------------------ */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const segments = [name + '=' + encodeURIComponent(value)];

  segments.push('Path=' + (opts.path || '/'));
  if (opts.maxAge !== undefined) segments.push('Max-Age=' + Math.floor(opts.maxAge));
  if (opts.expires) segments.push('Expires=' + opts.expires.toUTCString());
  if (opts.domain) segments.push('Domain=' + opts.domain);

  // HttpOnly : le cookie de session reste inaccessible a tout JavaScript,
  // y compris a un script injecte.
  if (opts.httpOnly !== false) segments.push('HttpOnly');
  // Secure : le cookie ne circule qu'en HTTPS.
  if (opts.secure ?? config.security.secureCookies) segments.push('Secure');
  // SameSite=Strict : le cookie n'accompagne aucune requete venant d'un autre
  // site, ce qui neutralise la CSRF a la racine.
  segments.push('SameSite=' + (opts.sameSite || 'Strict'));

  return segments.join('; ');
}

/* ------------------------------------------------------------------ */
/*  Contexte                                                           */
/* ------------------------------------------------------------------ */

export class Context {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  constructor(req, res) {
    this.req = req;
    this.res = res;
    this.startedAt = Date.now();
    this.requestId = randomToken(9);

    this.method = String(req.method || 'GET').toUpperCase();

    const host = effectiveHost(req);
    const protocol = effectiveProtocol(req);
    const url = new URL(req.url || '/', protocol + '://' + (host || 'localhost'));

    this.host = host;
    this.protocol = protocol;
    this.url = url;
    // decodeURIComponent leve sur un echappement % mal forme (ex. « /% »).
    // Cet appel se trouve dans le constructeur, hors du .catch() qui entoure
    // handle(ctx) dans index.js : une exception ici est non capturee et
    // declenche l'arret du serveur (process.on('uncaughtException')). Une
    // seule requete non authentifiee suffisait donc a l'arreter.
    let chemin;
    try {
      chemin = decodeURIComponent(url.pathname);
    } catch {
      chemin = url.pathname;
    }
    this.path = chemin.replace(/\/+$/, '') || '/';
    this.searchParams = url.searchParams;
    this.ip = clientIp(req);
    this.userAgent = String(req.headers['user-agent'] || '').slice(0, 400);
    this.cookies = parseCookies(req.headers.cookie);

    /** @type {Record<string,string>} parametres de chemin (/:id) */
    this.params = {};
    /** @type {Record<string,any>} corps analyse */
    this.body = {};
    /** @type {Array<{field:string,filename:string,mimeType:string,content:Buffer}>} */
    this.files = [];

    /** @type {object|null} utilisateur authentifie */
    this.user = null;
    /** @type {object|null} session courante */
    this.session = null;

    this.responded = false;

    applySecurityHeaders(res, { kind: 'app' });
    res.setHeader('X-Request-Id', this.requestId);
  }

  /* ---------------- lecture des parametres ---------------- */

  /** Parametre d'URL, sous forme de chaine nettoyee. */
  query(name, fallback = undefined) {
    const value = this.searchParams.get(name);
    if (value === null || value === '') return fallback;
    // O-7, second point d'entree : un octet nul passe aussi par la chaine de
    // requete, et y produit la meme 500.
    return sansOctetNul(value).trim();
  }

  /** Parametre d'URL entier, borne. */
  queryInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
    const raw = this.searchParams.get(name);
    const n = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Parametre d'URL entier, STRICT : absent -> fallback (null par defaut) ;
   * present mais qui n'est pas un entier, ou hors bornes -> 400 qui nomme le
   * parametre.
   *
   * queryInt() rend son fallback des que la valeur ne se lit pas, et le
   * borne ensuite sans le dire : « ?year=abc » sur la rentabilite de la
   * flotte rendait « depuis toujours » (year: 0), « ?year=1900 » rendait
   * l'exercice 2000, tableau a zero, HTTP 200. L'utilisateur avait demande un
   * exercice et recevait autre chose sans un mot. queryInt() reste pour la
   * pagination, ou retomber sur la premiere page est le bon geste.
   */
  queryEntier(name, { min = -Infinity, max = Infinity, fallback = null } = {}) {
    const raw = this.searchParams.get(name);
    if (raw === null || raw === '') return fallback;
    const texte = sansOctetNul(raw).trim();
    const n = /^[+-]?\d+$/.test(texte) ? Number(texte) : Number.NaN;
    if (!Number.isSafeInteger(n)) {
      throw badRequest('Le parametre « ' + name + ' » doit être un nombre entier.',
        { fields: { [name]: 'Nombre entier attendu.' } });
    }
    if (n < min || n > max) {
      throw badRequest('Le parametre « ' + name + ' » doit être compris entre ' + min + ' et ' + max + '.',
        { fields: { [name]: 'Entre ' + min + ' et ' + max + '.' } });
    }
    return n;
  }

  /**
   * Parametre d'URL identifiant (UUID) : absent -> undefined ; mal forme ->
   * 400. Une valeur libre partait dans un « = $1 » sur une colonne UUID, et
   * PostgreSQL la refusait en 22P02 — remontee en 500 « erreur inattendue ».
   */
  queryUuid(name) {
    const value = this.query(name);
    if (value === undefined) return undefined;
    if (!isUuid(value)) {
      throw badRequest('Le parametre « ' + name + ' » n’est pas un identifiant valide.',
        { fields: { [name]: 'Identifiant invalide.' } });
    }
    return value;
  }

  /** Parametre d'URL date « AAAA-MM-JJ » : absent -> undefined ; mal forme -> 400. */
  queryDate(name) {
    const value = this.query(name);
    if (value === undefined) return undefined;
    if (!isValidIsoDate(value)) {
      throw badRequest('Le parametre « ' + name + ' » doit être une date au format AAAA-MM-JJ.',
        { fields: { [name]: 'Date attendue : AAAA-MM-JJ.' } });
    }
    return value;
  }

  /** Parametre d'URL booleen. */
  queryBool(name, fallback = false) {
    const raw = this.searchParams.get(name);
    if (raw === null || raw === '') return fallback;
    return /^(1|true|oui|yes|on)$/i.test(raw);
  }

  /** Pagination normalisee et bornee. */
  pagination({ defaultLimit = 50, maxLimit = 200 } = {}) {
    const limit = this.queryInt('limit', defaultLimit, { min: 1, max: maxLimit });
    const page = this.queryInt('page', 1, { min: 1, max: 100000 });
    return { limit, page, offset: (page - 1) * limit };
  }

  /* ---------------- cookies ---------------- */

  setCookie(name, value, opts) {
    const previous = this.res.getHeader('Set-Cookie');
    const serialized = serializeCookie(name, value, opts);
    const list = previous ? (Array.isArray(previous) ? [...previous, serialized] : [previous, serialized]) : [serialized];
    this.res.setHeader('Set-Cookie', list);
  }

  clearCookie(name, opts = {}) {
    this.setCookie(name, '', { ...opts, maxAge: 0, expires: new Date(0) });
  }

  /* ---------------- reponses ---------------- */

  /** Reponse JSON. Les reponses d'API ne sont jamais mises en cache. */
  json(status, payload) {
    if (this.responded) return;
    this.responded = true;
    applySecurityHeaders(this.res, { kind: 'api' });
    applyNoStore(this.res);
    const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
    this.res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
    });
    this.res.end(this.method === 'HEAD' ? undefined : body);
  }

  ok(payload) {
    this.json(200, payload);
  }

  created(payload) {
    this.json(201, payload);
  }

  noContent() {
    if (this.responded) return;
    this.responded = true;
    applyNoStore(this.res);
    this.res.writeHead(204);
    this.res.end();
  }

  /** Reponse HTML. `kind` ajuste la politique de securite du contenu. */
  html(status, markup, { kind = 'app', noStore = true } = {}) {
    if (this.responded) return;
    this.responded = true;
    applySecurityHeaders(this.res, { kind });
    if (noStore) applyNoStore(this.res);
    const body = Buffer.from(markup, 'utf8');
    this.res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
    });
    this.res.end(this.method === 'HEAD' ? undefined : body);
  }

  text(status, content) {
    if (this.responded) return;
    this.responded = true;
    applyNoStore(this.res);
    const body = Buffer.from(String(content), 'utf8');
    this.res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
    });
    this.res.end(this.method === 'HEAD' ? undefined : body);
  }

  /**
   * Envoi d'un fichier binaire (piece jointe, export).
   * Le nom de fichier est assaini : il ne doit jamais permettre d'injecter
   * un en-tete supplementaire dans la reponse.
   */
  file(buffer, { filename, mimeType = 'application/octet-stream', download = true } = {}) {
    if (this.responded) return;
    this.responded = true;
    applyNoStore(this.res);
    this.res.writeHead(200, enTetesDeFichier({
      filename, mimeType, download, taille: buffer.length,
    }));
    this.res.end(this.method === 'HEAD' ? undefined : buffer);
  }

  /**
   * Envoi d'un fichier DEPUIS LE DISQUE, sans jamais le tenir en memoire.
   *
   * file() prend un tampon : parfait pour une piece jointe de quelques
   * mega-octets, ruineux pour une archive de sauvegarde. La recette en a
   * mesure une a 614 Mo — la lire d'un bloc pour la renvoyer ferait, sur un
   * serveur de 4 Go, exactement la panne que les points 21 et 23 viennent de
   * supprimer ailleurs.
   *
   * Les en-tetes sont ceux de file(), fabriques par la meme fonction : le nom
   * de fichier est assaini une seule fois, au meme endroit, pour qu'il ne
   * puisse jamais injecter un en-tete supplementaire.
   *
   * @param {string} chemin  fichier a envoyer, deja valide par l'appelant
   * @param {{filename?: string, mimeType?: string, taille: number,
   *          enTetes?: Record<string,string>}} opts
   */
  async fichierEnFlux(chemin, { filename, mimeType = 'application/octet-stream', taille, enTetes = {} } = {}) {
    if (this.responded) return;
    this.responded = true;
    applyNoStore(this.res);
    this.res.writeHead(200, {
      ...enTetesDeFichier({ filename, mimeType, download: true, taille }),
      ...enTetes,
    });
    if (this.method === 'HEAD') { this.res.end(); return; }

    const flux = fs.createReadStream(chemin);
    try {
      await pipeline(flux, this.res);
    } catch (err) {
      // Les en-tetes sont deja partis : on ne peut plus repondre une erreur
      // propre. Couper la connexion est le seul signal honnete — un fichier
      // tronque qui se presenterait comme complet serait pire, puisque c'est
      // une SAUVEGARDE qu'on emporte.
      this.res.destroy();
      throw err;
    }
  }

  /** Redirection interne. Toute cible externe est refusee. */
  redirect(location, status = 302) {
    if (this.responded) return;
    this.responded = true;
    // Empeche la redirection ouverte : seules les cibles relatives internes
    // sont acceptees.
    const target = String(location);
    const safe = target.startsWith('/') && !target.startsWith('//') ? target : '/';
    this.res.writeHead(status, { Location: safe });
    this.res.end();
  }

  /** Duree de traitement de la requete, en millisecondes. */
  get elapsedMs() {
    return Date.now() - this.startedAt;
  }
}

/**
 * Les en-tetes d'un envoi de fichier.
 *
 * Une seule fabrique pour file() et fichierEnFlux() : le nom de fichier est
 * assaini ICI, et nulle part ailleurs. Recopie a deux endroits, la regle
 * finirait par diverger — et c'est elle qui empeche qu'un nom de fichier
 * injecte un en-tete supplementaire dans la reponse.
 */
function enTetesDeFichier({ filename, mimeType, download, taille }) {
  const safeName = String(filename || 'fichier')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w .\-()]/g, '_')
    .slice(0, 120);
  return {
    'Content-Type': mimeType,
    'Content-Length': taille,
    'Content-Disposition':
      (download ? 'attachment' : 'inline') +
      '; filename="' +
      safeName +
      '"; filename*=UTF-8\'\'' +
      encodeURIComponent(safeName),
    // Une piece jointe televersee par un utilisateur ne doit jamais etre
    // interpretee comme un document actif par le navigateur.
    'X-Content-Type-Options': 'nosniff',
  };
}
