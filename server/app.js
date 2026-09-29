/**
 * Assemblage des routes de l'application.
 *
 * Un seul endroit declare la totalite de la surface exposee : c'est ce qui
 * permet de verifier d'un coup d'oeil qu'aucune route n'a ete oubliee, et
 * sur quelle permission chacune repose.
 *
 * Rappel du routeur : une route qui ne declare NI `public` NI `permission`
 * exige une session valide mais aucun droit particulier. L'oubli d'une
 * annotation ferme donc l'acces au lieu de l'ouvrir.
 */
import { Router } from './http/router.js';

import { metaRoutes } from './routes/meta.js';
import { authRoutes } from './routes/auth.js';
import { vehiculeRoutes } from './routes/vehicules.js';
import { activiteRoutes } from './routes/activites.js';
import { entretienRoutes } from './routes/entretiens.js';
import { fichierRoutes } from './routes/fichiers.js';
import { tableauDeBordRoutes } from './routes/tableau-de-bord.js';
import { statistiqueRoutes } from './routes/statistiques.js';
import { exportRoutes } from './routes/exports.js';
import { reglageRoutes } from './routes/reglages.js';
import { userRoutes } from './routes/users.js';
import { auditRoutes } from './routes/audit.js';

export function buildRouter() {
  const router = new Router();

  // Sonde de sante et referentiels : chemins absolus.
  router.mount('', metaRoutes);

  router.mount('/api/auth', authRoutes);

  // La flotte
  router.mount('/api/vehicules', vehiculeRoutes);
  router.mount('/api/activites', activiteRoutes);
  router.mount('/api/entretiens', entretienRoutes);
  router.mount('/api/fichiers', fichierRoutes);

  // Pilotage
  router.mount('/api/tableau-de-bord', tableauDeBordRoutes);
  router.mount('/api/statistiques', statistiqueRoutes);
  router.mount('/api/exports', exportRoutes);

  // Administration
  router.mount('/api/reglages', reglageRoutes);
  router.mount('/api/utilisateurs', userRoutes);
  router.mount('/api/audit', auditRoutes);

  return router;
}
