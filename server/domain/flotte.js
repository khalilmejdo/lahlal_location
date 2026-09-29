/**
 * L'etat de la flotte : les vehicules, leurs echeances, leur couleur.
 *
 * Un seul module repond a la question « ou en est-on ? », et les trois
 * ecrans qui la posent — le tableau de bord, la liste des vehicules, la
 * fiche d'un vehicule — passent tous par lui. C'est ce qui garantit qu'un
 * vehicule affiche en orange dans la liste ne soit pas vert sur sa fiche.
 *
 * DEUX REQUETES, QUEL QUE SOIT LE NOMBRE DE VEHICULES.
 *
 * La tentation, pour un ecran qui montre vingt vehicules et leurs echeances,
 * est de boucler : une requete par vehicule pour ses entretiens. C'est le
 * N+1 que le §32 proscrit, et lahlal_samuplus l'a paye — 86 secondes sur la
 * fiche de flotte, une erreur 500 au bout de cinq vehicules. Ici, les
 * vehicules viennent en une requete, TOUS leurs entretiens en une seconde,
 * et le rapprochement se fait en memoire. Le compte ne bouge pas avec la
 * taille de la flotte.
 *
 * Le calcul des niveaux, lui, reste dans domain/echeances.js : il est pur,
 * il se teste sans base, et ce module ne fait que lui apporter les chiffres.
 */
import { all } from '../db/index.js';
import { today } from '../core/text.js';
import { etatEcheance, pireNiveau, libelleAlerte } from './echeances.js';
import { seuils } from './seuils.js';

/* ------------------------------------------------------------------ */
/*  Lecture                                                            */
/* ------------------------------------------------------------------ */

/**
 * Les vehicules, chacun avec ses echeances et son etat.
 *
 * @param {object} [options]
 * @param {string[]|null} [options.ids]        se limiter a ces vehicules
 * @param {boolean} [options.inclureArchives]  defaut : non
 * @param {string}  [options.aujourdHui]       pour les essais ; defaut : today()
 * @returns {Promise<Array<object>>}
 */
export async function vehiculesAvecEtat({
  ids = null,
  inclureArchives = false,
  aujourdHui = today(),
} = {}) {
  const conditions = [];
  const params = [];

  if (!inclureArchives) conditions.push('v.archived_at IS NULL');
  if (ids) {
    params.push(ids);
    conditions.push('v.id = ANY($' + params.length + '::uuid[])');
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const vehicules = await all(
    `SELECT v.id, v.immatriculation, v.libelle, v.marque, v.modele, v.annee,
            v.statut, v.kilometrage, v.kilometrage_initial, v.derniere_activite_le,
            v.photo_id, v.notes, v.archived_at, v.created_at, v.updated_at
       FROM v_vehicules v
       ${where}
      ORDER BY v.archived_at NULLS FIRST, COALESCE(v.libelle, v.immatriculation)`,
    params,
  );

  if (!vehicules.length) return [];

  // La seconde requete, et la derniere : tous les entretiens surveilles de
  // tous les vehicules retenus, d'un coup.
  const entretiens = await all(
    `SELECT e.id, e.vehicule_id, e.type_code, e.libelle,
            e.derniere_date, e.dernier_km,
            e.intervalle_km, e.intervalle_mois,
            e.prochain_km, e.prochaine_date, e.statut, e.notes,
            t.libelle AS type_libelle
       FROM entretiens e
       LEFT JOIN types t ON t.domaine = 'ENTRETIEN' AND t.code = e.type_code
      WHERE e.vehicule_id = ANY($1::uuid[]) AND e.statut = 'ACTIF'
      ORDER BY e.libelle`,
    [vehicules.map((v) => v.id)],
  );

  const parVehicule = new Map();
  for (const e of entretiens) {
    if (!parVehicule.has(e.vehicule_id)) parVehicule.set(e.vehicule_id, []);
    parVehicule.get(e.vehicule_id).push(e);
  }

  const reglages = seuils();

  return vehicules.map((v) => {
    const siens = (parVehicule.get(v.id) ?? []).map((e) => {
      const etat = etatEcheance(
        { prochainKm: e.prochain_km, prochaineDate: e.prochaine_date, statut: e.statut },
        v.kilometrage,
        aujourdHui,
        reglages,
      );
      return { ...presenterEntretien(e), etat, alerte: libelleAlerte(e, etat) };
    });

    // La plus pressante d'abord : c'est elle qui donne sa couleur au
    // vehicule, et c'est elle qu'on veut lire en premier sur la fiche.
    siens.sort(comparerUrgence);

    const surveilles = siens.filter((e) => e.etat.surveille);

    return {
      ...presenterVehicule(v),
      entretiens: siens,
      niveau: pireNiveau(...surveilles.map((e) => e.etat.niveau)),
      // Ce que la liste affiche en une ligne (§37).
      //
      // `etat` accompagne la phrase toute faite : il porte les nombres, et
      // c'est a partir d'eux que l'ecran ecrit le compte a rebours dans la
      // langue de celui qui regarde.
      prochaineEcheance: surveilles.length
        ? {
          libelle: surveilles[0].libelle,
          ...surveilles[0].alerte,
          etat: surveilles[0].etat,
        }
        : null,
      compteurs: compterParNiveau(surveilles),
    };
  });
}

/** Un seul vehicule, ou null. */
export async function vehiculeAvecEtat(id, options = {}) {
  const [v] = await vehiculesAvecEtat({ ...options, ids: [id], inclureArchives: true });
  return v ?? null;
}

/* ------------------------------------------------------------------ */
/*  Tri et comptage                                                    */
/* ------------------------------------------------------------------ */

const RANG_NIVEAU = { DEPASSE: 0, URGENT: 1, ATTENTION: 2, NORMAL: 3 };

/**
 * Le plus urgent en premier ; a niveau egal, le plus proche de son echeance.
 *
 * « Le plus proche » se mesure sur l'axe qui presse, et les deux axes ne se
 * comparent pas : trois cents kilometres et trois jours ne sont pas la meme
 * grandeur. On classe donc par niveau d'abord — ce que l'oeil lit — puis, a
 * l'interieur d'un niveau, par la marge restante rapportee a son propre
 * seuil, ce qui remet les deux axes sur une echelle commune.
 */
export function comparerUrgence(a, b) {
  const na = a.etat.surveille ? RANG_NIVEAU[a.etat.niveau] : 9;
  const nb = b.etat.surveille ? RANG_NIVEAU[b.etat.niveau] : 9;
  if (na !== nb) return na - nb;
  return margeRelative(a.etat) - margeRelative(b.etat);
}

function margeRelative(etat) {
  const reglages = seuils();
  const parts = [];
  if (etat.km) parts.push(etat.km.restant / Math.max(reglages.kmAttention, 1));
  if (etat.date) parts.push(etat.date.restant / Math.max(reglages.joursAttention, 1));
  return parts.length ? Math.min(...parts) : Number.POSITIVE_INFINITY;
}

export function compterParNiveau(entretiens) {
  const c = { NORMAL: 0, ATTENTION: 0, URGENT: 0, DEPASSE: 0 };
  for (const e of entretiens) {
    if (e.etat?.surveille) c[e.etat.niveau] += 1;
  }
  return c;
}

/* ------------------------------------------------------------------ */
/*  Presentation                                                       */
/* ------------------------------------------------------------------ */

/**
 * La forme rendue au client.
 *
 * Les colonnes SQL sont en minuscules avec des tirets bas, l'API parle en
 * camelCase : la conversion se fait ici, une fois, plutot que dans chaque
 * route. Ce qui n'est pas liste ne sort pas.
 */
export function presenterVehicule(v) {
  return {
    id: v.id,
    immatriculation: v.immatriculation,
    libelle: v.libelle,
    // Ce que l'ecran affiche comme titre : le nom d'usage s'il existe,
    // l'immatriculation sinon. Decide ici pour que les trois ecrans
    // nomment le vehicule pareil.
    nom: v.libelle || v.immatriculation,
    marque: v.marque,
    modele: v.modele,
    annee: v.annee,
    statut: v.statut,
    kilometrage: v.kilometrage,
    kilometrageInitial: v.kilometrage_initial,
    derniereActiviteLe: v.derniere_activite_le,
    photoId: v.photo_id,
    notes: v.notes,
    archive: Boolean(v.archived_at),
    archiveLe: v.archived_at,
    creeLe: v.created_at,
    modifieLe: v.updated_at,
  };
}

export function presenterEntretien(e) {
  return {
    id: e.id,
    vehiculeId: e.vehicule_id,
    typeCode: e.type_code,
    typeLibelle: e.type_libelle ?? e.type_code,
    libelle: e.libelle,
    derniereDate: e.derniere_date,
    dernierKm: e.dernier_km,
    intervalleKm: e.intervalle_km,
    intervalleMois: e.intervalle_mois,
    prochainKm: e.prochain_km,
    prochaineDate: e.prochaine_date,
    statut: e.statut,
    notes: e.notes,
  };
}

export function presenterActivite(a) {
  return {
    id: a.id,
    vehiculeId: a.vehicule_id,
    vehiculeNom: a.vehicule_nom ?? null,
    vehiculeImmatriculation: a.vehicule_immatriculation ?? null,
    date: a.date_activite,
    typeCode: a.type_code,
    typeLibelle: a.type_libelle ?? a.type_code,
    prestation: a.prestation,
    kilometrage: a.kilometrage,
    kilometrageForce: a.kilometrage_force,
    depenseCents: Number(a.depense_cents),
    recetteCents: Number(a.recette_cents),
    resultatCents: Number(a.resultat_cents),
    notes: a.notes,
    entretienId: a.entretien_id,
    nbPieces: a.nb_pieces === undefined ? undefined : Number(a.nb_pieces),
    supprime: Boolean(a.deleted_at),
    supprimeLe: a.deleted_at ?? null,
    motifSuppression: a.delete_reason ?? null,
    creeLe: a.created_at,
    modifieLe: a.updated_at,
  };
}
