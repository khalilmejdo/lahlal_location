/**
 * Routeur minimal.
 *
 * Les chemins sont declares sous la forme "/api/missions/:id". Le filtrage se
 * fait segment par segment : aucune expression reguliere n'est construite a
 * partir d'une chaine fournie par le client, ce qui exclut toute attaque par
 * expression reguliere degeneree.
 *
 * Chaque route porte ses propres exigences : authentification, permission,
 * limitation de debit specifique. Ces exigences sont declaratives, donc
 * verifiables d'un coup d'oeil dans les fichiers de routes.
 */
import { notFound, forbidden, unauthorized, AppError } from '../core/errors.js';
import { can } from '../core/rbac.js';

/** @typedef {import('./context.js').Context} Context */

export class Router {
  constructor() {
    /** @type {Map<string, Array<object>>} routes indexees par methode */
    this.routes = new Map();
  }

  /**
   * @param {string} method
   * @param {string} path       ex. "/api/missions/:id"
   * @param {(ctx: Context) => Promise<any>} handler
   * @param {object} [opts]
   * @param {boolean} [opts.public]      route accessible sans authentification
   * @param {string|string[]} [opts.permission] permission(s) requise(s)
   * @param {boolean} [opts.anyPermission]  une seule des permissions suffit
   * @param {boolean} [opts.skipCsrf]    dispense de jeton CSRF (connexion)
   * @param {{max:number, windowMs:number}} [opts.rateLimit]
   */
  add(method, path, handler, opts = {}) {
    const verb = method.toUpperCase();
    if (!this.routes.has(verb)) this.routes.set(verb, []);

    const segments = path.split('/').filter(Boolean);
    this.routes.get(verb).push({
      path,
      segments,
      // Une route sans parametre se compare directement, sans boucle.
      isStatic: !segments.some((s) => s.startsWith(':') || s === '*'),
      handler,
      options: opts,
    });
    return this;
  }

  get(path, handler, opts) {
    return this.add('GET', path, handler, opts);
  }
  post(path, handler, opts) {
    return this.add('POST', path, handler, opts);
  }
  put(path, handler, opts) {
    return this.add('PUT', path, handler, opts);
  }
  patch(path, handler, opts) {
    return this.add('PATCH', path, handler, opts);
  }
  delete(path, handler, opts) {
    return this.add('DELETE', path, handler, opts);
  }

  /** Fusionne un autre routeur, en prefixant ses chemins. */
  mount(prefix, router) {
    for (const [verb, routes] of router.routes) {
      for (const route of routes) {
        this.add(verb, prefix + route.path, route.handler, route.options);
      }
    }
    return this;
  }

  /**
   * Recherche la route correspondant a la requete.
   * @returns {{route: object, params: Record<string,string>}|null}
   */
  match(method, path) {
    const verb = method.toUpperCase();
    const candidates = this.routes.get(verb === 'HEAD' ? 'GET' : verb);
    if (!candidates) return null;

    const segments = path.split('/').filter(Boolean);

    for (const route of candidates) {
      if (route.isStatic) {
        // route.segments est deja calcule a l'enregistrement (add()) : le
        // redecouper ici repetait, a chaque requete et pour chaque route
        // statique candidate, un travail deja fait une fois pour toutes.
        if (route.segments.length === segments.length && route.segments.every((s, i) => s === segments[i])) {
          return { route, params: {} };
        }
        continue;
      }

      const params = matchSegments(route.segments, segments);
      if (params) return { route, params };
    }

    return null;
  }

  /** Indique si le chemin existe pour une autre methode (pour un 405 clair). */
  allowedMethods(path) {
    const allowed = [];
    for (const verb of this.routes.keys()) {
      if (this.match(verb, path)) allowed.push(verb);
    }
    return allowed;
  }
}

/**
 * Compare les segments declares aux segments recus.
 * @returns {Record<string,string>|null}
 */
function matchSegments(declared, received) {
  const params = {};

  for (let i = 0; i < declared.length; i++) {
    const pattern = declared[i];

    // Segment joker terminal : capture le reste du chemin.
    if (pattern === '*') {
      params.rest = received.slice(i).join('/');
      return params;
    }

    if (i >= received.length) return null;

    if (pattern.startsWith(':')) {
      const value = received[i];
      if (value === '') return null;
      params[pattern.slice(1)] = value;
      continue;
    }

    if (pattern !== received[i]) return null;
  }

  return declared.length === received.length ? params : null;
}

/* ------------------------------------------------------------------ */
/*  Verification des exigences d'une route                             */
/* ------------------------------------------------------------------ */

/**
 * Applique les exigences declarees sur la route avant d'appeler le
 * gestionnaire. Toute route non explicitement marquee `public` exige une
 * session valide : l'oubli d'une annotation ferme l'acces au lieu de l'ouvrir.
 *
 * @param {object} route
 * @param {Context} ctx
 */
export function enforceRouteRequirements(route, ctx) {
  const { options } = route;

  if (options.public) return;

  if (!ctx.user) {
    throw unauthorized('Votre session a expire. Veuillez vous reconnecter.');
  }

  // Un compte desactive en cours de session perd immediatement l'acces.
  if (ctx.user.isActive === false) {
    throw forbidden('Votre compte a ete desactive.');
  }

  // Un changement de mot de passe impose ne laisse passer que les routes
  // permettant precisement de le changer.
  if (ctx.user.mustChangePassword && !options.allowDuringPasswordChange) {
    // F-10 (recette) : un code propre — ce refus est un etat de session, pas
    // un refus de droit, et le journal d'audit ne doit pas le tracer comme tel.
    throw new AppError(403, 'Vous devez d abord definir un nouveau mot de passe.', {
      code: 'MOT_DE_PASSE_A_CHANGER',
    });
  }

  const required = options.permission;
  if (!required) return;

  const list = Array.isArray(required) ? required : [required];
  // M-01 : Array.prototype.every() rend vrai sur un tableau vide — une
  // route declaree avec permission: [] (une constante construite
  // dynamiquement qui se viderait par erreur, par exemple) passerait alors
  // le controle pour n'importe quel compte authentifie, sans l'omission
  // visible qui avait trahi J-02. Refuser par defaut, comme pour une
  // session absente ou un role inactif, plutot que de traiter une liste
  // vide comme une conjonction vacueusement vraie.
  if (list.length === 0) {
    throw forbidden('Route mal configuree : liste de permissions vide.');
  }
  const granted = options.anyPermission
    ? list.some((p) => can(ctx.user, p))
    : list.every((p) => can(ctx.user, p));

  if (!granted) {
    throw forbidden(
      "Cette action requiert une habilitation dont vous ne disposez pas (" + list.join(', ') + ').',
    );
  }
}

export { notFound };
