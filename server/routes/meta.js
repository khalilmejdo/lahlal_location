/**
 * Sonde de sante et referentiels d'amorcage.
 *
 * /healthz est publique et ne dit RIEN de l'application : ni version
 * detaillee, ni chaine de connexion, ni compte. Un orchestrateur a besoin de
 * savoir si le service repond, pas de ce qu'il contient.
 *
 * /api/meta rend, en un appel, tout ce dont l'ecran a besoin pour se
 * construire : les types d'activite et d'entretien, les seuils, la liste des
 * vehicules pour les selecteurs. C'est le §33 applique — ne pas multiplier
 * les appels au chargement.
 */
import { Router } from '../http/router.js';
import { config } from '../core/config.js';
import { all, ping } from '../db/index.js';
import { journalPerdu } from '../core/audit.js';
import { seuils } from '../domain/seuils.js';
import { INTERVALLES_SUGGERES } from '../db/seed-data.js';
import { LIBELLES_NIVEAU, NIVEAUX } from '../domain/echeances.js';

export const metaRoutes = new Router();

metaRoutes.get(
  '/healthz',
  async (ctx) => {
    let base = 'ok';
    let ms = null;
    try {
      ms = await ping();
    } catch {
      base = 'injoignable';
    }

    // Une entree d'audit perdue est un incident : le journal est ce qui
    // permet de repondre « qui a change ce montant ». S'il ne s'ecrit plus,
    // la sonde doit le dire — sinon personne ne le saura.
    const perdues = journalPerdu();

    const sain = base === 'ok' && perdues.entrees === 0;
    ctx.json(sain ? 200 : 503, {
      status: sain ? 'ok' : 'degrade',
      base,
      baseMs: ms,
      journalPerdu: perdues.entrees || undefined,
      version: config.version ?? undefined,
    });
  },
  { public: true },
);

metaRoutes.get(
  '/api/meta',
  async (ctx) => {
    const types = await all(
      'SELECT domaine, code, libelle, sens, ordre FROM types WHERE actif ORDER BY domaine, ordre, libelle',
    );

    // Les vehicules pour les selecteurs : le strict necessaire, et seulement
    // s'il a le droit de les voir.
    const peutVoirVehicules = ctx.user?.permissions?.has('vehicle.view');
    const vehicules = peutVoirVehicules
      ? await all(
        `SELECT id, immatriculation, COALESCE(libelle, immatriculation) AS nom, statut, kilometrage
           FROM v_vehicules WHERE archived_at IS NULL
          ORDER BY nom`,
      )
      : [];

    ctx.ok({
      typesActivite: types.filter((t) => t.domaine === 'ACTIVITE')
        .map((t) => ({ code: t.code, libelle: t.libelle, sens: t.sens })),
      typesEntretien: types.filter((t) => t.domaine === 'ENTRETIEN')
        .map((t) => ({ code: t.code, libelle: t.libelle })),
      intervallesSugeres: INTERVALLES_SUGGERES,
      seuils: seuils(),
      niveaux: NIVEAUX.map((n) => ({ code: n, libelle: LIBELLES_NIVEAU[n] })),
      vehicules,
      uploadMaxBytes: config.storage.maxUploadBytes,
      formatsAcceptes: config.storage.allowedMimeTypes,
    });
  },
  // Aucune permission particuliere : tout compte authentifie a besoin de ces
  // referentiels pour afficher quoi que ce soit. Le contenu, lui, s'adapte
  // aux droits — la liste des vehicules reste vide sans « vehicle.view ».
  {},
);
