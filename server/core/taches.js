/**
 * Ce que les taches planifiees ont fait, et quand.
 *
 * Demande de Khalil, 16 septembre 2026 : « Une carte "Taches planifiees" dans
 * Diagnostic : derniere sauvegarde, derniere analyse, brouillons de contrat
 * avec leurs refus. Aujourd'hui, ces resultats ne sont que dans les journaux
 * du serveur. »
 *
 * Trois traitements tournent seuls, et leur seul temoin etait un log.info que
 * personne ne lit : une sauvegarde qui echoue chaque nuit, une analyse
 * desactivee par un parametre, un contrat dont l'echeance se refuse — rien de
 * tout cela n'apparaissait dans l'application.
 *
 * Regle de ce module : l'enregistrement ne doit JAMAIS empecher la tache.
 * Une base indisponible ne doit pas empecher une sauvegarde de partir ; elle
 * laisse simplement le passage sans trace, et la carte dira « aucun passage
 * enregistre ».
 */
import { all, one } from '../db/index.js';
import { newId } from './crypto.js';
import { log } from './logger.js';

/** Les taches suivies, par leur nom en base. */
export const TACHES = {
  SAUVEGARDE: 'sauvegarde',
  // Contre-verification du 16 septembre 2026 : la sauvegarde lancee A LA MAIN
  // s'inscrivait sous le meme nom que la nocturne, et la carte ne montre que
  // le DERNIER passage de chaque tache. La nocturne echouait a 2 h ; a 9 h,
  // avant un deploiement, l'exploitant cliquait « Sauvegarder maintenant »,
  // elle aboutissait — et l'echec de la nuit disparaissait de l'ecran. C'est
  // exactement ce que cette carte existe pour montrer, et le seul geste qui
  // pouvait l'aveugler etait celui qui se repete a chaque mise en ligne.
  // Deux lignes, deux verdicts.
  SAUVEGARDE_MANUELLE: 'sauvegarde-manuelle',
  ANALYSE: 'analyse',
  ECHEANCES: 'echeances-contrats',
};

/** Ce que la carte affiche pour chacune. */
export const LIBELLES_TACHES = {
  sauvegarde: 'Sauvegarde quotidienne',
  'sauvegarde-manuelle': 'Sauvegarde lancée à la main',
  analyse: 'Analyse périodique',
  'echeances-contrats': 'Brouillons des échéances de contrats',
};

/** Ecrit sans jamais lever : une trace perdue ne doit rien interrompre. */
async function ecrire(requete, params) {
  try {
    await one(requete, params);
    return true;
  } catch (err) {
    log.warn('Passage de tache non enregistre', { error: err.message });
    return false;
  }
}

/**
 * Execute une tache planifiee en gardant trace de son passage.
 *
 * @param {string} job    l'une des valeurs de TACHES
 * @param {() => Promise<string|void>} action  rend le resume a inscrire
 * @returns {Promise<*>} ce que l'action a rendu
 */
/**
 * Les passages que CE processus a ouverts et pas encore refermes.
 *
 * La sauvegarde s'en sert pour ne pas s'archiver elle-meme : son propre
 * passage est ouvert, par construction, au moment ou elle lit les tables.
 * Un passage ouvert par un processus PRECEDENT, lui, est un vrai incident
 * — le serveur s'est arrete pendant — et il doit rester dans l'archive.
 */
const passagesOuverts = new Set();
export const passagesEnCours = () => [...passagesOuverts];

export async function enregistrerPassage(job, action) {
  const id = newId();
  await ecrire('INSERT INTO job_runs (id, job) VALUES ($1,$2) RETURNING id', [id, job]);
  passagesOuverts.add(id);

  try {
    const resume = await action();
    await ecrire(
      `UPDATE job_runs SET finished_at = now(), ok = TRUE, summary = $2
        WHERE id = $1 RETURNING id`,
      [id, resume === undefined || resume === null ? null : String(resume).slice(0, 500)],
    );
    return resume;
  } catch (err) {
    // L'echec s'inscrit, puis il remonte : c'est l'appelant qui decide quoi
    // en faire, et il le journalisait deja.
    await ecrire(
      `UPDATE job_runs SET finished_at = now(), ok = FALSE, summary = $2
        WHERE id = $1 RETURNING id`,
      [id, String(err?.message || 'echec').slice(0, 500)],
    );
    throw err;
  } finally {
    // Refermé des deux cotes : un passage qui a rendu la main, abouti ou non,
    // n'est plus « en cours » et s'archive comme les autres.
    passagesOuverts.delete(id);
  }
}

/**
 * Le dernier passage de chaque tache suivie.
 *
 * Une tache qui n'a jamais tourne depuis le dernier demarrage rend une ligne
 * sans passage : c'est une information, pas une absence de ligne — « aucun
 * passage enregistre » est precisement ce qu'il faut voir quand la sauvegarde
 * nocturne ne part plus.
 */
export async function derniersPassages() {
  let rows = [];
  try {
    rows = await all(
      `SELECT DISTINCT ON (job) job, started_at, finished_at, ok, summary
         FROM job_runs ORDER BY job, started_at DESC`,
    );
  } catch (err) {
    log.warn('Passages des taches illisibles', { error: err.message });
  }
  const parJob = new Map(rows.map((r) => [r.job, r]));

  return Object.values(TACHES).map((job) => {
    const r = parJob.get(job);
    return {
      job,
      libelle: LIBELLES_TACHES[job] || job,
      debut: r?.started_at ?? null,
      fin: r?.finished_at ?? null,
      // Ni vrai ni faux tant que la tache n'a pas rendu la main : une tache
      // commencee et jamais finie est un incident a part entiere (le serveur
      // s'est arrete pendant), et la carte doit pouvoir le dire.
      ok: r ? r.ok : null,
      resume: r?.summary ?? null,
    };
  });
}
