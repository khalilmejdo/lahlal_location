/**
 * A-13 / RG-18 : journal d'audit inviolable.
 *
 * Chaque entree est chainee a la precedente par un condensat :
 *
 *     hash(n) = SHA-256( hash(n-1) || contenu canonique de l'entree n )
 *
 * Supprimer une ligne, en modifier une, ou en inserer une a posteriori rompt
 * la chaine de facon detectable par verifyChain(). C'est ce qui permet de
 * repondre a la question "qui a modifie ce montant, quand, et pourquoi ?"
 * meme face a quelqu'un disposant d'un acces direct a la base.
 *
 * Le classeur d'origine n'offrait aucune tracabilite : 51 tarifs et 6 totaux
 * y avaient ete ecrases a la main sans laisser la moindre trace (§6.2).
 */
import { sha256, newId } from './crypto.js';
import { transaction, all, one, value } from '../db/index.js';
import { log } from './logger.js';
import { ecrireAncre, lireAncre, confronterAncre } from './ancre-journal.js';

/** Verrou consultatif serialisant les ecritures du journal. */
const AUDIT_LOCK_KEY = 918273645;

/**
 * Serialisation canonique : cles triees, afin que le condensat soit
 * reproductible independamment de l'ordre d'insertion des proprietes.
 */
function canonical(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/**
 * Condensat d'une entree, enchaine sur la precedente.
 *
 * Expose pour que la verification puisse etre eprouvee sur une chaine
 * fabriquee avec la vraie regle, plutot que sur des condensats ecrits a la
 * main — qui ne verifieraient qu'une copie de la regle.
 */
export function computeHash(prevHash, entry) {
  return sha256(
    (prevHash || 'GENESIS') +
      '|' +
      canonical({
        id: entry.id,
        at: entry.at,
        userId: entry.userId,
        username: entry.username,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        entityLabel: entry.entityLabel,
        summary: entry.summary,
        changes: entry.changes,
        severity: entry.severity,
      }),
  );
}

/* ------------------------------------------------------------------ */
/*  Ecriture                                                           */
/* ------------------------------------------------------------------ */

let entreesPerdues = 0;
let derniereeperdue = null;

/**
 * Ajoute une entree au journal.
 *
 * @param {object} params
 * @param {object|null} [params.tx]   client de transaction, pour que l'audit
 *                                    soit annule en meme temps que l'operation
 *                                    metier si celle-ci echoue.
 * @param {object|null} [params.actor] utilisateur a l'origine de l'action
 * @param {string} params.action       ex. "invoice.validate"
 * @param {string} [params.entity]     ex. "invoice"
 * @param {string} [params.entityId]
 * @param {string} [params.entityLabel] ex. "FC 26-412"
 * @param {string} params.summary      phrase lisible par un non-technicien
 * @param {object} [params.changes]    diff champ par champ
 * @param {string} [params.severity]   info | notice | warning | critical
 * @param {string} [params.ip]
 */
export async function record(params) {
  const {
    tx = null,
    actor = null,
    action,
    entity = null,
    entityId = null,
    entityLabel = null,
    summary,
    changes = null,
    severity = 'info',
    ip = null,
  } = params;

  const write = async (client) => {
    // Serialise les ecritures : sans ce verrou, deux transactions simultanees
    // pourraient lire le meme prev_hash et produire une chaine ambigue.
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);

    const prevHash = await client.value('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');

    const entry = {
      id: newId(),
      at: new Date().toISOString(),
      userId: actor?.id ?? null,
      username: actor?.username ?? 'système',
      action,
      entity,
      entityId,
      entityLabel,
      summary,
      changes: changes ?? null,
      severity,
    };

    const hash = computeHash(prevHash, entry);

    const inseree = await client.one(
      `INSERT INTO audit_log
         (id, at, user_id, username, ip, action, entity, entity_id, entity_label,
          summary, changes, severity, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING seq`,
      [
        entry.id,
        entry.at,
        entry.userId,
        entry.username,
        ip,
        entry.action,
        entry.entity,
        entry.entityId,
        entry.entityLabel,
        entry.summary,
        entry.changes ? JSON.stringify(entry.changes) : null,
        entry.severity,
        prevHash,
        hash,
      ],
    );

    // L'ancre externe (point 26) se pose APRES le COMMIT, par la transaction
    // elle-meme : posee ici, un ROLLBACK la laisserait en avance sur la base.
    const seq = Number(inseree?.seq);
    if (Number.isFinite(seq) && typeof client.apresValidation === 'function') {
      client.apresValidation(() => ecrireAncre({ seq, hash }));
    }

    return entry.id;
  };

  if (tx) {
    // Dans une transaction, l'echec remonte : l'operation metier est annulee
    // avec sa trace. C'est le cas majoritaire, et le bon.
    try {
      return await write(tx);
    } catch (err) {
      log.error("Echec d'ecriture du journal d'audit", { error: err.message, action, entity });
      throw err;
    }
  }

  // H-04 : hors transaction, l'echec etait avale. L'operation metier reussissait
  // — trois sessions reellement fermees, HTTP 200 — et n'en laissait aucune
  // trace. Un log serveur que personne ne lit n'est pas une trace.
  //
  // On ne peut pas non plus faire echouer l'operation : elle est deja faite,
  // et il n'y a rien a annuler puisqu'il n'y a pas de transaction. Ce qui est
  // possible, et qui manquait, tient en deux gestes.
  //
  // Un : REESSAYER une fois. La cause dominante est une connexion coupee par
  // l'hebergeur ; le pool en rend une neuve, et le second essai aboutit.
  //
  // Deux : COMPTER ce qui est malgre tout perdu, et le dire. Un compteur que
  // /healthz et l'ecran de diagnostic publient transforme un incident
  // invisible en incident visible — ce qu'un log ne faisait pas.
  for (let essai = 1; essai <= 2; essai += 1) {
    try {
      return await transaction(write);
    } catch (err) {
      const dernier = essai === 2;
      log.error("Echec d'ecriture du journal d'audit", {
        error: err.message, action, entity, essai, abandon: dernier,
      });
      if (dernier) {
        entreesPerdues += 1;
        derniereeperdue = { at: new Date().toISOString(), action, entity };
      }
    }
  }
  return null;
}

/**
 * H-04 : ce que le journal n'a pas pu ecrire depuis le demarrage.
 *
 * Zero est la seule valeur acceptable. Toute autre veut dire qu'une operation
 * a eu lieu sans laisser de trace, et qu'aucune verification de chaine ne le
 * dira jamais — l'entree manquante n'a pas de trou a montrer, elle n'a jamais
 * existe.
 */
/**
 * Compte une entree qui n'a pas pu etre ecrite hors du chemin de record() —
 * une trace de refus ecartee parce que la file d'attente est pleine (F-3),
 * ou encore en vol a l'arret (F-17). Le meme compteur, la meme visibilite.
 */
export function compterEntreePerdue(action, entity) {
  entreesPerdues += 1;
  derniereeperdue = { at: new Date().toISOString(), action, entity };
}

export function journalPerdu() {
  return { entrees: entreesPerdues, derniere: derniereeperdue };
}

/* ------------------------------------------------------------------ */
/*  Calcul de differences                                              */
/* ------------------------------------------------------------------ */

/**
 * Compare deux etats d'un objet et retourne uniquement les champs modifies.
 * Les champs sensibles sont remplaces par un marqueur : le journal doit tracer
 * qu'une donnee personnelle a change, sans en republier le contenu.
 *
 * @param {object} before
 * @param {object} after
 * @param {{ fields?: string[], sensitive?: string[] }} [opts]
 * @returns {object|null} null si rien n'a change
 */
export function diff(before, after, opts = {}) {
  const { fields = null, sensitive = [] } = opts;
  const sensitiveSet = new Set(sensitive);
  const keys = fields || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];

  const changes = {};
  for (const key of keys) {
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;
    if (from === to) continue;
    // Comparaison souple entre null, undefined et chaine vide.
    if ((from ?? '') === (to ?? '')) continue;
    changes[key] = sensitiveSet.has(key)
      ? { from: '[donnée protégée]', to: '[donnée protégée]', modified: true }
      : { from: from ?? null, to: to ?? null };
  }

  return Object.keys(changes).length ? changes : null;
}

/* ------------------------------------------------------------------ */
/*  Verification d'integrite                                           */
/* ------------------------------------------------------------------ */

/**
 * H-02 : la chaine ne dit pas que la derniere entree est bien la derniere.
 *
 * Chaque entree pointe la precedente. Amputer le journal PAR LA FIN laisse
 * donc une chaine parfaitement coherente : supprimer la derniere entree, les
 * quatre dernieres, ou le journal entier rendait « valid: true ». Il n'existait
 * aucun ancrage hors de la table — rien qui sache combien d'entrees auraient du
 * s'y trouver.
 *
 * L'ancrage est la sequence de la colonne seq. Elle ne recule pas sur un
 * DELETE, ni sur un TRUNCATE sans RESTART IDENTITY : elle se souvient du
 * dernier numero attribue, meme quand la ligne qui le portait n'est plus la.
 * Comparer ce numero au dernier seq present suffit a voir la queue coupee.
 *
 * Les deux effacements legitimes de l'application remettent explicitement la
 * sequence a 1 (vidage NEUVE, npm run nettoyer) : ils ne declenchent donc
 * aucune fausse alerte — la table vide et la sequence a zero s'accordent.
 *
 * Fonction pure : elle ne lit rien, elle juge des nombres.
 *
 * @param {{nombre: number, premierSeq: number|null, dernierSeq: number|null,
 *          dernierAttribue: number|null}} etat
 * @returns {{intact: boolean, motif: string|null, manquantes: number, message: string}}
 */
export function verifierAncrage({ nombre, premierSeq, dernierSeq, dernierAttribue }) {
  // J-11 : « jamais appelee » n'est pas « a zero ».
  //
  // pg_sequence_last_value() rend NULL tant que la sequence n'a distribue aucun
  // numero, et c'est exactement l'etat qu'une restauration laisse derriere
  // elle : instructionResynchronisation() pose setval(..., MAX + 1, false) —
  // « voici le prochain numero » — sans la consommer. Prendre ce NULL pour un
  // zero faisait dire au diagnostic, sur une base fraichement restauree, que la
  // prochaine ecriture entrerait en collision sur la cle primaire. Elle passe,
  // et le verdict repassait au vert de lui-meme a la premiere entree ecrite :
  // l'alerte ne survivait pas au geste qu'elle reclamait.
  //
  // Une sequence muette n'atteste rien — ni qu'il manque une queue, ni qu'il
  // n'en manque pas. Ce qui en repond alors est l'ancre externe, que la
  // restauration repose sur la tete qu'elle vient d'ecrire.
  const sequenceMuette = dernierAttribue === null || dernierAttribue === undefined;
  const attribues = Number(dernierAttribue ?? 0);

  if (nombre === 0) {
    if (attribues > 0) {
      return {
        intact: false,
        motif: 'journal_efface',
        manquantes: attribues,
        message:
          'Le journal est vide, mais ' + attribues + ' entree(s) y ont ete ecrites. ' +
          'Il a ete efface : la chaine restante ne peut rien attester.',
      };
    }
    return { intact: true, motif: null, manquantes: 0, message: 'Le journal est vide.' };
  }

  const premier = Number(premierSeq);
  const dernier = Number(dernierSeq);

  // La sequence est EN RETARD sur les donnees : c'est la signature d'une base
  // restauree dont les sequences n'ont pas ete resynchronisees (J-01). Ce
  // n'est pas un effacement, c'est une collision qui attend la prochaine
  // ecriture — et elle annulera la transaction metier qui la porte.
  if (!sequenceMuette && dernier > attribues) {
    return {
      intact: false,
      motif: 'sequence_en_retard',
      manquantes: 0,
      message:
        'La sequence du journal est restee a ' + attribues + ' alors que la derniere ' +
        'entree porte le numero ' + dernier + '. La prochaine ecriture entrera en ' +
        'collision sur la cle primaire. Resynchronisez la sequence.',
    };
  }

  if (!sequenceMuette && dernier < attribues) {
    return {
      intact: false,
      motif: 'queue_coupee',
      manquantes: attribues - dernier,
      message:
        (attribues - dernier) + ' entree(s) ont ete supprimees a la FIN du journal : ' +
        'la derniere ecrite porte le numero ' + attribues + ', la derniere presente ' +
        'le numero ' + dernier + '. La chaine restante est coherente, et ne prouve rien.',
    };
  }

  if (premier > 1) {
    return {
      intact: false,
      motif: 'tete_coupee',
      manquantes: premier - 1,
      message:
        (premier - 1) + ' entree(s) ont ete supprimees au DEBUT du journal : ' +
        'il commence au numero ' + premier + '.',
    };
  }

  const attendues = dernier - premier + 1;
  if (nombre !== attendues) {
    return {
      intact: false,
      motif: 'trous',
      manquantes: attendues - nombre,
      message:
        (attendues - nombre) + ' entree(s) manquent entre les numeros ' + premier +
        ' et ' + dernier + '.',
    };
  }

  if (sequenceMuette) {
    return {
      intact: true,
      motif: null,
      manquantes: 0,
      message:
        'Aucun trou entre les numeros presents. La sequence n a distribue aucun ' +
        'numero depuis qu elle a ete posee — une restauration la recale sans la ' +
        'consommer — elle ne dit donc rien d une queue coupee : c est l ancre ' +
        'externe qui en repond.',
    };
  }

  return { intact: true, motif: null, manquantes: 0, message: 'Aucune entree ne manque.' };
}

/**
 * Recalcule l'enchainement des condensats et rend la premiere rupture.
 *
 * Fonction pure, separee de la lecture : c'est ce qui la rend eprouvable sans
 * base. Elle ne detecte QUE l'alteration ou la suppression au milieu ; la
 * queue coupee releve de verifierAncrage() ci-dessus.
 *
 * Le condensat precedent se passe en parametre pour que la verification puisse
 * se faire par tranches : c'est ce qui permet de couvrir un journal entier sans
 * le charger en memoire d'un seul tenant. Sans argument, la chaine est reprise
 * depuis son origine, comme avant.
 *
 * @param {Array<object>} lignes  lignes d'audit_log, triees par seq croissant
 * @param {string|null} precedent condensat de la ligne precedant la tranche
 * @returns {{seq: any, entry: object}|null}
 */
export function verifierEnchainement(lignes, precedent = null) {
  let previous = precedent;
  for (const row of lignes) {
    const expected = computeHash(previous, {
      id: row.id,
      at: row.at instanceof Date ? row.at.toISOString() : row.at,
      userId: row.user_id,
      username: row.username,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      entityLabel: row.entity_label,
      summary: row.summary,
      changes: row.changes ?? null,
      severity: row.severity,
    });

    if (row.prev_hash !== previous || row.hash !== expected) {
      return {
        seq: row.seq,
        entry: {
          seq: row.seq,
          at: row.at,
          action: row.action,
          summary: row.summary,
          username: row.username,
        },
      };
    }
    previous = row.hash;
  }
  return null;
}

/**
 * Recalcule la chaine et signale la premiere rupture.
 * Expose via GET /api/audit/verify (permission audit.view).
 *
 * Sans borne, le journal est verifie EN ENTIER : la lecture se fait par
 * tranches, si bien que la memoire ne depend pas de sa taille. Une borne reste
 * acceptee pour un controle rapide, et le resultat dit alors qu'il est partiel.
 *
 * @param {{ limit?: number|null }} [opts]
 */
export async function verifyChain(opts = {}) {
  const { limit = null } = opts;

  // L'ancrage se lit sur la TABLE entiere, jamais sur la fenetre : verifier
  // les 100 premieres entrees ne dit rien de ce qui manque a la fin.
  const bornes = await one(
    `SELECT COUNT(*)::int AS nombre, MIN(seq) AS premier, MAX(seq) AS dernier,
            pg_sequence_last_value(pg_get_serial_sequence('audit_log', 'seq')::regclass)
              AS attribue
       FROM audit_log`,
  );

  const ancrage = verifierAncrage({
    nombre: Number(bornes?.nombre ?? 0),
    premierSeq: bornes?.premier ?? null,
    dernierSeq: bornes?.dernier ?? null,
    // NULL ne se replie pas sur 0 : voir verifierAncrage(). Une sequence qui
    // n'a encore distribue aucun numero n'est pas une sequence restee en
    // arriere, et c'est l'etat ou une restauration laisse toutes les siennes.
    dernierAttribue: bornes?.attribue == null ? null : Number(bornes.attribue),
  });

  // La chaine se relit par tranches, et non d'un seul tenant.
  //
  // Elle ne lisait que les 100 000 premieres entrees, et rendait « aucune
  // alteration détectée » — un verdict sur le journal entier, prononce sur son
  // debut. Au-dela, une entree modifiee restait invisible, et l'ecran, qui
  // appelle cette route sans borne, affichait « Journal intact ».
  //
  // Deux choses changent, et une seule ne suffisait pas. La lecture par
  // tranches permet de couvrir tout le journal sans le charger en memoire —
  // c'est ce qui rend la couverture complete possible sur 330 000 entrees. Et
  // le resultat DIT sa couverture : quand une borne a ete demandee et que le
  // journal la depasse, le verdict porte sur ce qui a ete lu, et le dit.
  const TRANCHE = 5000;
  const total = Number(bornes?.nombre ?? 0);
  const plafond = limit === null ? Number.POSITIVE_INFINITY : limit;

  let precedent = null;
  let apres = null;
  let examinees = 0;
  let dernierHash = null;
  let rupture = null;

  while (examinees < plafond) {
    const taille = Math.min(TRANCHE, plafond - examinees);
    // Les tranches se lisent l'une apres l'autre, a dessein : chacune reprend
    // le condensat de la precedente, et une lecture en parallele n'aurait rien
    // a quoi rattacher sa premiere ligne.
    const rows = await all(
      `SELECT seq, id, at, user_id, username, action, entity, entity_id, entity_label,
              summary, changes, severity, prev_hash, hash
         FROM audit_log
        WHERE ($1::bigint IS NULL OR seq > $1)
        ORDER BY seq ASC
        LIMIT $2`,
      [apres, taille],
    );
    if (!rows.length) break;

    rupture = verifierEnchainement(rows, precedent);
    if (rupture) break;

    examinees += rows.length;
    precedent = rows[rows.length - 1].hash;
    dernierHash = precedent;
    apres = rows[rows.length - 1].seq;
  }

  const complet = examinees >= total;

  // Point 26 : la sequence se remet en accord d'un setval, et un TRUNCATE
  // RESTART IDENTITY rend un journal « vide » indistinguable d'une
  // installation neuve. L'ancre externe (server/core/ancre-journal.js) est
  // confrontee a la tete reellement lue — seulement quand la lecture a ete
  // complete, sans quoi la tete n'est pas connue.
  const ancreExterne = confronterAncre(lireAncre(), {
    dernierSeq: bornes?.dernier ?? null,
    dernierHash,
    complet: complet && !rupture,
  });

  if (rupture) {
    return {
      valid: false,
      checked: examinees,
      total,
      complete: complet,
      brokenAt: rupture.seq,
      entry: rupture.entry,
      anchor: ancrage,
      ancreExterne,
      message:
        'La chaine du journal est rompue à l’entree n ' + rupture.seq +
        '. Une entree a ete supprimée ou modifiée directement en base.',
    };
  }

  // L'ancrage est signale APRES la chaine : une chaine rompue est le fait le
  // plus grave, et le plus precis. Mais une chaine intacte sur un journal
  // ampute ne vaut rien, et c'etait tout le defaut.
  if (!ancrage.intact) {
    return {
      valid: false,
      checked: examinees,
      total,
      complete: complet,
      brokenAt: null,
      anchor: ancrage,
      ancreExterne,
      message:
        'Les condensats s’enchainent, et pourtant le journal n’est pas complet. ' +
        ancrage.message,
    };
  }

  // Et l'ancre externe en dernier : chaine et sequence s'accordent, mais la
  // tete attestee hors de la base n'est plus dans la base.
  if (!ancreExterne.intact) {
    return {
      valid: false,
      checked: examinees,
      total,
      complete: complet,
      brokenAt: null,
      anchor: ancrage,
      ancreExterne,
      message:
        'Les condensats s’enchainent et la sequence s’accorde, et pourtant le journal ' +
        'n’est pas celui qui a ete ecrit. ' + ancreExterne.message,
    };
  }

  // Une ancre absente ou en retard se remet sur la tete verifiee : c'est le
  // seul moment ou l'on SAIT que la tete lue est saine.
  if (complet && total > 0 && (!ancreExterne.presente || ancreExterne.seq < Number(bornes.dernier))) {
    ecrireAncre({ seq: Number(bornes.dernier), hash: dernierHash });
  }

  return {
    valid: true,
    checked: examinees,
    total,
    complete: complet,
    lastHash: dernierHash,
    anchor: ancrage,
    ancreExterne,
    message: messageDeCouverture({ examinees, total }),
  };
}

/**
 * Repose l'ancre externe sur la tete que la base porte MAINTENANT.
 *
 * Pour les trois gestes de l'application qui remplacent ou effacent le
 * journal — restauration, vidage, nettoyage —, tous journalises ou confirmes
 * par mot de passe. Apres eux, la base est la reference, et l'ancre suit.
 */
export async function reancrerDepuisLaBase() {
  const tete = await one('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  return ecrireAncre(
    tete ? { seq: Number(tete.seq), hash: tete.hash } : { seq: 0, hash: null },
    undefined,
    { forcer: true },
  );
}

/**
 * Ce qu'on a le droit de conclure d'une verification, selon ce qu'elle a lu.
 *
 * Sortie de verifyChain() pour etre eprouvable sans base : c'est la phrase qui
 * mentait. « Aucune alteration détectée » etait rendu apres avoir lu les
 * 100 000 premieres entrees d'un journal qui en comptait 330 001 — un verdict
 * sur le tout, prononce sur un tiers. Une couverture partielle doit dire
 * combien elle a lu, combien elle a laisse, et qu'elle ne dit rien du reste.
 *
 * @param {{examinees: number, total: number}} etat
 * @returns {string}
 */
export function messageDeCouverture({ examinees, total }) {
  if (examinees === 0) return 'Le journal est vide.';
  if (examinees >= total) {
    return 'Chaine vérifiée sur les ' + examinees + ' entrees du journal : ' +
      'aucune alteration détectée.';
  }
  return 'Chaine vérifiée sur les ' + examinees + ' premieres entrees d’un journal qui en ' +
    'compte ' + total + ' : aucune alteration sur celles-là. Les ' + (total - examinees) +
    ' suivantes n’ont pas ete examinées, et ce résultat ne dit rien d’elles.';
}


/** Derniere entree du journal, pour affichage rapide. */
export async function lastEntryHash() {
  return value('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
}
