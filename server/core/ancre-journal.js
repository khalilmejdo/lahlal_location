/**
 * L'ancre EXTERNE du journal d'audit : la tete de chaine, hors de la base.
 *
 * POURQUOI. La chaine de condensats attrape une entree modifiee ou retiree au
 * milieu ; l'ancrage par la sequence attrape une queue coupee. Mais qui tient
 * la base tient aussi la sequence : couper la queue puis « setval(max(seq)) »
 * rendait « aucune alteration detectee », et « TRUNCATE ... RESTART IDENTITY »
 * rendait « le journal est vide » — indistinguable d'une installation neuve
 * (point 26 du rapport de recette, reproduit sur les deux gestes). Un journal
 * qui se defend avec les seuls moyens de la base ne se defend pas contre qui
 * tient la base.
 *
 * CE QUI EST RETENU, ET CE QUI A ETE ECARTE. Trois parades existent : une
 * signature a clef detenue ailleurs, une empreinte publiee hors du serveur, ou
 * une ancre externe a la base. Les deux premieres imposent une clef a ranger
 * et a faire tourner, ou un service tiers — un geste d'exploitation nouveau,
 * ou une dependance, qu'on ne decide pas seul. La troisieme ne coute rien de
 * visible : a chaque entree validee, la tete de chaine (numero et empreinte)
 * s'ecrit dans un petit fichier du dossier de donnees — celui qui porte deja
 * les archives — et la verification confronte la base a ce fichier. Pour
 * raccourcir le journal sans etre vu, il faut desormais tenir la base ET le
 * disque du serveur : deux acces au lieu d'un. Ce n'est pas une garantie
 * absolue — elle n'existe pas sans clef — et elle est ecrite comme telle dans
 * le message rendu a l'ecran.
 *
 * Ce qui reste hors de portee, dit franchement : qui tient les deux efface les
 * deux. Une ancre absente n'est pas une alerte — un premier deploiement n'en a
 * pas — et c'est la seule facon de ne pas crier a chaque installation neuve.
 *
 * L'ancre se pose APRES le COMMIT, jamais dedans : posee dans la transaction,
 * un ROLLBACK la laisserait en avance sur la base, et la verification
 * accuserait un journal intact. Elle n'avance que vers l'avant, sauf sur
 * demande explicite (restauration, vidage, nettoyage — les trois gestes de
 * l'application qui remplacent ou effacent le journal, tous journalises ou
 * confirmes par mot de passe).
 *
 * AUDIT_ANCRE_EXTERNE=off rend le comportement d'avant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

/** Le fichier de l'ancre, dans le dossier de donnees. */
export function cheminAncre() {
  return path.join(config.storage.dataDir, 'journal-ancre.json');
}

/**
 * Lit l'ancre. Rend null si elle n'existe pas ou n'est pas lisible : les deux
 * se traitent pareil, et ne sont pas une alerte.
 *
 * @param {string} [chemin]
 * @returns {{seq: number, hash: string|null, at: string|null}|null}
 */
export function lireAncre(chemin = cheminAncre()) {
  try {
    const brut = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    const seq = Number(brut?.seq);
    if (!Number.isFinite(seq) || seq < 0) return null;
    return { seq, hash: typeof brut.hash === 'string' ? brut.hash : null, at: brut.at ?? null };
  } catch {
    return null;
  }
}

let compteur = 0;

/**
 * Pose l'ancre sur une tete de chaine.
 *
 * Ecriture atomique : fichier provisoire puis renommage, pour qu'une coupure
 * ne laisse jamais une ancre a moitie ecrite. Jamais en arriere sans
 * « forcer » : deux validations qui se suivent de pres peuvent ancrer dans le
 * desordre, et une ancre qui recule masquerait la derniere entree.
 *
 * @param {{seq: number, hash: string|null}} tete
 * @param {string} [chemin]
 * @param {{forcer?: boolean}} [opts]
 * @returns {boolean} vrai si l'ancre a ete ecrite
 */
export function ecrireAncre({ seq, hash }, chemin = cheminAncre(), { forcer = false } = {}) {
  if (!config.audit.ancreExterne) return false;
  const numero = Number(seq);
  if (!Number.isFinite(numero) || numero < 0) return false;
  try {
    if (!forcer) {
      const actuelle = lireAncre(chemin);
      if (actuelle && actuelle.seq > numero) return false;
    }
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
    compteur += 1;
    const provisoire = chemin + '.' + process.pid + '.' + compteur + '.partiel';
    fs.writeFileSync(
      provisoire,
      JSON.stringify({ seq: numero, hash: hash ?? null, at: new Date().toISOString() }) + '\n',
      { mode: 0o600 },
    );
    fs.renameSync(provisoire, chemin);
    return true;
  } catch (err) {
    log.error('Echec de l’ancrage externe du journal', { error: err.message, seq: numero });
    return false;
  }
}

/**
 * Confronte la tete du journal, lue en base, a l'ancre.
 *
 * Fonction pure : elle juge des nombres et des chaines, et c'est elle qui
 * porte le verdict que la base seule ne pouvait pas rendre.
 *
 * @param {{seq: number, hash: string|null}|null} ancre
 * @param {{dernierSeq: number|null, dernierHash: string|null, complet?: boolean}} tete
 * @returns {{presente: boolean, intact: boolean, motif: string|null, seq: number|null, message: string}}
 */
export function confronterAncre(ancre, { dernierSeq, dernierHash, complet = true }) {
  if (!ancre) {
    return {
      presente: false, intact: true, motif: null, seq: null,
      message: 'Aucune ancre externe : le journal n’est attesté que par sa chaîne et sa séquence, ' +
        'que qui tient la base peut remettre en accord. L’ancre se pose à la prochaine écriture.',
    };
  }
  if (!complet) {
    return {
      presente: true, intact: true, motif: null, seq: ancre.seq,
      message: 'Ancre externe à l’entrée n° ' + ancre.seq + ', non confrontée : la vérification est partielle.',
    };
  }
  const dernier = Number(dernierSeq ?? 0);
  if (ancre.seq > dernier) {
    return {
      presente: true, intact: false, motif: 'raccourci', seq: ancre.seq,
      message: 'L’ancre externe atteste l’entrée n° ' + ancre.seq + ' ; la base ' +
        (dernier ? 's’arrête à la n° ' + dernier : 'est vide') +
        '. Le journal a été raccourci et sa séquence remise en accord : ce n’est pas une maladresse.',
    };
  }
  if (ancre.seq === dernier && ancre.hash && dernierHash && ancre.hash !== dernierHash) {
    return {
      presente: true, intact: false, motif: 'reecrit', seq: ancre.seq,
      message: 'La dernière entrée du journal (n° ' + dernier + ') ne porte plus l’empreinte ancrée ' +
        'hors de la base : elle a été réécrite.',
    };
  }
  return {
    presente: true, intact: true, motif: null, seq: ancre.seq,
    message: ancre.seq === dernier
      ? 'Ancre externe confrontée : la tête du journal (n° ' + dernier + ') est celle attestée hors de la base.'
      : 'Ancre externe à l’entrée n° ' + ancre.seq + ', en retard de ' + (dernier - ancre.seq) +
        ' entrée(s) : remise sur la tête.',
  };
}
