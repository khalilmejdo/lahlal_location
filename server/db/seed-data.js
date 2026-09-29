/**
 * Ce que contient une base neuve.
 *
 * Trois familles, et une regle commune : tout ce qui est livre ici est
 * MODIFIABLE ensuite depuis l'application. Les types se renomment, se
 * desactivent et s'ajoutent (§35) ; les seuils se reglent (§15) ; les droits
 * d'un role se redefinissent. Ce fichier donne un point de depart utilisable
 * des la premiere minute, pas une contrainte.
 *
 * Il est en revanche IDEMPOTENT a l'application : rejouer le seed ne doit
 * jamais ecraser ce que l'exploitant a change. Voir scripts/seed.js.
 */

/* ------------------------------------------------------------------ */
/*  Les seuils et reglages                                             */
/* ------------------------------------------------------------------ */

/**
 * Les valeurs du §15, telles qu'elles arrivent en base au premier demarrage.
 *
 * Elles doublent SEUILS_PAR_DEFAUT (server/domain/echeances.js), et ce n'est
 * pas une duplication accidentelle : le domaine doit savoir se passer de la
 * base — c'est ce qui le rend testable et ce qui fait que l'application
 * fonctionne encore si la table est vide. Un test verifie que les deux
 * listes s'accordent (test/reglages.test.js).
 */
export const SETTINGS_PAR_DEFAUT = [
  {
    key: 'alerte.km_attention',
    value: '2000',
    label: 'Kilomètres restants à partir desquels une échéance passe en « attention »',
    category: 'alertes',
    sort: 10,
  },
  {
    key: 'alerte.km_urgent',
    value: '500',
    label: 'Kilomètres restants à partir desquels une échéance devient « urgente »',
    category: 'alertes',
    sort: 20,
  },
  {
    key: 'alerte.jours_attention',
    value: '30',
    label: 'Jours restants à partir desquels une échéance passe en « attention »',
    category: 'alertes',
    sort: 30,
  },
  {
    key: 'alerte.jours_urgent',
    value: '15',
    label: 'Jours restants à partir desquels une échéance devient « urgente »',
    category: 'alertes',
    sort: 40,
  },
  {
    key: 'kilometrage.tolerance_recul',
    value: '0',
    label: 'Recul du compteur toléré sans demander confirmation (km)',
    category: 'alertes',
    sort: 50,
  },

  // La posture de securite (server/core/posture.js). Absente, chaque valeur
  // retombe sur la variable d'environnement correspondante.
  {
    key: 'securite.session_inactivite_min',
    value: '45',
    label: 'Déconnexion après inactivité (minutes)',
    category: 'securite',
    sort: 110,
  },
  {
    key: 'securite.session_duree_h',
    value: '12',
    label: 'Durée maximale d’une session (heures)',
    category: 'securite',
    sort: 120,
  },
  {
    key: 'securite.tentatives_max',
    value: '5',
    label: 'Échecs de connexion avant verrouillage du compte',
    category: 'securite',
    sort: 130,
  },
  {
    key: 'securite.mot_de_passe_min',
    value: '12',
    label: 'Longueur minimale d’un mot de passe',
    category: 'securite',
    sort: 140,
  },
  {
    key: 'securite.debit_max',
    value: '300',
    label: 'Requêtes autorisées par adresse et par fenêtre',
    category: 'securite',
    sort: 150,
  },
  {
    key: 'securite.debit_fenetre_s',
    value: '60',
    label: 'Durée de la fenêtre de limitation (secondes)',
    category: 'securite',
    sort: 160,
  },
];

/* ------------------------------------------------------------------ */
/*  Les types d'activite (§5, §6)                                      */
/* ------------------------------------------------------------------ */

/**
 * `sens` n'interdit rien : il oriente seulement le formulaire mobile vers le
 * champ que l'on remplit neuf fois sur dix. Un remorquage rapporte, une
 * vidange coute, une location peut faire les deux — carburant compris.
 */
export const TYPES_ACTIVITE = [
  { code: 'LOCATION', libelle: 'Location', sens: 'RECETTE', ordre: 10 },
  { code: 'REMORQUAGE', libelle: 'Remorquage', sens: 'RECETTE', ordre: 20 },
  { code: 'DEPANNAGE', libelle: 'Dépannage', sens: 'RECETTE', ordre: 30 },
  { code: 'TRANSPORT', libelle: 'Transport', sens: 'RECETTE', ordre: 40 },
  { code: 'INTERVENTION', libelle: 'Intervention', sens: 'RECETTE', ordre: 50 },
  { code: 'CARBURANT', libelle: 'Carburant', sens: 'DEPENSE', ordre: 60 },
  { code: 'ENTRETIEN', libelle: 'Entretien', sens: 'DEPENSE', ordre: 70 },
  { code: 'REPARATION', libelle: 'Réparation', sens: 'DEPENSE', ordre: 80 },
  { code: 'VIDANGE', libelle: 'Vidange', sens: 'DEPENSE', ordre: 90 },
  { code: 'PNEUS', libelle: 'Pneus', sens: 'DEPENSE', ordre: 100 },
  { code: 'ASSURANCE', libelle: 'Assurance', sens: 'DEPENSE', ordre: 110 },
  { code: 'CONTROLE_TECHNIQUE', libelle: 'Contrôle technique', sens: 'DEPENSE', ordre: 120 },
  { code: 'AUTRE', libelle: 'Autre', sens: 'MIXTE', ordre: 999 },
];

/* ------------------------------------------------------------------ */
/*  Les types d'entretien (§35)                                        */
/* ------------------------------------------------------------------ */

/**
 * Chacun porte l'intervalle qui lui est habituel, a titre de PROPOSITION
 * lors de la creation d'une echeance. Rien n'oblige a le suivre : §11 et §12
 * veulent qu'une valeur saisie a la main soit respectee telle quelle.
 *
 * Les valeurs retenues sont celles du cahier des charges (§35) :
 *   - vidange, distribution : kilometrage ;
 *   - controle technique, assurance : date ;
 *   - revision : les deux ;
 *   - pneus, freins, batterie : facultatif des deux cotes, donc rien d'impose.
 */
export const TYPES_ENTRETIEN = [
  { code: 'VIDANGE', libelle: 'Vidange', ordre: 10, intervalleKm: 10000, intervalleMois: null },
  { code: 'REVISION', libelle: 'Révision', ordre: 20, intervalleKm: 20000, intervalleMois: 12 },
  { code: 'PNEUS', libelle: 'Pneus', ordre: 30, intervalleKm: 40000, intervalleMois: null },
  { code: 'FREINS', libelle: 'Freins', ordre: 40, intervalleKm: 30000, intervalleMois: null },
  { code: 'DISTRIBUTION', libelle: 'Distribution', ordre: 50, intervalleKm: 120000, intervalleMois: null },
  { code: 'BATTERIE', libelle: 'Batterie', ordre: 60, intervalleKm: null, intervalleMois: 48 },
  { code: 'CONTROLE_TECHNIQUE', libelle: 'Contrôle technique', ordre: 70, intervalleKm: null, intervalleMois: 12 },
  { code: 'ASSURANCE', libelle: 'Assurance', ordre: 80, intervalleKm: null, intervalleMois: 12 },
  { code: 'VIGNETTE', libelle: 'Vignette', ordre: 90, intervalleKm: null, intervalleMois: 12 },
  { code: 'AUTRE', libelle: 'Autre', ordre: 999, intervalleKm: null, intervalleMois: null },
];

/**
 * L'intervalle habituel d'un type d'entretien.
 *
 * Il ne vit pas dans la table `types` : celle-ci est commune aux activites
 * et aux entretiens, et une colonne « intervalle » y serait vide pour la
 * moitie des lignes. C'est une suggestion d'ecran, pas une donnee metier —
 * l'intervalle qui compte est celui porte par l'entretien lui-meme.
 */
export const INTERVALLES_SUGGERES = Object.fromEntries(
  TYPES_ENTRETIEN.map((t) => [t.code, { km: t.intervalleKm, mois: t.intervalleMois }]),
);
