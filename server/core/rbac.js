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
  // Revenir sur une suppression. Réservé : c'est le filet, et un filet que
  // tout le monde peut relever n'en est plus un.
  {
    code: 'attachment.restore',
    label: 'Restaurer une pièce jointe supprimée',
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
/**
 * Ce que le super-administrateur garde pour lui.
 *
 * Avec deux roles, cette liste est le SEUL garde-fou de droits qui reste :
 * elle doit donc rester minuscule, et chaque entree porter sa raison.
 *
 * `user.manage` y figure par necessite autant que par choix. Le rang veut
 * qu'on n'agisse que sur STRICTEMENT inferieur a soi ; deux administrateurs
 * partagent le rang 10, donc un administrateur ne peut de toute facon ni en
 * creer un autre, ni le modifier. Lui laisser le droit aurait ete lui
 * donner une case qui ne fait rien — exactement ce que ce module refuse
 * ailleurs. Les comptes se gerent donc depuis le super-administrateur ;
 * l'administrateur garde `user.view`, pour savoir qui a acces.
 */
export const RESERVE_SUPERADMIN = ['role.manage', 'user.manage', 'attachment.restore'];

const RESERVE = new Set(RESERVE_SUPERADMIN);

/** Le catalogue complet, moins ce qui est reserve au super-administrateur. */
export const PERMISSIONS_ADMIN = PERMISSION_CODES.filter((code) => !RESERVE.has(code));

/* ------------------------------------------------------------------ */
/*  Roles livres en standard                                           */
/* ------------------------------------------------------------------ */

/**
 * DEUX ROLES, ET DEUX SEULEMENT.
 *
 * Le module en portait cinq — gestionnaire, saisie terrain, consultation —
 * et c'etait une erreur d'appreciation : cette flotte se tient a deux ou
 * trois personnes qui font toutes le meme travail. Cinq roles, c'est cinq
 * jeux de droits a maintenir, cinq facons de se tromper en creant un
 * compte, et une matrice que personne ne relit.
 *
 * CE QUI PROTEGE ICI N'EST PAS LA RESTRICTION, C'EST LA TRACE.
 *
 * Un administrateur peut tout faire, y compris se tromper. Le dispositif
 * qui repond a l'erreur n'est donc pas le refus — il est ailleurs, et il
 * est complet :
 *
 *   - rien ne se detruit vraiment. Une activite part a la corbeille et se
 *     restaure ; un vehicule s'archive ; une piece jointe supprimee se
 *     recupere ; une echeance deja realisee se clot au lieu de disparaitre ;
 *   - tout geste est inscrit au journal, avec son auteur, son horodatage,
 *     le detail champ par champ et, pour les gestes destructeurs, le motif
 *     obligatoire ;
 *   - le journal lui-meme ne se modifie pas — chaine de condensats, ancre
 *     hors base, declencheur PostgreSQL qui refuse UPDATE et DELETE.
 *
 * Le super-administrateur garde ce qui touche a la hierarchie elle-meme :
 * redefinir les droits d'un role. Il se cree en ligne de commande, jamais
 * depuis un ecran.
 */

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
      'd’un rôle, agir sur un compte administrateur, et restaurer une pièce jointe ' +
      'supprimée.',
    isSystem: true,
    rank: 0,
    sort: 5,
    permissions: '*',
  },
  {
    code: 'ADMIN',
    name: 'Administrateur',
    description:
      'Le rôle de travail : véhicules, activités, entretiens, pièces jointes, comptes, ' +
      'seuils d’alerte et journal. Tout ce qu’il fait est tracé, et rien de ce qu’il ' +
      'supprime n’est perdu.',
    isSystem: true,
    rank: 10,
    sort: 10,
    permissions: PERMISSIONS_ADMIN,
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
