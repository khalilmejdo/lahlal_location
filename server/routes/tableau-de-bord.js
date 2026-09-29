/**
 * Le tableau de bord (§16, §38).
 *
 * UN SEUL APPEL, ET IL REND TOUT.
 *
 * Le §33 est explicite : « ne pas multiplier inutilement les appels
 * frontend ». Un tableau de bord qui demande separement ses vehicules, ses
 * chiffres du mois, ses alertes et ses dernieres activites paie quatre
 * allers-retours — sur un telephone en 3G, c'est la difference entre un
 * ecran qui s'ouvre et un ecran qui se charge. Ici, une requete HTTP, et
 * quatre requetes SQL a plat : aucune ne depend du nombre de vehicules.
 *
 * L'ORDRE D'AFFICHAGE EST DECIDE ICI, PAS PAR L'ECRAN.
 *
 * Le §38 veut, sur telephone : les alertes urgentes d'abord, puis les
 * echeances proches, puis les vehicules. Le serveur rend donc les alertes
 * deja triees par gravite — l'ecran n'a plus qu'a les peindre.
 */
import { Router } from '../http/router.js';
import { all, one } from '../db/index.js';
import { today } from '../core/text.js';
import { vehiculesAvecEtat, comparerUrgence, presenterActivite } from '../domain/flotte.js';

export const tableauDeBordRoutes = new Router();

/** Le premier jour du mois d'une date ISO. */
const debutDuMois = (iso) => iso.slice(0, 8) + '01';

tableauDeBordRoutes.get(
  '/',
  async (ctx) => {
    const aujourdHui = ctx.queryDate('le') ?? today();

    // La periode observee : le mois courant par defaut, ou celle qu'on
    // demande. Le tableau de bord d'un mois clos doit rester consultable.
    const du = ctx.queryDate('du') ?? debutDuMois(aujourdHui);
    const au = ctx.queryDate('au') ?? aujourdHui;

    const flotte = await vehiculesAvecEtat({ aujourdHui });

    // Les chiffres de la periode. Une requete, un balayage.
    const chiffres = await one(
      `SELECT COUNT(*)::int                              AS nb_activites,
              COALESCE(SUM(a.depense_cents), 0)::bigint  AS depenses_cents,
              COALESCE(SUM(a.recette_cents), 0)::bigint  AS recettes_cents,
              COALESCE(SUM(a.resultat_cents), 0)::bigint AS resultat_cents
         FROM activites a
         JOIN vehicules v ON v.id = a.vehicule_id
        WHERE a.deleted_at IS NULL
          AND a.date_activite BETWEEN $1 AND $2`,
      [du, au],
    );

    // Les dernieres activites, tous vehicules confondus (§38).
    const recentes = await all(
      `SELECT a.*, t.libelle AS type_libelle,
              v.immatriculation AS vehicule_immatriculation,
              COALESCE(v.libelle, v.immatriculation) AS vehicule_nom
         FROM activites a
         JOIN vehicules v ON v.id = a.vehicule_id
         LEFT JOIN types t ON t.domaine = 'ACTIVITE' AND t.code = a.type_code
        WHERE a.deleted_at IS NULL
        ORDER BY a.date_activite DESC, a.created_at DESC
        LIMIT 8`,
    );

    // Toutes les echeances qui meritent attention, la plus pressante en tete.
    const alertes = flotte
      .flatMap((v) => v.entretiens
        .filter((e) => e.etat.surveille && e.etat.niveau !== 'NORMAL')
        .map((e) => ({ ...e, vehiculeId: v.id, vehiculeNom: v.nom })))
      .sort(comparerUrgence);

    const compteurs = { NORMAL: 0, ATTENTION: 0, URGENT: 0, DEPASSE: 0 };
    for (const v of flotte) {
      for (const [niveau, n] of Object.entries(v.compteurs)) compteurs[niveau] += n;
    }

    ctx.ok({
      periode: { du, au },
      flotte: {
        nbVehicules: flotte.length,
        // Ce que le §37 demande de lire en quelques secondes : l'etat de
        // chaque vehicule, sa prochaine echeance, son kilometrage.
        vehicules: flotte.map((v) => ({
          id: v.id,
          nom: v.nom,
          immatriculation: v.immatriculation,
          statut: v.statut,
          kilometrage: v.kilometrage,
          niveau: v.niveau,
          prochaineEcheance: v.prochaineEcheance,
        })),
      },
      chiffres: {
        nbActivites: Number(chiffres.nb_activites),
        depensesCents: Number(chiffres.depenses_cents),
        recettesCents: Number(chiffres.recettes_cents),
        resultatCents: Number(chiffres.resultat_cents),
      },
      alertes: alertes.map((e) => ({
        entretienId: e.id,
        vehiculeId: e.vehiculeId,
        vehiculeNom: e.vehiculeNom,
        libelle: e.libelle,
        niveau: e.etat.niveau,
        // `detail` est la phrase toute faite, en francais ; `etat` porte les
        // NOMBRES. L'ecran prefere les nombres — c'est lui qui met les mots,
        // et lui seul sait dans quelle langue. La phrase reste pour ce qui
        // ne traduit pas : l'etat imprimable, et les anciens appels.
        detail: e.alerte?.detail ?? null,
        etat: e.etat,
        prochainKm: e.prochainKm,
        prochaineDate: e.prochaineDate,
      })),
      compteurs,
      activitesRecentes: recentes.map(presenterActivite),
    });
  },
  { permission: 'dashboard.view' },
);
