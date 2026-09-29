/**
 * En-tetes de securite HTTP et controle d'origine.
 *
 * La politique de securite du contenu (CSP) est volontairement stricte : ni
 * script en ligne, ni style en ligne, ni ressource externe. Toute la fonte,
 * tout le CSS et tout le JavaScript de l'application sont servis depuis la
 * meme origine. C'est ce qui rend une injection de script inoperante meme si
 * une faille d'echappement passait entre les mailles.
 */
import { config } from '../core/config.js';

/* ------------------------------------------------------------------ */
/*  Politique de securite du contenu                                   */
/* ------------------------------------------------------------------ */

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",          // aucun greffon
  "frame-src 'self'",           // apercu d'un document archive
  "frame-ancestors 'none'",     // interdit l'encapsulation : anti-clickjacking
  "base-uri 'none'",            // interdit la reecriture des URL relatives
  "form-action 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

/**
 * CSP appliquee aux documents archives (factures, devis) restitues tels quels.
 * Ces documents contiennent leur mise en forme en ligne, puisqu'ils doivent
 * rester fideles des annees apres leur emission. On compense en interdisant
 * absolument tout le reste : aucun script, aucune requete sortante.
 */
const DOCUMENT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src 'none'",
  "script-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join('; ');

/* ------------------------------------------------------------------ */
/*  Application des en-tetes                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {import('node:http').ServerResponse} res
 * @param {{ kind?: 'app'|'document'|'api' }} [opts]
 */
export function applySecurityHeaders(res, opts = {}) {
  const { kind = 'app' } = opts;

  if (kind === 'document') {
    res.setHeader('Content-Security-Policy', DOCUMENT_CSP);
  } else if (kind === 'api') {
    // Une reponse d'API ne doit jamais etre interpretee comme un document.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  } else {
    res.setHeader('Content-Security-Policy', APP_CSP);
  }

  // Empeche le navigateur de deviner un type MIME : une image piegee ne peut
  // pas etre reinterpretee comme du HTML ou du JavaScript.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // K-13 : le document d'apercu est fait pour etre encapsule par l'application
  // (frame-ancestors 'self') ; « DENY » disait le contraire dans l'en-tete
  // d'a cote. Les deux en-tetes disent la meme chose, pour chaque genre.
  res.setHeader('X-Frame-Options', kind === 'document' ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  // Aucune fonctionnalite materielle n'est utilisee par l'application.
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  );

  if (config.security.enableHsts) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Ne jamais reveler la pile technique.
  res.removeHeader('X-Powered-By');
}

/** En-tetes interdisant toute mise en cache d'une reponse sensible. */
export function applyNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/* ------------------------------------------------------------------ */
/*  Controle d'origine (defense CSRF complementaire)                   */
/* ------------------------------------------------------------------ */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isSafeMethod = (method) => SAFE_METHODS.has(String(method).toUpperCase());

/**
 * Verifie que la requete mutante provient bien de l'application.
 *
 * C'est la premiere des deux barrieres anti-CSRF ; la seconde est le jeton
 * synchronise verifie dans le middleware csrf. Une requete forgee depuis un
 * autre site echoue ici, avant meme d'atteindre la logique metier.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} host  hote effectif de la requete
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkOrigin(req, host) {
  if (isSafeMethod(req.method)) return { ok: true };

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  const allowed = new Set(config.http.allowedOrigins);
  // L'origine correspondant a l'hote courant est toujours acceptee : cela
  // evite de devoir reconfigurer l'application a chaque changement de domaine.
  if (host) {
    allowed.add('https://' + host);
    if (!config.security.secureCookies) allowed.add('http://' + host);
  }

  if (origin) {
    return allowed.has(origin)
      ? { ok: true }
      : { ok: false, reason: 'Origine non autorisee : ' + origin };
  }

  // Certains navigateurs omettent Origin ; on se rabat alors sur Referer.
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return allowed.has(refOrigin)
        ? { ok: true }
        : { ok: false, reason: 'Referent non autorise : ' + refOrigin };
    } catch {
      return { ok: false, reason: 'Referent illisible.' };
    }
  }

  // Ni Origin ni Referer sur une requete mutante : comportement anormal pour
  // un navigateur moderne, on refuse.
  return { ok: false, reason: 'Origine de la requete absente.' };
}

/* ------------------------------------------------------------------ */
/*  Adresse du client                                                  */
/* ------------------------------------------------------------------ */

/**
 * Adresse du client dans une chaine X-Forwarded-For.
 *
 * La version precedente retenait le PREMIER element. C'est l'erreur classique,
 * et elle est exploitable : le client controle ce qu'il envoie. Il suffisait
 * d'emettre « X-Forwarded-For: 203.0.113.1 » puis « ...113.2 » a chaque
 * requete pour se presenter sous une adresse neuve, et toute la limitation de
 * debit par adresse — y compris les dix tentatives de connexion par
 * cinq minutes — cessait de mordre.
 *
 * Le proxy AJOUTE l'adresse du pair qu'il voit a la fin de la chaine. Le
 * dernier element est donc le seul qu'un client ne peut pas ecrire : c'est
 * celui que notre propre proxy a constate. Avec deux proxys en cascade, il
 * faut remonter d'un cran de plus — d'ou TRUST_PROXY_HOPS.
 *
 * Fonction pure, pour etre verifiable sans requete.
 *
 * @param {string|string[]|undefined} entete  valeur brute de X-Forwarded-For
 * @param {number} sauts  nombre de proxys de confiance devant l'application
 * @returns {string|null}
 */
export function adresseDepuisChaine(entete, sauts = 1) {
  if (!entete) return null;

  const chaine = (Array.isArray(entete) ? entete.join(',') : String(entete))
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

  if (!chaine.length) return null;

  const bonds = Math.max(1, Math.trunc(Number(sauts) || 1));
  // On compte depuis la fin : la position 1 designe le dernier element.
  const index = chaine.length - bonds;

  // F-4 : le repli « index < 0 ? chaine[0] » rendait le PREMIER element —
  // celui que le client ecrit lui-meme. Avec TRUST_PROXY_HOPS = 2 et une
  // chaine plus courte que prevu, un simple « X-Forwarded-For: 9.9.9.9 »
  // devenait donc l'adresse retenue : un en-tete forge et tournant faisait
  // passer 25 connexions sans un seul 429, et toute la limitation de debit
  // par adresse cessait de mordre.
  //
  // Une chaine plus courte que le nombre de proxys declares dit une seule
  // chose : l'infrastructure n'a pas ajoute ce que la configuration promet.
  // Aucune position de cette chaine n'est alors digne de confiance. On rend
  // null, et l'appelant retombe sur l'adresse de la socket — la seule qu'un
  // client ne puisse pas ecrire.
  if (index < 0) return null;
  return chaine[index];
}

/**
 * L'adresse du client, decidee sans requete.
 *
 * X-Forwarded-For n'est pris en compte que derriere un proxy declare, et
 * seule la partie de la chaine ecrite par nos propres proxys est retenue.
 *
 * X-REAL-IP N'EST LU QUE SI L'EXPLOITANT LE DECLARE. Il etait accepte sans
 * condition des que TRUST_PROXY etait actif, au motif que « ni Traefik ni
 * Nginx ne laissent passer celui du client par defaut » — c'est-a-dire que
 * la protection reposait sur ce qu'un proxy qu'on ne controle pas ici
 * ecrase ou non un en-tete. Sans chaine X-Forwarded-For, un client qui
 * faisait tourner X-Real-IP se presentait sous une adresse neuve a chaque
 * appel : 25 connexions sans un seul 429, et 1 340 mots de passe evalues en
 * 30 secondes sur un compte pourtant verrouille (points 16 et 17 du rapport
 * de recette). Toute la limitation de debit par adresse tenait a un en-tete
 * que le client pouvait ecrire.
 *
 * Quand rien de fiable n'est lisible, c'est l'adresse de la socket — la seule
 * qu'un client ne puisse pas ecrire. TRUST_REAL_IP=true rend le comportement
 * d'avant, pour un montage ou le proxy ecrase cet en-tete a chaque requete.
 *
 * Fonction pure, pour etre verifiable sans requete.
 *
 * @param {object} arg
 * @param {boolean} arg.trustProxy
 * @param {boolean} [arg.trustRealIp]
 * @param {number} [arg.sauts]
 * @param {string|string[]|undefined} arg.xForwardedFor
 * @param {string|string[]|undefined} arg.xRealIp
 * @param {string|undefined} arg.socket   adresse du pair, vue par le serveur
 * @returns {string}
 */
export function adresseCliente({ trustProxy, trustRealIp = false, sauts = 1, xForwardedFor, xRealIp, socket }) {
  if (trustProxy) {
    const depuisChaine = adresseDepuisChaine(xForwardedFor, sauts);
    if (depuisChaine) return depuisChaine;

    if (trustRealIp && xRealIp) {
      const premiere = String(Array.isArray(xRealIp) ? xRealIp[0] : xRealIp).split(',')[0].trim();
      if (premiere) return premiere;
    }
  }
  return socket || 'inconnue';
}

/** Adresse IP du client de cette requete, par la regle ci-dessus. */
export function clientIp(req) {
  return adresseCliente({
    trustProxy: config.http.trustProxy,
    trustRealIp: config.http.trustRealIp,
    sauts: config.http.trustProxyHops,
    xForwardedFor: req.headers['x-forwarded-for'],
    xRealIp: req.headers['x-real-ip'],
    socket: req.socket?.remoteAddress,
  });
}

/** Hote effectif de la requete, valide contre les caracteres inattendus. */
export function effectiveHost(req) {
  const raw = config.http.trustProxy
    ? req.headers['x-forwarded-host'] || req.headers.host
    : req.headers.host;
  const host = String(raw || '').split(',')[0].trim();
  // Un en-tete Host contenant autre chose qu'un nom d'hote est ignore.
  return /^[a-zA-Z0-9.\-:[\]]+$/.test(host) ? host : '';
}

/**
 * K-8 : l'hote qui sert au controle d'origine.
 *
 * effectiveHost() croit X-Forwarded-Host derriere un proxy — un en-tete que
 * le client ecrit et qu'un proxy relaie souvent tel quel. Le controle
 * d'origine prenait donc son hote de l'attaquant : « Origin:
 * https://evil.example » passait des que « X-Forwarded-Host: evil.example »
 * l'accompagnait, et la premiere des deux barrieres anti-CSRF ne barrait
 * rien. Ici, seul Host compte : le navigateur le pose lui-meme, et un proxy
 * qui le conserve le transmet. Pour un proxy qui le reecrit, ALLOWED_ORIGINS
 * nomme l'origine (docs/DEPLOIEMENT-COOLIFY.md), et configWarnings() le
 * rappelle au demarrage en production.
 */
export function hostPourOrigine(req) {
  const host = String(req.headers.host || '').split(',')[0].trim();
  return /^[a-zA-Z0-9.\-:[\]]+$/.test(host) ? host : '';
}

/** Protocole effectif (http ou https). */
export function effectiveProtocol(req) {
  if (config.http.trustProxy) {
    const proto = req.headers['x-forwarded-proto'];
    if (proto) return String(proto).split(',')[0].trim().toLowerCase();
  }
  return req.socket?.encrypted ? 'https' : 'http';
}
