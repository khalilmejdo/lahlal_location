/**
 * Point d'entree du serveur.
 *
 * Enchainement d'une requete :
 *
 *   1. construction du contexte et pose des en-tetes de securite
 *   2. tentative de service d'un fichier statique (budget de debit propre)
 *   3. limitation de debit generale, par adresse
 *   4. recherche de la route
 *   5. chargement de la session depuis le cookie
 *   6. controle d'origine et du jeton CSRF pour toute requete mutante
 *   7. verification des exigences de la route (authentification, permission)
 *   8. lecture et analyse du corps
 *   9. execution du gestionnaire
 *  10. conversion de toute exception en reponse maitrisee
 *
 * Chaque etape refuse par defaut : une route sans annotation est protegee,
 * un corps de type inconnu est rejete, une exception inattendue ne divulgue
 * rien. Repris de lahlal_samuplus, ou cet enchainement a ete eprouve.
 */
import http from 'node:http';
import { config, assertConfig, configWarnings } from './core/config.js';
import { log } from './core/logger.js';
import { AppError, erreurDeTypePostgres, erreurBaseIndisponible } from './core/errors.js';
import { Context } from './http/context.js';
import { checkOrigin, isSafeMethod, hostPourOrigine } from './http/security.js';
import { serveStatic, loadAppShell } from './http/static.js';
import { enforceRouteRequirements } from './http/router.js';
import { parseBody } from './http/body.js';
import { consume, PROFILES } from './core/ratelimit.js';
import {
  SESSION_COOKIE, loadSession, touchSession, verifyCsrfToken, purgeExpiredSessions,
} from './core/session.js';
import { ping, closePool } from './db/index.js';
import { record, compterEntreePerdue } from './core/audit.js';
import { chargerPosture } from './core/posture.js';
import { chargerSeuils } from './domain/seuils.js';
import { buildRouter } from './app.js';
import { pagePatience } from './templates/patience.js';

assertConfig();

const router = buildRouter();

/* ------------------------------------------------------------------ */
/*  Traitement d'une requete                                           */
/* ------------------------------------------------------------------ */

/**
 * Toute adresse hors /api rend la coquille du SPA — sauf celles qui
 * ressemblent a un fichier. Sans cette distinction, « /package.json » et
 * « /server/core/config.js » rendraient la coquille en 200 : aucune fuite,
 * mais aucune supervision ne distinguerait plus un actif manquant d'un actif
 * servi. Les liens profonds du SPA ne portent pas d'extension.
 */
const ressembleAUnFichier = (chemin) => /\.[A-Za-z0-9]{1,8}$/.test(chemin.split('/').pop() || '');

/**
 * Faut-il journaliser ce refus de debit, ou l'a-t-on deja dit pour cette
 * adresse dans la minute ? Une ligne par refus ferait de la protection
 * anti-martellement le cout qu'elle doit eviter.
 */
const DERNIER_REFUS_JOURNALISE = new Map();
const FENETRE_JOURNAL_REFUS = 60000;
const MAX_ADRESSES_SUIVIES = 500;

function premierRefusDeLaPeriode(ip) {
  const maintenant = Date.now();
  const vu = DERNIER_REFUS_JOURNALISE.get(ip);
  if (vu && maintenant - vu < FENETRE_JOURNAL_REFUS) return false;
  if (DERNIER_REFUS_JOURNALISE.size >= MAX_ADRESSES_SUIVIES) DERNIER_REFUS_JOURNALISE.clear();
  DERNIER_REFUS_JOURNALISE.set(ip, maintenant);
  return true;
}

async function handle(ctx) {
  // --- 2. fichiers statiques, AVANT la limitation generale
  //
  // Ils ont leur propre compteur, genereux : une page de cette application
  // charge une vingtaine de modules, et trois actualisations suffiraient
  // sinon a epuiser le budget des ecrans — l'application deviendrait muette
  // a son propre utilisateur, coquille HTML comprise. Le compteur ne se
  // consomme QU'UNE FOIS LE FICHIER RECONNU, pour qu'un appel d'API ne le
  // voie jamais.
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    const servi = await serveStatic(ctx, {
      avantEnvoi: () => {
        const limiteFichiers = consume('statique:' + ctx.ip, PROFILES.statique);
        if (!limiteFichiers.allowed) {
          ctx.res.setHeader('Retry-After', String(limiteFichiers.retryAfterSeconds));
          throw new AppError(429, 'Trop de requêtes. Patientez quelques instants.', {
            details: { retryAfter: limiteFichiers.retryAfterSeconds },
          });
        }
      },
    });
    if (servi) return;
  }

  // --- 3. limitation de debit generale
  //
  // Par ADRESSE IP, et cela doit le rester : une cle qui viendrait de la
  // requete se falsifierait autant de fois qu'on veut de compteurs neufs.
  // Consequence assumee : les postes derriere une meme sortie internet
  // partagent ce budget. Il se regle a l'ecran.
  const limit = consume('ip:' + ctx.ip, PROFILES.standard);
  if (!limit.allowed) {
    ctx.res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    if (premierRefusDeLaPeriode(ctx.ip)) {
      log.warn('Debit general atteint', {
        ip: ctx.ip, path: ctx.path, retryAfter: limit.retryAfterSeconds,
      });
    }
    throw new AppError(429, 'Trop de requêtes. Patientez quelques instants.', {
      details: { retryAfter: limit.retryAfterSeconds },
    });
  }

  // --- 4. recherche de la route
  const matched = router.match(ctx.method, ctx.path);

  if (!matched) {
    if (!ctx.path.startsWith('/api/') && (ctx.method === 'GET' || ctx.method === 'HEAD')
      && !ressembleAUnFichier(ctx.path)) {
      const coquille = await loadAppShell();
      if (coquille) { ctx.html(200, coquille); return; }
    }
    const allowed = router.allowedMethods(ctx.path);
    if (allowed.length) {
      ctx.res.setHeader('Allow', allowed.join(', '));
      throw new AppError(405, 'Méthode non autorisée pour cette adresse.');
    }
    throw new AppError(404, 'Adresse inconnue.');
  }

  const { route, params } = matched;
  ctx.params = params;

  // --- 5. session
  const token = ctx.cookies[SESSION_COOKIE];
  if (token) {
    const loaded = await loadSession(token);
    if (loaded) {
      ctx.session = loaded.session;
      ctx.user = loaded.user;
      // Prolongation glissante, ecrite au plus une fois par minute.
      touchSession(loaded.session.id, loaded.session.lastSeenAt).catch(() => {});
    } else {
      ctx.clearCookie(SESSION_COOKIE);
    }
  }

  // --- 6. protections anti-CSRF
  if (!isSafeMethod(ctx.method) && !route.options.skipOriginCheck) {
    const origin = checkOrigin(ctx.req, hostPourOrigine(ctx.req));
    if (!origin.ok) {
      log.warn('Requete mutante refusee : origine invalide', {
        path: ctx.path, ip: ctx.ip, reason: origin.reason,
      });
      throw new AppError(403, 'Requête refusée : origine non reconnue.');
    }

    // Une route publique n'a pas de session, donc pas de jeton a deriver.
    // Ce n'est pas une protection qu'on retire : le jeton empeche un site
    // tiers de faire agir un utilisateur DEJA connecte a son insu, et sur
    // une route ouverte a tous il n'y a aucune session a detourner. Ce qui
    // protege reste : le controle d'origine, et la limitation de debit.
    if (!route.options.skipCsrf && !route.options.public) {
      // Le jeton voyage dans l'en-tete, et seulement la : le lire dans le
      // corps serait le lire avant que le corps soit analyse (etape 8).
      const provided = ctx.req.headers['x-csrf-token'];
      if (!ctx.session && token) {
        throw new AppError(401, 'Votre session a expiré ou a été fermée : reconnectez-vous.', {
          code: 'SESSION_INVALIDE',
        });
      }
      if (!ctx.session || !verifyCsrfToken(ctx.session, provided)) {
        throw new AppError(403, 'Jeton de sécurité absent ou invalide. Rechargez la page.', {
          code: 'CSRF_INVALIDE',
        });
      }
    }
  }

  // --- 7. exigences de la route
  enforceRouteRequirements(route, ctx);

  if (route.options.rateLimit) {
    const key = 'route:' + route.path + ':' + (ctx.user?.id || ctx.ip);
    const routeLimit = consume(key, route.options.rateLimit);
    if (!routeLimit.allowed) {
      ctx.res.setHeader('Retry-After', String(routeLimit.retryAfterSeconds));
      throw new AppError(429, 'Trop de tentatives sur cette opération. Patientez un instant.', {
        details: { retryAfter: routeLimit.retryAfterSeconds },
      });
    }
  }

  // --- 8. corps de la requete
  if (!isSafeMethod(ctx.method)) {
    const parsed = await parseBody(ctx.req, {
      jsonLimit: config.http.bodyLimitBytes,
      uploadLimit: config.storage.maxUploadBytes,
    });
    ctx.body = parsed.body;
    ctx.files = parsed.files;
  }

  // --- 9. gestionnaire
  await route.handler(ctx);

  if (!ctx.responded) {
    log.error('Gestionnaire sans reponse', { path: ctx.path, method: ctx.method });
    ctx.json(500, { error: { code: 'ERREUR', message: 'Réponse absente du serveur.' } });
  }
}

/* ------------------------------------------------------------------ */
/*  Trace des refus                                                    */
/* ------------------------------------------------------------------ */

/**
 * Un refus d'ecriture laisse une trace dans le JOURNAL, pas seulement dans
 * les logs.
 *
 * Ce qu'un controle cherche, ce n'est pas la liste de ce qui a marche —
 * c'est qui a essaye ce qu'il n'avait pas le droit de faire. Un fichier de
 * log que personne ne relit et que le redemarrage du conteneur emporte ne
 * repond pas a cette question.
 *
 * Ce qui est trace : les 403 de DROIT sur une methode d'ecriture, avec une
 * session. Pas les 409 (refus d'etat, bruit metier ordinaire), pas les 401
 * sans session (login_attempts les porte deja), pas les 429 (un balayage en
 * produirait des milliers).
 */
const CHEMIN_MAX_TRACE = 200;
const cheminTrace = (chemin) => {
  const texte = String(chemin || '');
  return texte.length > CHEMIN_MAX_TRACE
    ? texte.slice(0, CHEMIN_MAX_TRACE) + '… [' + texte.length + ' caractères]'
    : texte;
};

async function tracerRefus(ctx, err) {
  if (err.status !== 403) return;
  if (err.code !== 'ACCES_REFUSE') return;
  if (isSafeMethod(ctx.method)) return;
  if (!ctx.user) return;

  try {
    const chemin = cheminTrace(ctx.path);
    await record({
      actor: ctx.user,
      action: 'acces.refuse',
      entity: 'user',
      entityId: ctx.user.id,
      entityLabel: ctx.user.username,
      summary:
        'Geste refusé : ' + ctx.method + ' ' + chemin +
        '. Motif : ' + String(err.message || '').slice(0, 300),
      changes: { methode: ctx.method, chemin, code: err.code || null },
      severity: 'warning',
      ip: ctx.ip,
    });
  } catch (e) {
    log.error('Echec de la trace d un refus', { error: e.message, path: cheminTrace(ctx.path) });
  }
}

/*
 * Les traces passent par UNE file, l'une apres l'autre.
 *
 * Parties « void », sans attente, elles prenaient chacune une connexion du
 * pool : si audit_log etait lente, douze refus concurrents epuisaient les
 * huit connexions et les requetes legitimes tombaient en 500 — y compris
 * l'ecran qui aurait dit l'incident. Une file, une connexion au plus. Elle
 * est bornee ; au-dela, la trace est comptee perdue plutot que de retenir
 * la memoire.
 */
const FILE_TRACES_MAX = 1000;
let fileTraces = Promise.resolve();
let tracesEnAttente = 0;

function mettreEnFile(ctx, err) {
  if (tracesEnAttente >= FILE_TRACES_MAX) {
    compterEntreePerdue('acces.refuse', 'user');
    log.warn('File des traces de refus pleine : trace ecartee', { path: cheminTrace(ctx.path) });
    return;
  }
  tracesEnAttente += 1;
  fileTraces = fileTraces
    .then(() => tracerRefus(ctx, err))
    .catch(() => {})
    .finally(() => { tracesEnAttente -= 1; });
}

/** Attend que la file soit vide, ou compte ce qui reste (arret). */
export async function vidangerTraces(delaiMs = 5000) {
  const echue = new Promise((resolve) => setTimeout(resolve, delaiMs).unref?.());
  await Promise.race([fileTraces, echue]);
  if (tracesEnAttente > 0) {
    log.warn('Traces de refus encore en vol a l arret', { restantes: tracesEnAttente });
    for (let i = 0; i < tracesEnAttente; i += 1) compterEntreePerdue('acces.refuse', 'user');
  }
  return tracesEnAttente;
}

/* ------------------------------------------------------------------ */
/*  Gestion des erreurs                                                */
/* ------------------------------------------------------------------ */

/**
 * Cette requete attend-elle une PAGE, ou une reponse d'application ?
 *
 * Un appel d'API garde son JSON quoi qu'il demande — l'ecran sait le lire.
 * « Accept: text/html » sur un GET distingue une barre d'adresse d'un fetch.
 */
function veutUnePage(ctx) {
  if (ctx.path.startsWith('/api/')) return false;
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
  return String(ctx.req.headers.accept || '').includes('text/html');
}

function respondWithError(ctx, err) {
  if (ctx.responded) return;

  // Une valeur que la base refuse de convertir (22P02, 22007...) n'est pas
  // une panne du serveur : c'est une requete mal formee, et elle se dit.
  if (!(err instanceof AppError)) {
    const malFormee = erreurDeTypePostgres(err);
    if (malFormee) {
      log.warn('Parametre mal forme', {
        requestId: ctx.requestId, path: ctx.path, method: ctx.method, pgCode: err.code,
      });
      err = malFormee;
    }
  }
  // Base indisponible : ce n'est pas un bug, c'est un 503 qui dit sa cause.
  if (!(err instanceof AppError)) {
    const indisponible = erreurBaseIndisponible(err);
    if (indisponible) {
      log.error('Base indisponible', {
        requestId: ctx.requestId, path: ctx.path, method: ctx.method,
        pgCode: err.code, error: err.message,
      });
      ctx.res.setHeader('Retry-After', String(indisponible.details?.retryAfter ?? 5));
      err = indisponible;
    }
  }

  if (err instanceof AppError) {
    if (err.status === 401 || err.status === 403 || err.status === 429) {
      log.warn('Acces refuse', {
        status: err.status, path: ctx.path, method: ctx.method,
        ip: ctx.ip, user: ctx.user?.username, message: err.message,
      });
    }
    mettreEnFile(ctx, err);

    // Un navigateur qui demande une PAGE ne doit pas recevoir le JSON brut
    // de l'erreur en pleine fenetre : personne ne lit cela sans s'inquieter.
    if (veutUnePage(ctx)) {
      ctx.html(err.status, pagePatience({
        status: err.status,
        retryAfter: err.details?.retryAfter ?? null,
      }));
      return;
    }

    ctx.json(err.status, {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Erreur non prevue : le detail reste dans les journaux serveur, le client
  // ne recoit qu'un identifiant de correlation.
  log.error('Erreur non geree', {
    requestId: ctx.requestId, path: ctx.path, method: ctx.method,
    user: ctx.user?.username, error: err?.message, stack: err?.stack, pgCode: err?.code,
  });

  ctx.json(500, {
    error: {
      code: 'ERREUR_SERVEUR',
      message:
        'Une erreur inattendue est survenue. Si elle persiste, communiquez la référence ' +
        ctx.requestId + ' à votre administrateur.',
      requestId: ctx.requestId,
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Serveur                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const ctx = new Context(req, res);

  handle(ctx)
    .catch((err) => respondWithError(ctx, err))
    .finally(() => {
      const isStaticAsset = /\.(css|js|mjs|svg|png|jpg|jpeg|webp|ico|woff2?)$/.test(ctx.path);
      if (!isStaticAsset || res.statusCode >= 400) {
        log.info('requete', {
          id: ctx.requestId, method: ctx.method, path: ctx.path,
          status: res.statusCode, ms: ctx.elapsedMs,
          user: ctx.user?.username || null, ip: ctx.ip,
        });
      }
    });
});

// Bornes de protection contre les connexions lentes ou maintenues ouvertes.
server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 65000;
server.maxHeadersCount = 60;

/* ------------------------------------------------------------------ */
/*  Demarrage                                                          */
/* ------------------------------------------------------------------ */

async function start() {
  for (const warning of configWarnings()) log.warn('Configuration : ' + warning);

  try {
    const ms = await ping();
    log.info('Base de donnees joignable', { ms });
  } catch (err) {
    log.error('Base de donnees injoignable - demarrage interrompu', { error: err.message });
    console.error('\n  Impossible de joindre la base : ' + err.message);
    console.error('  Verifiez DATABASE_URL et DATABASE_SSL dans votre configuration.\n');
    process.exit(1);
  }

  // La posture de securite avant tout le reste : la premiere requete servie
  // doit deja se voir appliquer le delai d'inactivite reglé, pas celui de
  // l'environnement.
  const appliquee = await chargerPosture();
  log.info('Posture de securite appliquee', {
    inactiviteMin: appliquee.sessionIdleMinutes,
    dureeH: appliquee.sessionAbsoluteHours,
    tentatives: appliquee.loginMaxAttempts,
    motDePasseMin: appliquee.passwordMinLength,
  });

  // Les seuils d'alerte, pour la meme raison : le calcul d'un compte a
  // rebours est synchrone, il ne peut pas aller les chercher lui-meme.
  const seuilsAppliques = await chargerSeuils();
  log.info('Seuils d’alerte appliques', seuilsAppliques);

  // Menage periodique des sessions expirees.
  const purgeTimer = setInterval(() => {
    purgeExpiredSessions().catch((err) =>
      log.warn('Echec de la purge des sessions', { error: err.message }),
    );
  }, 3600000);
  purgeTimer.unref?.();

  server.listen(config.http.port, config.http.host, () => {
    log.info('Serveur demarre', {
      host: config.http.host,
      port: config.http.port,
      env: config.env,
      secureCookies: config.security.secureCookies,
      version: config.version,
    });
    console.log(
      '\n  Lahlal — gestion de flotte' +
      '\n  En ecoute sur http://' +
      (config.http.host === '0.0.0.0' ? 'localhost' : config.http.host) +
      ':' + config.http.port + '\n',
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Arret propre                                                       */
/* ------------------------------------------------------------------ */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Arret demande', { signal });

  server.close(async () => {
    // Les traces de refus encore en file s'ecrivent avant que le pool ne
    // ferme ; ce qui n'a pas pu l'etre est compte, pas oublie.
    await vidangerTraces().catch(() => {});
    await closePool().catch(() => {});
    log.info('Arret termine');
    process.exit(0);
  });

  setTimeout(() => {
    log.warn('Arret force apres delai');
    process.exit(1);
  }, 10000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('Promesse rejetee sans gestionnaire', { error: String(reason?.message || reason) });
});

process.on('uncaughtException', (err) => {
  log.error('Exception non capturee', { error: err.message, stack: err.stack });
  // Un etat incoherent ne doit pas etre poursuivi : l'orchestrateur redemarre.
  shutdown('uncaughtException');
});

start();
