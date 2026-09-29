# L'API

52 routes. Toutes répondent en JSON, sauf les exports.

**Règles générales**

- Une route qui ne déclare ni `public` ni permission exige une **session
  valide** : l'oubli d'une annotation ferme l'accès au lieu de l'ouvrir.
- Toute écriture exige le jeton CSRF dans l'en-tête `X-CSRF-Token`, et une
  origine reconnue (`ALLOWED_ORIGINS`). Le jeton est rendu par
  `GET /api/auth/session` et par `POST /api/auth/login`.
- **Les montants voyagent en centimes entiers.** `depenseCents: 5000` vaut
  50,00 DH. La conversion depuis la saisie humaine se fait dans le navigateur.
- Les dates sont au format `AAAA-MM-JJ`.
- Les identifiants sont des UUID v7.

**Codes de retour**

| Code | Sens |
|---|---|
| 400 | Requête malformée (identifiant illisible, règle métier violée) |
| 401 | Pas de session, ou session expirée |
| 403 | Droit manquant, jeton CSRF absent, origine refusée |
| 404 | L'objet n'existe pas |
| 409 | Conflit avec l'état actuel (doublon, kilométrage à confirmer) |
| 413 | Fichier trop volumineux |
| 415 | Format de fichier refusé |
| 422 | Un champ est invalide — le détail est dans `error.details.fields` |
| 429 | Débit dépassé — `Retry-After` dit combien attendre |
| 503 | Base injoignable, ou journal d'audit indisponible |

Le corps d'erreur est toujours de la même forme :

```json
{ "error": { "code": "KILOMETRAGE_RECUL", "message": "…", "details": { … } } }
```

Le `code` est fait pour être testé par l'écran ; le `message` est écrit pour
être affiché tel quel.

---

## Surface complète

| Route | Droit exigé |
|---|---|
| `GET /healthz` | publique |
| `GET /api/auth/session` | publique |
| `POST /api/auth/login` | publique — débit 10 / 5 min |
| `POST /api/auth/logout` | session |
| `POST /api/auth/password` | session — débit 10 / 10 min |
| `GET /api/auth/sessions` | session |
| `DELETE /api/auth/sessions/:id` | session |
| `GET /api/meta` | session |
| `GET /api/tableau-de-bord` | `dashboard.view` |
| `GET /api/vehicules` | `vehicle.view` |
| `POST /api/vehicules` | `vehicle.create` |
| `GET /api/vehicules/:id` | `vehicle.view` |
| `PATCH /api/vehicules/:id` | `vehicle.edit` |
| `POST /api/vehicules/:id/archiver` | `vehicle.archive` |
| `POST /api/vehicules/:id/reactiver` | `vehicle.archive` |
| `GET /api/vehicules/:id/statistiques` | `stats.view` |
| `GET /api/activites` | `activity.view` |
| `POST /api/activites` | `activity.create` |
| `GET /api/activites/:id` | `activity.view` |
| `PATCH /api/activites/:id` | `activity.edit` |
| `DELETE /api/activites/:id` | `activity.delete` |
| `POST /api/activites/:id/restaurer` | `activity.delete` |
| `GET /api/entretiens` | `maintenance.view` |
| `POST /api/entretiens` | `maintenance.create` |
| `GET /api/entretiens/:id` | `maintenance.view` |
| `PATCH /api/entretiens/:id` | `maintenance.edit` |
| `POST /api/entretiens/:id/effectue` | `maintenance.close` |
| `POST /api/entretiens/:id/clore` | `maintenance.edit` |
| `DELETE /api/entretiens/:id` | `maintenance.delete` |
| `GET /api/entretiens/suggestions/intervalles` | `maintenance.view` |
| `GET /api/fichiers?entity=…&entityId=…` | `attachment.view` |
| `POST /api/fichiers` | `attachment.add` — débit 30 / 5 min |
| `GET /api/fichiers/:id` | `attachment.view` |
| `DELETE /api/fichiers/:id` | `attachment.delete` |
| `GET /api/statistiques` | `stats.view` |
| `GET /api/exports/activites.xlsx` | `export.data` — débit 20 / 5 min |
| `GET /api/exports/activites.csv` | `export.data` — débit 20 / 5 min |
| `GET /api/exports/vehicule/:id` | `export.data` — débit 20 / 5 min |
| `GET /api/reglages` | `settings.view` |
| `PATCH /api/reglages/:cle` | `settings.edit` |
| `GET /api/reglages/types/:domaine` | `settings.view` |
| `POST /api/reglages/types/:domaine` | `settings.edit` |
| `PATCH /api/reglages/types/:domaine/:code` | `settings.edit` |
| `DELETE /api/reglages/types/:domaine/:code` | `settings.edit` |
| `GET /api/utilisateurs` | `user.view` |
| `POST /api/utilisateurs` | `user.manage` |
| `PATCH /api/utilisateurs/:id` | `user.manage` |
| `POST /api/utilisateurs/:id/mot-de-passe` | `user.manage` |
| `GET /api/utilisateurs/roles` | `user.view` |
| `PUT /api/utilisateurs/roles/:id/permissions` | `role.manage` |
| `GET /api/audit` | `audit.view` |
| `GET /api/audit/verifier` | `audit.view` |

---

## Les routes qui demandent des explications

### `GET /api/meta`

Tout ce dont l'écran a besoin pour se construire, en **un appel** : types
d'activité et d'entretien actifs, intervalles suggérés, seuils appliqués,
liste des véhicules pour les sélecteurs, bornes de téléversement.

Aucune permission particulière — tout compte authentifié en a besoin — mais
le contenu s'adapte aux droits : la liste des véhicules reste vide sans
`vehicle.view`.

### `GET /api/tableau-de-bord`

Un appel, et il rend tout : la flotte avec l'état de chaque véhicule, les
chiffres de la période, les alertes **déjà triées par gravité**, et les
dernières activités. Quatre allers-retours sur un téléphone en 3G, c'est la
différence entre un écran qui s'ouvre et un écran qui se charge.

Paramètres : `du`, `au` (défaut : le mois courant), `le` (la date du jour,
pour les essais).

`compteurs` donne le nombre d'échéances par niveau — c'est ce qu'affichent les
quatre cellules en tête d'écran. Chaque alerte porte `detail` (la phrase toute
faite, en français) **et** `etat` (les nombres bruts) : l'écran préfère les
nombres, parce que c'est lui qui met les mots, et lui seul sait dans quelle
langue.

### `POST /api/activites`

```json
{
  "vehiculeId": "0199…",
  "date": "2026-09-29",
  "typeCode": "REMORQUAGE",
  "prestation": "Remorquage Oujda vers Nador",
  "kilometrage": 152300,
  "depenseCents": 5000,
  "recetteCents": 25000,
  "notes": "…",
  "idempotencyKey": "act-m1x…",
  "confirmerKilometrage": false
}
```

`kilometrage` est **facultatif** : une prime d'assurance réglée au bureau n'en
a pas, et en inventer un fausserait le compteur du véhicule.

`resultatCents` n'est jamais envoyé : la base le calcule.

**`idempotencyKey`** — tirée une fois à l'ouverture du formulaire et
inchangée entre deux tentatives. Un envoi parti dans une zone mal couverte,
dont la réponse ne revient pas, puis réessayé, porte la même clé : le serveur
reconnaît le rejeu, répond **200** avec `"rejeu": true` et l'activité
d'origine, et ne crée rien.

**Kilométrage incohérent** — le serveur répond **409** avec
`code: "KILOMETRAGE_RECUL"`, `"KILOMETRAGE_SAUT"` ou
`"KILOMETRAGE_DEPASSE_SUIVANT"`, et un message qui donne les deux valeurs.
L'écran l'affiche et propose de passer outre ; renvoyer la requête avec
`confirmerKilometrage: true` l'accepte, et marque l'activité
`kilometrageForce`. Ce geste exige `activity.force_mileage`.

### `GET /api/activites` — filtres

| Paramètre | Effet |
|---|---|
| `vehicule` | un véhicule (UUID) |
| `du`, `au` | bornes de date, incluses |
| `type` | un ou plusieurs codes, séparés par des virgules |
| `sens` | `DEPENSE`, `RECETTE`, `GAIN` (résultat > 0), `PERTE` (résultat < 0) |
| `q` | recherche sur prestation, notes, immatriculation, nom du véhicule |
| `corbeille` | `1` pour ne voir que ce qui est supprimé |
| `tri` | `date`, `date_asc`, `resultat`, `resultat_asc`, `depense`, `recette`, `kilometrage` |
| `limit`, `offset` | pagination (50 par défaut, 200 au plus) |

Ils se **combinent** (§21). « Toutes les dépenses du Renault Master en
septembre » est `vehicule` + `du` + `au` + `sens=DEPENSE`.

Les **totaux rendus portent sur toute la sélection**, pas sur la page
affichée : additionner les cinquante lignes visibles donnerait un chiffre faux.

### `POST /api/entretiens/:id/effectue`

Le geste du §34. Il fait trois choses **dans la même transaction** :

1. enregistre l'entretien comme réalisé (date, kilométrage) ;
2. crée l'activité qui porte son coût — donc visible dans les comptes du
   véhicule et dans son historique ;
3. reporte l'échéance suivante.

```json
{
  "date": "2026-09-29",
  "kilometrage": 162300,
  "coutCents": 18000,
  "notes": "Garage central",
  "prochainKm": 172300,
  "prochaineDate": null,
  "clore": false,
  "idempotencyKey": "ent-…"
}
```

`prochainKm` et `prochaineDate` absents, l'intervalle enregistré sur
l'entretien propose la suite. **S'il n'y a ni l'un ni l'autre**, le serveur
répond 400 avec `code: "ECHEANCE_INDETERMINEE"` : il faut soit donner une
échéance, soit cocher `clore`. Fermer en silence ferait disparaître
l'entretien du tableau de bord sans que personne ne le sache.

Une prochaine échéance qui serait déjà dépassée au moment de la clôture est
refusée : elle passerait au rouge aussitôt.

### `POST /api/fichiers`

`multipart/form-data` : `entity` (`vehicule` | `activite` | `entretien`),
`entityId`, et un ou plusieurs champs `fichier`. Huit au maximum par envoi.

Le droit est porté par **l'entité visée**, pas seulement par la route : on ne
joint pas une photo à un objet qu'on n'a pas le droit de regarder.

**Tous les fichiers sont examinés avant qu'un seul soit écrit** : un envoi de
quatre photos dont la troisième est un exécutable ne laisse pas les deux
premières en base.

`GET /api/fichiers/:id?inline=1` affiche l'image dans la page (miniature,
aperçu) plutôt que de la télécharger. `inline` n'est concédé qu'aux types dont
on sait qu'ils ne s'exécutent pas, et jamais sur la foi du nom du fichier.

### `GET /api/statistiques`

Mêmes filtres que la liste des activités (`du`, `au`, `vehicule`, `type`),
plus un **découpage** :

| Paramètre | Valeurs | Défaut |
|---|---|---|
| `granularite` | `mois`, `semaine` | `mois` |

La série est rendue dans `parPeriode`, chaque ligne portant son libellé
(`2026-09` ou `2026-S40`) et sa **date de début** — un numéro de semaine seul
ne dit pas quand.

« Combien j'ai dépensé cette semaine » et « combien ce mois-ci » sont deux
questions différentes, et la seconde ne répond pas à la première : un mois qui
finit bien peut cacher trois semaines mauvaises. La semaine commence le lundi
(semaine ISO).

Le reste de la réponse : `total`, `parVehicule`, `parType`.

### `PATCH /api/reglages/:cle`

`{ "valeur": 5000 }`. Les bornes de chaque paramètre sont rendues par
`GET /api/reglages`, pour que l'écran puisse refuser une saisie aberrante
avant de l'envoyer — et surtout expliquer pourquoi.

Les caches se rafraîchissent immédiatement : un seuil changé s'applique au
prochain affichage, pas au prochain redémarrage.

Les paramètres de la famille `securite.*` sont réservés au
super-administrateur.

### `GET /api/audit/verifier`

Recalcule les condensats de la chaîne et dit **sur combien d'entrées** elle
s'est prononcée. Le nombre compte autant que le verdict : un journal vérifié
sur ses cent premières entrées ne dit rien des suivantes.

```json
{
  "valid": true, "checked": 14, "total": 14, "complete": true,
  "lastHash": "54e4…",
  "anchor": { "intact": true, "manquantes": 0, "message": "Aucune entree ne manque." },
  "ancreExterne": { "presente": true, "intacte": true }
}
```
