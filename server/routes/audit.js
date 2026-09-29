/**
 * Le journal d'audit.
 *
 * Il se lit, il se verifie, il ne se modifie pas — un declencheur PostgreSQL
 * refuse tout UPDATE et tout DELETE (schema.sql), et chaque entree est
 * chainee a la precedente par un condensat. C'est ce qui permet de repondre
 * a « qui a changé ce kilométrage, quand, et pourquoi ? » meme face a
 * quelqu'un disposant d'un acces direct a la base.
 */
import { Router } from '../http/router.js';
import { badRequest } from '../core/errors.js';
import { all, one, Where } from '../db/index.js';
import { verifyChain, journalPerdu, lastEntryHash } from '../core/audit.js';
import { likeContains } from '../core/text.js';

export const auditRoutes = new Router();

/**
 * Les filtres, reconstruits a l'identique pour la page et pour le total.
 *
 * Un Where consomme ses emplacements de parametres au fur et a mesure : il
 * ne se rejoue pas. Le compter avec une clause differente de celle qui a
 * servi a lire donnerait une pagination qui ne correspond a rien.
 */
function filtresAudit(ctx) {
  const w = new Where();
  w.add('1=1');

  const entite = ctx.query('entity');
  if (entite) {
    if (!/^[a-z_]{2,30}$/.test(entite)) throw badRequest('Entité mal formée.');
    w.add('a.entity = ?', entite);
  }

  const entityId = ctx.queryUuid('entityId');
  w.addIf(entityId, 'a.entity_id = ?', entityId);

  const action = ctx.query('action');
  if (action) {
    if (!/^[a-z_.]{2,40}$/.test(action)) throw badRequest('Action mal formée.');
    w.add('a.action = ?', action);
  }

  const userId = ctx.queryUuid('user');
  w.addIf(userId, 'a.user_id = ?', userId);

  const severite = String(ctx.query('severite') ?? '');
  if (['info', 'notice', 'warning', 'critical'].includes(severite)) {
    w.add('a.severity = ?', severite);
  }

  const du = ctx.queryDate('du');
  const au = ctx.queryDate('au');
  w.addIf(du, 'a.at >= ?::date', du);
  // Borne haute inclusive : « au 30 septembre » doit contenir le 30 entier.
  w.addIf(au, 'a.at < (?::date + 1)', au);

  const q = ctx.query('q');
  if (q && q.trim()) {
    const motif = likeContains(q);
    w.add('(a.summary ILIKE ? OR a.entity_label ILIKE ? OR a.username ILIKE ?)',
      motif, motif, motif);
  }

  return w;
}

auditRoutes.get(
  '/',
  async (ctx) => {
    const w = filtresAudit(ctx);
    const { limit, offset } = ctx.pagination({ defaultLimit: 50, maxLimit: 200 });

    const lignes = await all(
      `SELECT a.seq, a.id, a.at, a.username, a.ip, a.action, a.entity, a.entity_id,
              a.entity_label, a.summary, a.changes, a.severity
         FROM audit_log a ${w.sql()}
        ORDER BY a.seq DESC
        LIMIT ${w.next(limit)} OFFSET ${w.next(offset)}`,
      w.params,
    );

    const c = filtresAudit(ctx);
    const total = await one('SELECT COUNT(*)::int AS n FROM audit_log a ' + c.sql(), c.params);

    ctx.ok({
      entrees: lignes.map((l) => ({
        seq: Number(l.seq),
        id: l.id,
        le: l.at,
        par: l.username,
        ip: l.ip,
        action: l.action,
        entite: l.entity,
        entiteId: l.entity_id,
        libelle: l.entity_label,
        resume: l.summary,
        changements: l.changes,
        severite: l.severity,
      })),
      pagination: { limit, offset, total: Number(total.n) },
      journalPerdu: journalPerdu(),
    });
  },
  { permission: 'audit.view' },
);

/**
 * Verifie la chaine.
 *
 * Un journal qui affirme sa propre integrite sans la demontrer ne vaut rien :
 * cette route recalcule les condensats et dit exactement sur combien
 * d'entrees elle s'est prononcee.
 */
auditRoutes.get(
  '/verifier',
  async (ctx) => {
    const limite = ctx.queryInt('limite', 5000, { min: 100, max: 100000 });
    const resultat = await verifyChain({ limit: limite });
    ctx.ok({ ...resultat, tete: await lastEntryHash() });
  },
  { permission: 'audit.view' },
);
