/**
 * Controle d'acces base sur les roles (RBAC).
 *
 * Repris de lahlal_samuplus, avec son catalogue reduit a ce module : chaque
 * action est couverte par une permission nommee, un role est un ensemble de
 * permissions, et une route sans annotation est refusee par defaut
 * (server/http/router.js).
 *
 * Un principe garde du socle : CONSULTER et MODIFIER sont toujours deux
 * droits distincts, et SUPPRIMER en est un troisieme. On peut confier la
 * saisie quotidienne des activites a quelqu'un sans lui confier le droit
 * d'effacer l'historique.
 */

/* ------------------------------------------------------------------ */
/*  Catalogue des permissions                                          */
/* ------------------------------------------------------------------ */

/** @type {Array<{code:string,label:string,category:string,sensitive?:boolean}>} */
export const PERMISSIONS = [
  // --- Consultation generale
  { code: 'dashboard.view', label: 'Consulter le tableau de bord', category: 'Général' },
  { code: 'stats.view', label: 'Consulter les statistiques', category: 'Général' },
  { code: 'export.data', label: 'Exporter les activités et l’historique', category: 'Général' },

  // --- Vehicules
  { code: 'vehicle.view', label: 'Consulter les véhicules', category: 'Véhicules' },
  { code: 'vehicle.create', label: 'Créer un véhicule', category: 'Véhicules' },
  { code: 'vehicle.edit', label: 'Modifier un véhicule', category: 'Véhicules' },
  // Archiver, et non supprimer : un vehicule porte tout son historique
  // d'activites et d'entretiens (§29). Le geste reste sensible parce qu'il
  // retire le vehicule de tous les ecrans de saisie.
  {
    code: 'vehicle.archive',
    label: 'Archiver ou réactiver un véhicule',
    category: 'Véhicules',
    sensitive: true,
  },

  // --- Activites
  { code: 'activity.view', label: 'Consulter les activités', category: 'Activités' },
  { code: 'activity.create', label: 'Enregistrer une activité', category: 'Activités' },
  { code: 'activity.edit', label: 'Modifier une activité', category: 'Activités' },
  {
    code: 'activity.delete',
    label: 'Supprimer une activité (corbeille)',
    category: 'Activités',
    sensitive: true,
  },
  // Passer outre l'avertissement de kilometrage incoherent (§4). Ce n'est pas
  // le droit de saisir : c'est celui de confirmer une valeur que
  // l'application juge aberrante — compteur remplace, releve corrige,
  // saisie anterieure fausse. Separe pour que la trace dise qui a tranche.
  {
    code: 'activity.force_mileage',
    label: 'Confirmer un kilométrage incohérent',
    category: 'Activités',
    sensitive: true,
  },

  // --- Entretiens et echeances
  { code: 'maintenance.view', label: 'Consulter les entretiens et échéances', category: 'Entretiens' },
  { code: 'maintenance.create', label: 'Créer un entretien ou une échéance', category: 'Entretiens' },
  { code: 'maintenance.edit', label: 'Modifier un entretien ou une échéance', category: 'Entretiens' },
  { code: 'maintenance.close', label: 'Déclarer un entretien effectué', category: 'Entretiens' },
  {
    code: 'maintenance.delete',
    label: 'Supprimer un entretien ou une échéance',
    category: 'Entretiens',
    sensitive: true,
  },

  // --- Pieces jointes
  //
  // Elles ont leurs propres droits plutot que d'emprunter ceux de l'entite
  // portante. Reprise directe d'un defaut corrige dans lahlal_samuplus (N-01) :
  // joindre une piece n'est pas modifier le document, et supprimer une piece
  // est un geste sec — le binaire disparait.
  { code: 'attachment.view', label: 'Consulter et télécharger les pièces jointes', category: 'Pièces jointes' },
  { code: 'attachment.add', label: 'Ajouter une pièce jointe', category: 'Pièces jointes' },
  {
    code: 'attachment.delete',
    label: 'Supprimer une pièce jointe',
    category: 'Pièces jointes',
    sensitive: true,
  },

  // --- Parametrage
  { code: 'settings.view', label: 'Consulter les paramètres', category: 'Paramétrage' },
  // Les seuils d'alerte et les types d'activite : ce sont des decisions
  // d'exploitation, elles se reglent a l'ecran (§15, §35, regle 17).
  { code: 'settings.edit', label: 'Modifier les seuils d’alerte et les types', category: 'Paramétrage' },

  // --- Comptes et journal
  { code: 'user.view', label: 'Consulter les comptes', category: 'Administration' },
  { code: 'user.manage', label: 'Créer et modifier les comptes', category: 'Administration', sensitive: true },
  { code: 'role.manage', label: 'Redéfinir les droits d’un rôle', category: 'Administration', sensitive: true },
  { code: 'audit.view', label: 'Consulter le journal d’audit', category: 'Administration' },
];

export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

const PERMISSION_SET = new Set(PERMISSION_CODES);

export const isKnownPermission = (code) => PERMISSION_SET.has(code);

/**
 * Droits que seul le super-administrateur detient par defaut.
 *
 * L'ecart avec l'administrateur est volontairement etroit — un administrateur
 * qui ne peut plus travailler ne sert a rien — mais il est reel : redefinir
 * les droits d'un role ne se reprend pas sans passer par un compte de rang
 * superieur.
 */
export const RESERVE_SUPERADMIN = ['role.manage'];

const RESERVE = new Set(RESERVE_SUPERADMIN);

/** Le catalogue complet, moins ce qui est reserve au super-administrateur. */
export const PERMISSIONS_ADMIN = PERMISSION_CODES.filter((code) => !RESERVE.has(code));

/* ------------------------------------------------------------------ */
/*  Roles livres en standard                                           */
/* ------------------------------------------------------------------ */

/**
 * Le gestionnaire de flotte : le role de travail courant.
 *
 * Il tient la flotte de bout en bout — vehicules, activites, entretiens,
 * pieces — mais ne touche ni aux comptes, ni aux seuils, ni au journal.
 */
const GESTIONNAIRE = [
  'dashboard.view', 'stats.view', 'export.data',
  'vehicle.view', 'vehicle.create', 'vehicle.edit',
  'activity.view', 'activity.create', 'activity.edit', 'activity.force_mileage',
  'maintenance.view', 'maintenance.create', 'maintenance.edit', 'maintenance.close',
  'attachment.view', 'attachment.add', 'attachment.delete',
  'settings.view',
];

/**
 * La saisie : celui qui est sur le terrain, telephone en main.
 *
 * Il enregistre ce qu'il fait et photographie ses justificatifs. Il ne
 * modifie pas une activite deja enregistree — il la signale — et ne supprime
 * rien. C'est le role pour lequel le parcours mobile est concu (§23).
 */
const SAISIE = [
  'dashboard.view',
  'vehicle.view',
  'activity.view', 'activity.create',
  'maintenance.view',
  'attachment.view', 'attachment.add',
];

/** La consultation seule : voir l'etat de la flotte, sans rien y changer. */
const LECTURE = [
  'dashboard.view', 'stats.view',
  'vehicle.view', 'activity.view', 'maintenance.view', 'attachment.view',
];

/**
 * @type {Array<{code:string,name:string,description:string,isSystem:boolean,rank:number,sort:number,permissions:string[]|'*'}>}
 */
export const DEFAULT_ROLES = [
  {
    // Rang 0 : le seul role qui puisse agir sur un administrateur. Il se cree
    // par « npm run superadmin » : aucun ecran ne permet de s'y promouvoir.
    code: 'SUPERADMIN',
    name: 'Super-administrateur',
    description:
      'Autorité au-dessus de l’administrateur : seul à pouvoir redéfinir les droits ' +
      'd’un rôle, modifier un compte administrateur ou le supprimer.',
    isSystem: true,
    rank: 0,
    sort: 5,
    permissions: '*',
  },
  {
    code: 'ADMIN',
    name: 'Administrateur',
    description:
      'Accès complet à la gestion courante : flotte, activités, entretiens, comptes, ' +
      'seuils d’alerte et journal d’audit.',
    isSystem: true,
    rank: 10,
    sort: 10,
    permissions: PERMISSIONS_ADMIN,
  },
  {
    code: 'GESTIONNAIRE',
    name: 'Gestionnaire de flotte',
    description: 'Tient la flotte au quotidien : véhicules, activités, entretiens et pièces.',
    isSystem: true,
    rank: 20,
    sort: 20,
    permissions: GESTIONNAIRE,
  },
  {
    code: 'SAISIE',
    name: 'Saisie terrain',
    description:
      'Enregistre les activités depuis le téléphone et joint les photos. ' +
      'Ne modifie ni ne supprime ce qui est déjà enregistré.',
    isSystem: true,
    rank: 40,
    sort: 40,
    permissions: SAISIE,
  },
  {
    code: 'LECTURE',
    name: 'Consultation',
    description: 'Voit l’état de la flotte et son historique, sans rien y changer.',
    isSystem: true,
    rank: 60,
    sort: 60,
    permissions: LECTURE,
  },
];

/* ------------------------------------------------------------------ */
/*  Verification                                                       */
/* ------------------------------------------------------------------ */

/**
 * L'utilisateur possede-t-il la permission demandee ?
 * @param {{permissions?: Set<string>|string[]}} user
 * @param {string} permission
 */
export function can(user, permission) {
  if (!user || !user.permissions) return false;
  const set = user.permissions instanceof Set ? user.permissions : new Set(user.permissions);
  return set.has(permission);
}

/** Au moins une des permissions listees. */
export function canAny(user, permissions) {
  return permissions.some((p) => can(user, p));
}

/** Toutes les permissions listees. */
export function canAll(user, permissions) {
  return permissions.every((p) => can(user, p));
}
