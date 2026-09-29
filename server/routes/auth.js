/**
 * Authentification et gestion du compte courant.
 *
 * Mesures appliquees :
 *   - reponse volontairement identique que l'identifiant existe ou non, et
 *     verification d'un condensat factice dans le cas contraire, pour que la
 *     duree de traitement ne revele pas l'existence d'un compte ;
 *   - verrouillage progressif du compte apres plusieurs echecs, en base, donc
 *     efficace meme si l'attaquant change d'adresse IP ;
 *   - renouvellement systematique du jeton de session a la connexion et au
 *     changement de mot de passe (protection contre la fixation de session) ;
 *   - journalisation de chaque tentative, reussie ou non.
 */
import { Router } from '../http/router.js';
import { validate } from '../core/validate.js';
import { config } from '../core/config.js';
import { posture } from '../core/posture.js';
import { chargerSeuils } from '../domain/seuils.js';
import { hashPassword, verifyPassword, needsRehash } from '../core/crypto.js';
import { unauthorized, forbidden, badRequest, conflict } from '../core/errors.js';
import { record } from '../core/audit.js';
import { PROFILES } from '../core/ratelimit.js';
import { one, execute, transaction } from '../db/index.js';
import {
  SESSION_COOKIE,
  createSession,
  revokeSession,
  revokeAllUserSessions,
  listActiveSessions,
  makeCsrfToken,
  loadPermissions,
} from '../core/session.js';

export const authRoutes = new Router();

/**
 * Condensat factice, utilise lorsque l'identifiant est inconnu.
 * Il fait travailler scrypt exactement comme pour un compte reel, afin que la
 * duree de reponse ne trahisse pas l'existence du compte.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/* ------------------------------------------------------------------ */
/*  Representation de l'utilisateur cote client                        */
/* ------------------------------------------------------------------ */

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName ?? user.full_name,
    email: user.email,
    role: {
      code: user.roleCode ?? user.role_code,
      name: user.roleName ?? user.role_name,
    },
    mustChangePassword: user.mustChangePassword ?? user.must_change_password ?? false,
    permissions: [...(user.permissions ?? [])].sort(),
  };
}

/* ------------------------------------------------------------------ */
/*  Etat de la session                                                 */
/* ------------------------------------------------------------------ */

authRoutes.get(
  '/session',
  async (ctx) => {
    if (!ctx.user || !ctx.session) {
      ctx.ok({
        authenticated: false,
        // Parametres necessaires a l'ecran de connexion.
        settings: {
          passwordMinLength: posture().passwordMinLength,
          loginMaxAttempts: posture().loginMaxAttempts,
        },
      });
      return;
    }

    ctx.ok({
      authenticated: true,
      user: publicUser(ctx.user),
      csrfToken: makeCsrfToken(ctx.session.id, ctx.session.csrfSecret),
      session: {
        expiresAt: ctx.session.expiresAt,
        idleTimeoutMinutes: Math.round(posture().sessionIdleMs / 60000),
      },
      // Ce que l'ecran a besoin de savoir des l'ouverture, pour ne pas avoir
      // a le redemander : les seuils d'alerte (il colore les comptes a
      // rebours lui-meme) et la borne des televersements (il refuse un
      // fichier trop lourd avant de l'envoyer, plutot qu'apres).
      settings: {
        passwordMinLength: posture().passwordMinLength,
        seuils: await chargerSeuils(),
        uploadMaxBytes: config.storage.maxUploadBytes,
      },
    });
  },
  { public: true },
);

/* ------------------------------------------------------------------ */
/*  Connexion                                                          */
/* ------------------------------------------------------------------ */

const loginSchema = {
  username: { type: 'string', required: true, max: 80, lower: true },
  password: { type: 'string', required: true, max: 200, trim: false, min: 1 },
};

authRoutes.post(
  '/login',
  async (ctx) => {
    const data = validate(ctx.body, loginSchema);

    // Message unique, quel que soit le motif reel de l'echec.
    const genericFailure = unauthorized('Identifiant ou mot de passe incorrect.');

    const user = await one(
      `SELECT u.id, u.username, u.full_name, u.email, u.password_hash, u.is_active,
              u.must_change_password, u.failed_attempts, u.locked_until,
              r.id AS role_id, r.code AS role_code, r.name AS role_name
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.username_lower = $1 OR u.email_lower = $1`,
      [data.username],
    );

    if (!user) {
      await verifyPassword(data.password, DUMMY_HASH);
      await logAttempt(ctx, data.username, false, 'identifiant inconnu');
      throw genericFailure;
    }

    // Le mot de passe est verifie AVANT toute chose, y compris avant l'etat du
    // compte. C'est ce qui evite l'enumeration : annoncer « ce compte est
    // verrouille » a qui n'a pas le mot de passe revient a confirmer que
    // l'identifiant existe. Desormais, tant que le mot de passe est faux, la
    // reponse est la meme pour un compte verrouille, desactive ou inexistant.
    const valid = await verifyPassword(data.password, user.password_hash);

    if (!valid) {
      await registerFailure(ctx, user, data.username);
      throw genericFailure;
    }

    // A partir d'ici, l'appelant a prouve qu'il connait le mot de passe : lui
    // dire pourquoi il n'entre pas ne lui apprend plus rien qu'il ignore.
    const verrouilleJusqua = user.locked_until ? new Date(user.locked_until).getTime() : 0;

    if (verrouilleJusqua > Date.now()) {
      const minutes = Math.ceil((verrouilleJusqua - Date.now()) / 60000);
      await logAttempt(ctx, data.username, false, 'compte verrouillé, mot de passe correct');
      throw forbidden(
        'Ce compte est temporairement verrouillé à la suite de plusieurs tentatives de ' +
        'connexion infructueuses. Réessayez dans ' + minutes + ' minute(s), ou contactez ' +
        'votre administrateur si vous n’êtes pas à l’origine de ces tentatives.',
      );
    }

    if (!user.is_active) {
      await logAttempt(ctx, data.username, false, 'compte désactivé');
      throw forbidden('Ce compte a ete désactivé. Contactez votre administrateur.');
    }

    // --- Succes
    const session = await transaction(async (tx) => {
      await tx.query(
        `UPDATE users
            SET failed_attempts = 0, locked_until = NULL,
                last_login_at = now(), last_login_ip = $2
          WHERE id = $1`,
        [user.id, ctx.ip],
      );

      // Les parametres de scrypt ont pu evoluer depuis la creation du compte.
      if (needsRehash(user.password_hash)) {
        const fresh = await hashPassword(data.password);
        await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, fresh]);
      }

      await record({
        tx,
        actor: { id: user.id, username: user.username },
        action: 'auth.login',
        entity: 'user',
        entityId: user.id,
        entityLabel: user.username,
        summary: 'Connexion reussie depuis ' + ctx.ip + '.',
        ip: ctx.ip,
      });

      return null;
    });
    void session;

    const created = await createSession(user.id, { ip: ctx.ip, userAgent: ctx.userAgent });

    ctx.setCookie(SESSION_COOKIE, created.token, {
      maxAge: Math.floor(posture().sessionAbsoluteMs / 1000),
    });

    await logAttempt(ctx, data.username, true, null);
    // K-4 : le seau de l'adresse etait vide a chaque connexion reussie. Une
    // cadence « neuf essais, une connexion valide » depuis une seule adresse
    // evaluait 135 mots de passe en cinq minutes, sans un 429 — n'importe
    // quel compte suffisait a remettre le compteur a zero. Le budget de la
    // route (PROFILES.login) court sur sa fenetre, connexion reussie ou non.

    const permissions = await loadPermissions(user.role_id);

    ctx.ok({
      authenticated: true,
      user: publicUser({ ...user, fullName: user.full_name, permissions }),
      csrfToken: created.csrfToken,
      session: {
        expiresAt: created.expiresAt,
        idleTimeoutMinutes: Math.round(posture().sessionIdleMs / 60000),
      },
    });
  },
  {
    public: true,
    skipCsrf: true, // aucune session n'existe encore a cet instant
    rateLimit: PROFILES.login,
  },
);

/** Incremente le compteur d'echecs et verrouille au seuil configure. */
/**
 * F-1 : ce qu'un nouvel echec fait au compteur, et s'il verrouille.
 *
 * Le compteur n'etait jamais remis a zero a l'expiration du verrou. Il restait
 * donc au-dessus du seuil, et le PREMIER echec suivant suffisait a refermer le
 * compte pour une periode entiere — indefiniment, pour quatre requetes par
 * heure, pendant que le titulaire au bon mot de passe recevait un refus. Le
 * garde-fou pose contre la PROLONGATION du verrou ne servait a rien : le
 * verrou n'etait pas prolonge, il etait reconstruit a neuf.
 *
 * Un verrou echu clot la serie. L'echec qui le suit est le PREMIER d'une
 * nouvelle serie, pas le (max + 1)-ieme de celle qui a deja produit son verrou
 * et purge sa peine.
 *
 * Fonction pure : c'est ce qui permet d'eprouver la sequence complete —
 * echecs, verrou, expiration, echec suivant — sans base et sans horloge.
 *
 * @param {{echecsPrecedents: number, verrouilleJusqua: string|Date|null,
 *          maintenant: number, seuil: number}} etat
 * @returns {{echecs: number, verrouiller: boolean, serieClose: boolean}}
 */
export function compterEchec({ echecsPrecedents, verrouilleJusqua, maintenant, seuil }) {
  const echeance = verrouilleJusqua ? new Date(verrouilleJusqua).getTime() : 0;
  const serieClose = echeance > 0 && echeance <= maintenant;

  const echecs = (serieClose ? 0 : Number(echecsPrecedents || 0)) + 1;
  return { echecs, verrouiller: echecs >= seuil, serieClose };
}

/*
 * La regle de compterEchec(), ecrite en SQL parce qu'elle doit s'appliquer
 * DANS l'instruction d'ecriture.
 *
 * « failed_attempts = $2 », calcule en JS a partir d'une ligne lue plus tot,
 * est une lecture-modification-ecriture. Dix echecs simultanes lisaient tous 0
 * et ecrivaient tous 1 : le seuil etait hors d'atteinte en parallele —
 * exactement la situation qu'une attaque cree. « failed_attempts + 1 » est
 * reevalue par PostgreSQL sur la ligne qu'il verrouille, et dix echecs
 * simultanes rendent bien dix.
 *
 * compterEchec() reste l'enonce de reference de cette regle : elle est pure,
 * elle s'eprouve sans base ni horloge, et ce que le SQL ci-dessous fait doit
 * lui repondre. Les deux sont confrontees sur les memes entrees dans
 * test/verrou-de-compte.test.js.
 */
const SERIE_CLOSE = '(locked_until IS NOT NULL AND locked_until <= now())';
const AUCUN_VERROU_EN_COURS = '(locked_until IS NULL OR locked_until <= now())';
const ECHECS = 'CASE WHEN ' + SERIE_CLOSE + ' THEN 1 ELSE failed_attempts + 1 END';

/**
 * L'ecriture d'un echec, en une seule instruction.
 *
 * $1 identifiant, $2 seuil de verrouillage, $3 duree du verrou en millisecondes.
 *
 * Trois cas, dans cet ordre :
 *   1. le seuil est atteint et aucun verrou ne court -> on arme ;
 *   2. sinon, un verrou echu est EFFACE — c'est le correctif F-1 (suite) ;
 *   3. sinon, locked_until ne bouge pas : un verrou en cours ne se prolonge
 *      jamais, sans quoi qui connait un identifiant garde le compte ferme
 *      indefiniment en echouant regulierement.
 */
export const SQL_ECHEC =
  `UPDATE users
      SET failed_attempts = ${ECHECS},
          locked_until = CASE
            WHEN (${ECHECS}) >= $2 AND ${AUCUN_VERROU_EN_COURS}
              THEN now() + ($3 || ' milliseconds')::interval
            WHEN ${SERIE_CLOSE} THEN NULL
            ELSE locked_until
          END
    WHERE id = $1
    RETURNING failed_attempts, locked_until`;

async function registerFailure(ctx, user, attemptedUsername) {
  const seuil = posture().loginMaxAttempts;

  // F-1 (suite) : le verrou echu doit etre EFFACE. compterEchec() savait deja
  // reconnaitre une serie close et le disait par « serieClose » — mais
  // personne ne s'en servait, et locked_until gardait sa date passee. Chaque
  // echec suivant retrouvait donc une serie close, remettait le compteur a 1,
  // et le seuil n'etait plus jamais atteint : apres la premiere expiration, le
  // verrou ne se rearmait plus jamais. Vingt echecs de suite laissaient
  // failed_attempts a 1 et le compte grand ouvert.
  const apres = await one(SQL_ECHEC, [user.id, seuil, String(config.security.loginLockoutMs)]);

  await logAttempt(ctx, attemptedUsername, false, 'mot de passe incorrect');

  // Le journal dit ce qui s'est reellement produit en base, et non ce qu'un
  // calcul fait sur une lecture anterieure aurait prevu : sous concurrence,
  // les deux divergent, et c'est la base qui a raison.
  const actif = (valeur) => Boolean(valeur) && new Date(valeur).getTime() > Date.now();
  if (apres && actif(apres.locked_until) && !actif(user.locked_until)) {
    await record({
      action: 'auth.lockout',
      entity: 'user',
      entityId: user.id,
      entityLabel: user.username,
      summary:
        'Compte verrouillé après ' + apres.failed_attempts +
        ' echecs consecutifs (adresse ' + ctx.ip + ').',
      severity: 'warning',
      ip: ctx.ip,
    });
  }
}

async function logAttempt(ctx, username, success, reason) {
  await execute(
    `INSERT INTO login_attempts (username, ip, success, reason, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [String(username).slice(0, 80), ctx.ip, success, reason, ctx.userAgent],
  ).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  Deconnexion                                                        */
/* ------------------------------------------------------------------ */

authRoutes.post(
  '/logout',
  async (ctx) => {
    if (ctx.session) {
      await revokeSession(ctx.session.id, 'deconnexion volontaire');
      await record({
        actor: ctx.user,
        action: 'auth.logout',
        entity: 'user',
        entityId: ctx.user.id,
        entityLabel: ctx.user.username,
        summary: 'Deconnexion.',
        ip: ctx.ip,
      });
    }
    ctx.clearCookie(SESSION_COOKIE);
    ctx.ok({ ok: true });
  },
  { allowDuringPasswordChange: true },
);

/* ------------------------------------------------------------------ */
/*  Changement de mot de passe                                         */
/* ------------------------------------------------------------------ */

const passwordSchema = {
  currentPassword: { type: 'string', required: true, max: 200, trim: false, min: 1 },
  newPassword: { type: 'string', required: true, max: 200, trim: false, min: 1 },
};

authRoutes.post(
  '/password',
  async (ctx) => {
    const data = validate(ctx.body, passwordSchema);

    const user = await one('SELECT id, username, password_hash FROM users WHERE id = $1', [
      ctx.user.id,
    ]);

    const valid = await verifyPassword(data.currentPassword, user.password_hash);
    if (!valid) {
      await logAttempt(ctx, user.username, false, 'mot de passe actuel incorrect');
      throw unauthorized('Le mot de passe actuel est incorrect.');
    }

    const problems = checkPasswordPolicy(data.newPassword, {
      username: user.username,
      fullName: ctx.user.fullName,
    });
    if (problems.length) throw badRequest(problems[0], { fields: { newPassword: problems[0] } });

    if (await verifyPassword(data.newPassword, user.password_hash)) {
      throw conflict('Le nouveau mot de passe doit être different de l’ancien.');
    }

    const passwordHash = await hashPassword(data.newPassword);

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE users
            SET password_hash = $2, password_changed_at = now(),
                must_change_password = FALSE, updated_at = now()
          WHERE id = $1`,
        [user.id, passwordHash],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'auth.password_change',
        entity: 'user',
        entityId: user.id,
        entityLabel: user.username,
        summary: 'Mot de passe modifié par son titulaire.',
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    // Toutes les autres sessions sont fermees : si le mot de passe a ete
    // change parce qu'il etait compromis, l'intrus perd son acces.
    // K-9 : session.js promettait un jeton renouvele a chaque elevation de
    // privilege, connexion et changement de mot de passe compris ; ici rien
    // n'etait renouvele — meme cookie, meme jeton CSRF, l'ancien jeton
    // continuait d'ecrire. La session en cours est remplacee par une neuve,
    // et toutes les autres, l'ancienne comprise, sont fermees.
    const nouvelle = await createSession(user.id, { ip: ctx.ip, userAgent: ctx.userAgent });
    ctx.setCookie(SESSION_COOKIE, nouvelle.token, {
      maxAge: Math.floor(posture().sessionAbsoluteMs / 1000),
    });
    const revoked = await revokeAllUserSessions(user.id, 'changement de mot de passe', {
      exceptSessionId: nouvelle.sessionId,
    });
    const autres = Math.max(0, revoked - 1);

    ctx.ok({
      ok: true,
      revokedSessions: autres,
      csrfToken: nouvelle.csrfToken,
      session: { expiresAt: nouvelle.expiresAt },
      message:
        'Mot de passe modifié.' +
        (autres > 0 ? ' ' + autres + ' autre(s) session(s) ont ete fermees.' : ''),
    });
  },
  { allowDuringPasswordChange: true, rateLimit: { max: 10, windowMs: 600000 } },
);

/**
 * Politique de mot de passe.
 *
 * Longueur d'abord, conformement aux recommandations actuelles : un long
 * ensemble de mots vaut mieux qu'une courte suite de caracteres exotiques.
 * On refuse en revanche ce qui est trivialement devinable.
 */
export function checkPasswordPolicy(password, { username = '', fullName = '' } = {}) {
  const problems = [];
  const min = posture().passwordMinLength;

  if (password.length < min) {
    problems.push('Le mot de passe doit comporter au moins ' + min + ' caracteres.');
  }
  if (password.length > 200) {
    problems.push('Le mot de passe ne peut pas depasser 200 caracteres.');
  }

  const lower = password.toLowerCase();

  if (username && lower.includes(String(username).toLowerCase())) {
    problems.push('Le mot de passe ne doit pas contenir votre identifiant.');
  }
  for (const part of String(fullName).split(/\s+/).filter((p) => p.length >= 4)) {
    if (lower.includes(part.toLowerCase())) {
      problems.push('Le mot de passe ne doit pas contenir votre nom.');
      break;
    }
  }

  const banned = [
    'motdepasse', 'password', 'azerty', 'qwerty', '123456', 'samuplus',
    'lahlal', 'admin', 'ambulance', 'maroc',
  ];
  if (banned.some((b) => lower.includes(b))) {
    problems.push('Ce mot de passe contient un terme trop previsible.');
  }

  // Un mot de passe compose d'un seul caractere repete est refuse.
  if (/^(.)\1+$/.test(password)) {
    problems.push('Ce mot de passe est trop simple.');
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/*  Sessions actives du compte                                         */
/* ------------------------------------------------------------------ */

authRoutes.get('/sessions', async (ctx) => {
  const sessions = await listActiveSessions(ctx.user.id);
  ctx.ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      current: s.id === ctx.session.id,
    })),
  });
});

authRoutes.delete('/sessions/:id', async (ctx) => {
  const { id } = validate(ctx.params, { id: { type: 'uuid', required: true } });

  // Un utilisateur ne peut fermer que ses propres sessions.
  const session = await one('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [
    id,
    ctx.user.id,
  ]);
  if (!session) throw unauthorized('Session introuvable.');

  await revokeSession(id, 'fermeture demandee par l’utilisateur');

  // H-03 : ce geste ne laissait aucune trace, alors que ses deux freres — la
  // revocation par un administrateur et la connexion elle-meme — en laissent
  // une. Fermer une session a distance est precisement ce qu'on fait quand on
  // pense qu'un acces a ete pris : c'est le moment ou une trace compte, et
  // c'etait le seul des trois a n'en produire aucune.
  await record({
    actor: ctx.user,
    action: 'auth.session_close',
    entity: 'user',
    entityId: ctx.user.id,
    entityLabel: ctx.user.username,
    summary: id === ctx.session.id
      ? 'Deconnexion : fermeture de la session courante.'
      : 'Fermeture d’une autre session ouverte du compte.',
    severity: 'notice',
    ip: ctx.ip,
  });

  if (id === ctx.session.id) ctx.clearCookie(SESSION_COOKIE);

  ctx.ok({ ok: true, current: id === ctx.session.id });
});
