/**
 * Les comptes et les roles.
 *
 * LA HIERARCHIE, ET POURQUOI ELLE EXISTE.
 *
 * Les permissions disent ce qu'on peut faire ; le RANG dit sur qui. Sans
 * rang, « user.manage » — que tout administrateur possede — permettrait a un
 * administrateur d'en desactiver un autre, de changer son mot de passe, ou
 * de se promouvoir super-administrateur. Chaque geste verifie donc deux
 * choses : la permission, et que la cible est d'un rang STRICTEMENT
 * inferieur a celui de l'auteur.
 *
 * Reprise de lahlal_samuplus, ou cette regle est le coeur du controle
 * d'acces. Le super-administrateur, lui, ne se cree pas depuis un ecran :
 * « npm run superadmin », donc un acces au serveur — un pouvoir qui ne se
 * prend pas, il se donne.
 */
import { Router } from '../http/router.js';
import { validate, validatePartial, rules } from '../core/validate.js';
import { newId, hashPassword, randomToken } from '../core/crypto.js';
import { notFound, conflict, badRequest, forbidden } from '../core/errors.js';
import { record, diff } from '../core/audit.js';
import { all, one, value, transaction } from '../db/index.js';
import { PERMISSIONS, isKnownPermission, RESERVE_SUPERADMIN } from '../core/rbac.js';
import { revokeAllUserSessions } from '../core/session.js';

export const userRoutes = new Router();

/* ------------------------------------------------------------------ */
/*  La regle de rang                                                   */
/* ------------------------------------------------------------------ */

/**
 * L'auteur peut-il agir sur cette cible ?
 *
 * Strictement : un rang egal ne suffit pas. Deux administrateurs ne se
 * touchent pas l'un l'autre — c'est ce qui empeche qu'un compte compromis
 * verrouille tous ses pairs.
 */
function exigerRangSuperieur(auteur, rangCible, quoi = 'ce compte') {
  if (!(auteur.roleRank < rangCible)) {
    throw forbidden(
      'Vous ne pouvez pas agir sur ' + quoi + ' : il relève d’un rôle de rang égal ou ' +
      'supérieur au vôtre.',
    );
  }
}

const presenter = (u) => ({
  id: u.id,
  username: u.username,
  fullName: u.full_name,
  email: u.email,
  phone: u.phone,
  actif: u.is_active,
  doitChangerMotDePasse: u.must_change_password,
  verrouilleJusqua: u.locked_until,
  derniereConnexion: u.last_login_at,
  role: { id: u.role_id, code: u.role_code, name: u.role_name, rank: u.role_rank },
  creeLe: u.created_at,
});

const SELECT_USER = `
  SELECT u.*, r.code AS role_code, r.name AS role_name, r.rank AS role_rank
    FROM users u JOIN roles r ON r.id = u.role_id`;

/* ------------------------------------------------------------------ */
/*  Liste et roles                                                     */
/* ------------------------------------------------------------------ */

userRoutes.get(
  '/',
  async (ctx) => {
    const lignes = await all(SELECT_USER + ' ORDER BY r.rank, u.username');
    ctx.ok({ comptes: lignes.map(presenter) });
  },
  { permission: 'user.view' },
);

userRoutes.get(
  '/roles',
  async (ctx) => {
    const roles = await all(
      `SELECT r.*, (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) AS nb_comptes,
              COALESCE(
                (SELECT array_agg(rp.permission_code ORDER BY rp.permission_code)
                   FROM role_permissions rp WHERE rp.role_id = r.id), '{}') AS permissions
         FROM roles r ORDER BY r.sort_order, r.rank`,
    );

    // Le catalogue complet n'est montre qu'a qui peut redefinir un role :
    // c'est lui seul qui a besoin de la liste des cases a cocher.
    const peutRedefinir = ctx.user.permissions.has('role.manage');

    ctx.ok({
      roles: roles.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        rank: r.rank,
        systeme: r.is_system,
        personnalise: r.is_customized,
        nbComptes: r.nb_comptes,
        permissions: r.permissions,
      })),
      catalogue: peutRedefinir ? PERMISSIONS : undefined,
      reserveSuperadmin: peutRedefinir ? RESERVE_SUPERADMIN : undefined,
    });
  },
  { permission: 'user.view' },
);

/* ------------------------------------------------------------------ */
/*  Creation                                                           */
/* ------------------------------------------------------------------ */

userRoutes.post(
  '/',
  async (ctx) => {
    const data = validate(ctx.body, {
      username: { type: 'string', required: true, min: 3, max: 40, lower: true },
      fullName: rules.requiredText(120),
      email: { type: 'email' },
      phone: rules.shortText(30),
      roleId: { type: 'uuid', required: true },
    });

    if (!/^[a-z0-9._-]{3,40}$/.test(data.username)) {
      throw badRequest('L’identifiant n’accepte que des minuscules, des chiffres, . _ et -.');
    }

    const role = await one('SELECT id, code, name, rank FROM roles WHERE id = $1', [data.roleId]);
    if (!role) throw notFound('Ce rôle n’existe pas.');
    // On ne cree pas un compte plus puissant que soi, ni son egal.
    exigerRangSuperieur(ctx.user, role.rank, 'un compte « ' + role.name + ' »');

    const pris = await value('SELECT username FROM users WHERE username_lower = $1', [data.username]);
    if (pris) throw conflict('L’identifiant « ' + data.username + ' » est déjà pris.');
    if (data.email) {
      const prisMail = await value('SELECT email FROM users WHERE email_lower = $1',
        [data.email.toLowerCase()]);
      if (prisMail) throw conflict('Cette adresse électronique est déjà associée à un compte.');
    }

    // Mot de passe genere, affiche UNE fois, a changer a la connexion.
    const motDePasse = randomToken(16).replace(/[-_]/g, 'x').slice(0, 18);
    const id = newId();

    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users
           (id, username, username_lower, email, email_lower, full_name, phone,
            password_hash, must_change_password, role_id, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,TRUE,$10)`,
        [id, data.username, data.username, data.email ?? null,
         data.email ? data.email.toLowerCase() : null, data.fullName, data.phone ?? null,
         await hashPassword(motDePasse), role.id, ctx.user.id],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'user.create',
        entity: 'user',
        entityId: id,
        entityLabel: data.username,
        summary: 'Création du compte « ' + data.username + ' » (' + role.name + ').',
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    ctx.created({
      compte: presenter(await one(SELECT_USER + ' WHERE u.id = $1', [id])),
      // Rendu une seule fois, et jamais reaffichable.
      motDePasseProvisoire: motDePasse,
    });
  },
  { permission: 'user.manage' },
);

/* ------------------------------------------------------------------ */
/*  Modification                                                       */
/* ------------------------------------------------------------------ */

userRoutes.patch(
  '/:id',
  async (ctx) => {
    const avant = await one(SELECT_USER + ' WHERE u.id = $1', [ctx.params.id]);
    if (!avant) throw notFound('Ce compte n’existe pas.');
    exigerRangSuperieur(ctx.user, avant.role_rank);

    const data = validatePartial(ctx.body, {
      fullName: rules.shortText(120),
      email: { type: 'email' },
      phone: rules.shortText(30),
      roleId: { type: 'uuid' },
      actif: { type: 'bool' },
    });
    if (!Object.keys(data).length) throw badRequest('Aucune modification demandée.');

    if (data.roleId) {
      const role = await one('SELECT id, name, rank FROM roles WHERE id = $1', [data.roleId]);
      if (!role) throw notFound('Ce rôle n’existe pas.');
      // On ne promeut pas quelqu'un a son propre rang, ni au-dessus.
      exigerRangSuperieur(ctx.user, role.rank, 'un compte « ' + role.name + ' »');
    }

    // Se desactiver soi-meme fermerait la porte de l'interieur.
    if (data.actif === false && avant.id === ctx.user.id) {
      throw badRequest('Vous ne pouvez pas désactiver votre propre compte.');
    }

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET
           full_name = COALESCE($2, full_name),
           email     = CASE WHEN $3::bool THEN $4 ELSE email END,
           email_lower = CASE WHEN $3::bool THEN lower($4) ELSE email_lower END,
           phone     = CASE WHEN $5::bool THEN $6 ELSE phone END,
           role_id   = COALESCE($7, role_id),
           is_active = COALESCE($8, is_active),
           deactivated_at = CASE WHEN $8::bool IS FALSE THEN now()
                                 WHEN $8::bool IS TRUE  THEN NULL
                                 ELSE deactivated_at END,
           updated_at = now()
         WHERE id = $1`,
        [avant.id, data.fullName ?? null,
         'email' in data, data.email ?? null,
         'phone' in data, data.phone ?? null,
         data.roleId ?? null, data.actif ?? null],
      );

      const apres = await tx.one(SELECT_USER + ' WHERE u.id = $1', [avant.id]);
      await record({
        tx,
        actor: ctx.user,
        action: 'user.update',
        entity: 'user',
        entityId: avant.id,
        entityLabel: avant.username,
        summary: 'Modification du compte « ' + avant.username + ' ».',
        changes: diff(avant, apres, {
          fields: ['full_name', 'email', 'phone', 'role_id', 'is_active'],
        }),
        severity: 'notice',
        ip: ctx.ip,
      });
    });

    // Un changement de role ou une desactivation doit prendre effet TOUT DE
    // SUITE : les sessions ouvertes portent les anciennes permissions, et
    // une session vit jusqu'a douze heures.
    if (data.roleId || data.actif === false) {
      await revokeAllUserSessions(avant.id, 'droits modifiés par un administrateur');
    }

    ctx.ok({ compte: presenter(await one(SELECT_USER + ' WHERE u.id = $1', [avant.id])) });
  },
  { permission: 'user.manage' },
);

/* ------------------------------------------------------------------ */
/*  Reinitialisation du mot de passe                                   */
/* ------------------------------------------------------------------ */

userRoutes.post(
  '/:id/mot-de-passe',
  async (ctx) => {
    const cible = await one(SELECT_USER + ' WHERE u.id = $1', [ctx.params.id]);
    if (!cible) throw notFound('Ce compte n’existe pas.');
    exigerRangSuperieur(ctx.user, cible.role_rank);

    const motDePasse = randomToken(16).replace(/[-_]/g, 'x').slice(0, 18);

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(),
                          must_change_password = TRUE, failed_attempts = 0,
                          locked_until = NULL, updated_at = now()
          WHERE id = $1`,
        [cible.id, await hashPassword(motDePasse)],
      );
      await record({
        tx,
        actor: ctx.user,
        action: 'user.password_reset',
        entity: 'user',
        entityId: cible.id,
        entityLabel: cible.username,
        summary: 'Réinitialisation du mot de passe de « ' + cible.username + ' ».',
        severity: 'critical',
        ip: ctx.ip,
      });
    });

    // Toutes ses sessions tombent : un mot de passe reinitialise ne laisse
    // pas ouverte la session de celui a qui on l'a repris.
    await revokeAllUserSessions(cible.id, 'mot de passe réinitialisé');

    ctx.ok({ motDePasseProvisoire: motDePasse });
  },
  { permission: 'user.manage' },
);

/* ------------------------------------------------------------------ */
/*  Redefinition des droits d'un role                                  */
/* ------------------------------------------------------------------ */

userRoutes.put(
  '/roles/:id/permissions',
  async (ctx) => {
    const role = await one('SELECT * FROM roles WHERE id = $1', [ctx.params.id]);
    if (!role) throw notFound('Ce rôle n’existe pas.');
    if (role.code === 'SUPERADMIN') {
      throw badRequest('Les droits du super-administrateur ne se redéfinissent pas : il les a tous.');
    }
    exigerRangSuperieur(ctx.user, role.rank, 'le rôle « ' + role.name + ' »');

    const { permissions } = validate(ctx.body, {
      permissions: { type: 'array', required: true, of: { type: 'string', max: 60 }, max: 200 },
    });

    const inconnues = permissions.filter((p) => !isKnownPermission(p));
    if (inconnues.length) {
      throw badRequest('Permissions inconnues : ' + inconnues.join(', ') + '.');
    }

    const avant = await all(
      'SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY 1', [role.id],
    ).then((r) => r.map((x) => x.permission_code));

    const demandees = [...new Set(permissions)].sort();

    await transaction(async (tx) => {
      await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
      if (demandees.length) {
        await tx.query(
          `INSERT INTO role_permissions (role_id, permission_code)
           SELECT $1, code FROM unnest($2::text[]) AS code`,
          [role.id, demandees],
        );
      }
      // Le role porte desormais une decision humaine : le seed ne doit plus
      // la rejouer au prochain demarrage.
      await tx.query('UPDATE roles SET is_customized = TRUE WHERE id = $1', [role.id]);

      await record({
        tx,
        actor: ctx.user,
        action: 'role.permissions',
        entity: 'role',
        entityId: role.id,
        entityLabel: role.name,
        summary:
          'Droits du rôle « ' + role.name + ' » redéfinis : ' + demandees.length + ' permission(s). ' +
          'Ajoutées : ' + (demandees.filter((p) => !avant.includes(p)).join(', ') || 'aucune') +
          '. Retirées : ' + (avant.filter((p) => !demandees.includes(p)).join(', ') || 'aucune') + '.',
        severity: 'critical',
        ip: ctx.ip,
      });
    });

    // Les sessions des titulaires portent les anciens droits : elles tombent.
    const titulaires = await all('SELECT id FROM users WHERE role_id = $1', [role.id]);
    for (const t of titulaires) {
      await revokeAllUserSessions(t.id, 'droits du rôle redéfinis');
    }

    ctx.ok({ roleId: role.id, permissions: demandees });
  },
  { permission: 'role.manage' },
);

