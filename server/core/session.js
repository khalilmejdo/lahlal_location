/**
 * Gestion des sessions et des jetons CSRF.
 *
 * Choix de conception :
 *   - Le jeton de session est un aleatoire de 256 bits transmis dans un cookie
 *     HttpOnly + Secure + SameSite=Strict. La base ne conserve que son
 *     condensat SHA-256 : un acces en lecture a la base ne permet pas de
 *     rejouer une session.
 *   - Deux expirations coexistent : une inactivite maximale (glissante) et une
 *     duree absolue. Une session oubliee sur un poste partage se ferme seule.
 *   - Le jeton de session est renouvele a chaque elevation de privilege
 *     (connexion, changement de mot de passe) pour interdire la fixation de
 *     session.
 */
import { newId, randomToken, hashToken, sign, timingSafeEqual } from './crypto.js';
import { config } from './config.js';
import { posture } from './posture.js';
import { all, one, execute } from '../db/index.js';
import { log } from './logger.js';

export const SESSION_COOKIE = 'lf_session';

/* ------------------------------------------------------------------ */
/*  Creation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ouvre une session pour un utilisateur.
 * @returns {Promise<{token:string, csrfToken:string, sessionId:string, expiresAt:Date}>}
 */
export async function createSession(userId, { ip, userAgent } = {}) {
  const sessionId = newId();
  const token = randomToken(32);
  const csrfSecret = randomToken(32);
  const expiresAt = new Date(Date.now() + posture().sessionAbsoluteMs);

  await execute(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_secret, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId, userId, hashToken(token), csrfSecret, ip ?? null, userAgent ?? null, expiresAt],
  );

  return {
    sessionId,
    token,
    csrfToken: makeCsrfToken(sessionId, csrfSecret),
    expiresAt,
  };
}

/* ------------------------------------------------------------------ */
/*  Chargement                                                         */
/* ------------------------------------------------------------------ */

/**
 * Charge la session et l'utilisateur associe a partir du jeton de cookie.
 * Retourne null si le jeton est inconnu, revoque, expire, ou si le compte a
 * ete desactive entre-temps.
 */
export async function loadSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;

  const row = await one(
    `SELECT s.id            AS session_id,
            s.csrf_secret,
            s.created_at,
            s.last_seen_at,
            s.expires_at,
            s.ip            AS session_ip,
            u.id            AS user_id,
            u.username,
            u.full_name,
            u.email,
            u.is_active,
            u.must_change_password,
            u.locked_until,
            r.id            AS role_id,
            r.code          AS role_code,
            r.rank          AS role_rank,
            r.name          AS role_name,
            -- Repliees dans cette meme requete : les permissions d'un role
            -- changent rarement, et un aller-retour SQL supplementaire sur
            -- chaque requete authentifiee de l'application n'en valait pas
            -- le cout.
            COALESCE(
              (SELECT array_agg(rp.permission_code)
                 FROM role_permissions rp WHERE rp.role_id = r.id),
              '{}'
            )               AS permission_codes,
            -- Exceptions propres au compte, au-dessus du role : voir
            -- user_permission_overrides (schema.sql) et la fusion ci-dessous.
            COALESCE(
              (SELECT array_agg(o.permission_code)
                 FROM user_permission_overrides o
                WHERE o.user_id = u.id AND o.effect = 'GRANT'),
              '{}'
            )               AS granted_overrides,
            COALESCE(
              (SELECT array_agg(o.permission_code)
                 FROM user_permission_overrides o
                WHERE o.user_id = u.id AND o.effect = 'DENY'),
              '{}'
            )               AS denied_overrides
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  );

  if (!row) return null;

  // Expiration par inactivite : verifiee en memoire pour rester independante
  // de l'horloge de la base.
  const lastSeen = new Date(row.last_seen_at).getTime();
  if (Date.now() - lastSeen > posture().sessionIdleMs) {
    await revokeSession(row.session_id, 'expiration par inactivite');
    return null;
  }

  if (!row.is_active) {
    await revokeSession(row.session_id, 'compte désactivé');
    return null;
  }

  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    await revokeSession(row.session_id, 'compte verrouillé');
    return null;
  }

  // Le role fixe la base ; une exception GRANT y ajoute un droit, une
  // exception DENY en retire un — dans cet ordre, pour que DENY l'emporte
  // toujours meme si le meme code apparaissait aussi cote role.
  const permissions = new Set(row.permission_codes || []);
  for (const code of row.granted_overrides || []) permissions.add(code);
  for (const code of row.denied_overrides || []) permissions.delete(code);

  return {
    session: {
      id: row.session_id,
      csrfSecret: row.csrf_secret,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      ip: row.session_ip,
    },
    user: {
      id: row.user_id,
      username: row.username,
      fullName: row.full_name,
      email: row.email,
      isActive: row.is_active,
      mustChangePassword: row.must_change_password,
      roleId: row.role_id,
      roleCode: row.role_code,
      roleRank: row.role_rank,
      roleName: row.role_name,
      permissions,
    },
  };
}

/** Permissions effectives d'un role. */
export async function loadPermissions(roleId) {
  const rows = await all('SELECT permission_code FROM role_permissions WHERE role_id = $1', [roleId]);
  return new Set(rows.map((r) => r.permission_code));
}

/**
 * Prolonge la session (expiration glissante).
 * L'ecriture n'a lieu qu'au-dela d'une minute, pour ne pas transformer chaque
 * requete de l'interface en ecriture en base.
 */
export async function touchSession(sessionId, lastSeenAt) {
  const elapsed = Date.now() - new Date(lastSeenAt).getTime();
  if (elapsed < 60000) return;
  try {
    await execute('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
  } catch (err) {
    log.warn('Impossible de prolonger la session', { error: err.message });
  }
}

/* ------------------------------------------------------------------ */
/*  Revocation                                                         */
/* ------------------------------------------------------------------ */

export async function revokeSession(sessionId, reason = 'deconnexion') {
  await execute(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

/**
 * Revoque toutes les sessions d'un utilisateur.
 * Appelee lors d'un changement de mot de passe, d'un changement de role ou
 * d'une desactivation de compte.
 */
export async function revokeAllUserSessions(userId, reason, { exceptSessionId = null } = {}) {
  if (exceptSessionId) {
    return execute(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL AND id <> $3`,
      [userId, reason, exceptSessionId],
    );
  }
  return execute(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
}

/** Sessions actives d'un utilisateur (ecran "mes appareils"). */
export async function listActiveSessions(userId) {
  return all(
    `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId],
  );
}

/** Purge les sessions expirees ou revoquees de plus de 30 jours. */
export async function purgeExpiredSessions() {
  return execute(
    `DELETE FROM sessions
      WHERE (expires_at < now() - interval '30 days')
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`,
  );
}

/* ------------------------------------------------------------------ */
/*  Jetons CSRF                                                        */
/* ------------------------------------------------------------------ */

/**
 * Jeton CSRF derive de la session : il ne peut pas etre devine par un site
 * tiers, et il devient caduc des que la session change.
 */
export function makeCsrfToken(sessionId, csrfSecret) {
  return sign(sessionId + ':' + csrfSecret);
}

/** Verifie un jeton CSRF a temps constant. */
export function verifyCsrfToken(session, provided) {
  if (!session || !provided) return false;
  return timingSafeEqual(makeCsrfToken(session.id, session.csrfSecret), provided);
}
