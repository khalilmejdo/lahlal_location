/**
 * Les seuils d'alerte, lus en base et gardes en memoire.
 *
 * Meme montage que la posture de securite du socle (server/core/posture.js),
 * et pour la meme raison : ces valeurs sont relues a chaque calcul d'etat de
 * la flotte — soit, pour un tableau de bord de vingt vehicules portant
 * chacun quatre echeances, quatre-vingts fois par affichage. Les chercher en
 * base a chaque fois serait payer mille fois une lecture pour une valeur qui
 * change deux fois par an.
 *
 * Le cache se remplit au demarrage et se rafraichit a chaque enregistrement
 * des parametres. Une base injoignable ne laisse jamais l'application sans
 * seuils : elle repart de ceux du cahier des charges, et le dit.
 */
import { all } from '../db/index.js';
import { log } from '../core/logger.js';
import { lireSeuils, SEUILS_PAR_DEFAUT } from './echeances.js';

let courants = null;

/**
 * Les seuils appliques, lisibles sans attendre.
 *
 * Avant le premier chargement, rend les valeurs du cahier des charges. Le
 * calcul des alertes ne peut donc jamais tomber sur des zeros — ce qui
 * mettrait toute la flotte au rouge, ou pire, tout au vert.
 */
export function seuils() {
  if (!courants) courants = { ...SEUILS_PAR_DEFAUT };
  return courants;
}

/** Relit les parametres et met le cache a jour. Rend les seuils appliques. */
export async function chargerSeuils() {
  try {
    const lignes = await all(
      "SELECT key, value FROM settings WHERE key LIKE 'alerte.%' OR key LIKE 'kilometrage.%'",
    );
    courants = lireSeuils(lignes);
  } catch (err) {
    log.warn('Seuils d’alerte illisibles, valeurs par défaut appliquées', { error: err.message });
    courants = { ...SEUILS_PAR_DEFAUT };
  }
  return courants;
}
