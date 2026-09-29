# Le modèle de données

15 tables et une vue. Le fichier `server/db/schema.sql` est **idempotent** :
il se rejoue sans dommage, et c'est ce qui permet de l'inclure dans le
démarrage du conteneur.

Aucune extension PostgreSQL n'est requise pour démarrer : les identifiants
sont des UUID v7 produits par l'application, pas par la base. `pg_trgm` est
demandé pour indexer la recherche textuelle, mais **son absence n'empêche
rien** — sur un hébergeur qui refuse la création d'extensions, la migration
continue et la recherche garde son comportement d'avant. Elle est alors
lente, jamais fausse.

---

## Vue d'ensemble

```
roles ──< role_permissions >── permissions
  │
users ──< user_permission_overrides
  │  └──< sessions
  │  └──< login_attempts (par identifiant, pas par clé étrangère)
  │
  └──> audit_log        (chaîné, immuable)

vehicules ──< activites ──> types (domaine ACTIVITE)
    │            └──> entretiens        (quand l'activité clôt un entretien)
    ├──< entretiens ──> types (domaine ENTRETIEN)
    └──< fichiers  (polymorphe : vehicule | activite | entretien)

settings   (seuils d'alerte + posture de sécurité)
app_meta   (date d'application du schéma)
```

---

## Les tables du métier

### `vehicules`

| Colonne | Type | Rôle |
|---|---|---|
| `id` | UUID | clé primaire (v7, donc ordonnée dans le temps) |
| `immatriculation` | TEXT | telle qu'elle se lit |
| `immatriculation_norm` | TEXT **UNIQUE** | sans espace ni tiret : c'est elle qui porte l'unicité |
| `libelle` | TEXT | nom d'usage — « Ambulance 1 », « Le Master » |
| `marque`, `modele`, `annee` | | |
| `kilometrage_initial` | INTEGER | **le relevé du jour où le véhicule est entré au parc** |
| `statut` | TEXT | `DISPONIBLE` `EN_SERVICE` `MAINTENANCE` `IMMOBILISE` `VENDU` |
| `photo_id` | UUID → `fichiers` | facultative |
| `archived_at`, `archived_by` | | archivage, jamais suppression |

**Il n'y a pas de colonne `kilometrage`.** C'est le point de conception du
module : le kilométrage courant se lit dans la vue `v_vehicules`. Voir plus
bas.

`1234-A-56` et `1234 A 56` sont le même camion. La forme normalisée l'impose ;
deux fiches couperaient l'historique en deux.

### `activites`

Le geste central. Une ligne = une chose faite avec un véhicule, un jour donné,
avec ce qu'elle a coûté et ce qu'elle a rapporté.

| Colonne | Type | Rôle |
|---|---|---|
| `vehicule_id` | UUID → `vehicules` | `ON DELETE RESTRICT` |
| `date_activite` | DATE | |
| `type_code` | TEXT → `types` | via la clé composite `(type_domaine, type_code)` |
| `prestation` | TEXT | 1 à 200 caractères |
| `kilometrage` | INTEGER **NULL** | facultatif : une prime d'assurance n'en a pas |
| `kilometrage_force` | BOOLEAN | la valeur a été confirmée malgré un avertissement |
| `depense_cents` | BIGINT ≥ 0 | |
| `recette_cents` | BIGINT ≥ 0 | |
| `resultat_cents` | BIGINT **GENERATED** | `recette_cents - depense_cents`, calculé par la base |
| `entretien_id` | UUID → `entretiens` | renseigné quand l'activité naît d'une clôture |
| `idempotency_key` | TEXT **UNIQUE** | contre le double envoi depuis un réseau instable |
| `deleted_at`, `deleted_by`, `delete_reason` | | corbeille (§29) |

`type_domaine` vaut toujours `'ACTIVITE'` : la colonne matérialise le domaine
pour que la clé étrangère composite tienne, son défaut évite de l'écrire, et
sa contrainte interdit d'y mettre autre chose. Une activité ne peut donc pas
pointer vers un type d'entretien.

### `entretiens`

**Une seule table pour les entretiens et les échéances administratives.** Du
point de vue du calcul, elles n'en font qu'une.

| Colonne | Rôle |
|---|---|
| `derniere_date`, `dernier_km` | la dernière réalisation |
| `intervalle_km`, `intervalle_mois` | **proposent** la suite, ne l'imposent pas |
| `prochain_km`, `prochaine_date` | **font foi**, et elles seules |
| `statut` | `ACTIF` ou `CLOS` — clos sort des alertes, pas de l'historique |

Une contrainte refuse un entretien actif sans aucune échéance :

```sql
CHECK (statut = 'CLOS' OR prochain_km IS NOT NULL OR prochaine_date IS NOT NULL)
```

Une échéance qui ne dit ni quand ni à quel kilométrage ne surveille rien. La
refuser à l'écriture vaut mieux que l'afficher en permanence comme « sans
échéance » dans une liste faite pour montrer ce qui approche.

### `fichiers`

Polymorphe : `entity` ∈ (`vehicule`, `activite`, `entretien`) + `entity_id`.

Le contenu est en `BYTEA`, **pas sur le disque** : un conteneur qui redémarre
repart d'un système de fichiers vide, et une photo de facture perdue ne se
retrouve pas. La sauvegarde de la base emporte les pièces avec elle.

`sha256` est vérifié à la restitution : une pièce altérée en base ne sort pas.

Le `mime` est contraint à cinq valeurs, et il est déterminé par les **octets
d'en-tête** du fichier, jamais par son extension.

### `types`

Les types d'activité **et** d'entretien, dans une seule table, distingués par
`domaine`. Clé primaire `(domaine, code)`.

Deux tables auraient imposé deux écrans, deux routes et deux jeux de tests
pour la même chose : un code, un libellé, un ordre, un interrupteur.

Un type livré en standard (`is_system`) ne se supprime pas : il se désactive.
Des activités s'y rattachent, et les effacer leur ferait perdre leur libellé —
l'historique se lirait en codes.

### `settings`

Clé/valeur. Y vivent les **seuils d'alerte** (§15) et la posture de sécurité.
Le libellé est du texte d'interface : il suit le code. La valeur, non — un
seuil réglé à l'écran ne revient pas à sa valeur d'usine au redémarrage
suivant.

---

## La vue `v_vehicules`

```sql
GREATEST(
  v.kilometrage_initial,
  COALESCE((SELECT MAX(a.kilometrage) FROM activites a
             WHERE a.vehicule_id = v.id
               AND a.deleted_at IS NULL
               AND a.kilometrage IS NOT NULL), 0)
)::int AS kilometrage
```

Tout ce qui affiche un kilométrage passe par là : la liste, la fiche, le
calcul des échéances kilométriques, le tableau de bord. La valeur montrée et
la valeur comparée à `prochain_km` sont donc nécessairement la même.

**Pourquoi déduit plutôt que stocké.** Le §28 demande de « recalculer le
kilométrage actuel » après modification d'une activité. Une colonne
dénormalisée l'aurait imposé à chaque écriture, chaque suppression, chaque
restauration depuis la corbeille — et une seule de ces voies oubliée aurait
laissé un véhicule afficher un kilométrage que plus aucune activité ne
justifie. Déduit, il ne peut pas dériver.

Le coût est une agrégation par véhicule. L'index partiel
`idx_activites_kilometrage (vehicule_id, kilometrage DESC)` y répond par une
lecture d'index, sans toucher la table.

---

## Les index

Ceux que le §32 demande, et rien de plus.

| Index | Sert à |
|---|---|
| `idx_activites_vehicule_date` | la fiche d'un véhicule, sa timeline |
| `idx_activites_date` | la liste et le tableau de bord |
| `idx_activites_type` | le filtre par type |
| `idx_activites_kilometrage` | le calcul du kilométrage courant |
| `idx_activites_entretien` | l'historique d'un entretien |
| `uq_activites_idempotency` | le rejeu d'un envoi |
| `idx_entretiens_vehicule` | les échéances d'un véhicule |
| `idx_entretiens_date` / `_km` | les échéances qui approchent |
| `idx_fichiers_entity` | les pièces d'une entité |
| `idx_vehicules_actifs` | la liste, hors archivés |
| `idx_activites_rech_*` | la recherche textuelle (si `pg_trgm` est là) |

Les index sur les activités sont **partiels** : `WHERE deleted_at IS NULL`.
La corbeille ne pèse pas sur les requêtes courantes.

---

## Migrations

Il n'y a pas de fichiers de migration numérotés. `schema.sql` est écrit pour
être **rejoué** :

- `CREATE TABLE IF NOT EXISTS` pour les tables ;
- `CREATE INDEX IF NOT EXISTS` pour les index ;
- un bloc `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint …) $$` pour
  chaque contrainte ajoutée après coup ;
- `CREATE OR REPLACE VIEW` pour les vues.

`npm run migrate` joue le fichier entier **dans une seule transaction** : en
cas d'erreur, la base reste exactement dans l'état où elle était. Un verrou
consultatif sérialise les migrations concurrentes — un orchestrateur qui
démarre quatre répliques lance quatre migrations au même instant, et sans ce
verrou deux d'entre elles se prennent les verrous de tables dans un ordre
différent.

Le délai d'instruction est relevé à dix minutes pour cette transaction, et
revient à sa valeur normale au `COMMIT` : une création d'index sur une grosse
table dépasse largement les trente secondes d'une requête d'écran.

### Ajouter une colonne

```sql
ALTER TABLE activites ADD COLUMN IF NOT EXISTS ma_colonne TEXT;
```

À la fin du fichier, dans une section « Évolutions ». `CREATE TABLE IF NOT
EXISTS` ne touche pas une table déjà créée : les colonnes ajoutées après coup
doivent l'être explicitement.

---

## Ce qui n'existe pas, et pourquoi

| Absent | Raison |
|---|---|
| Toute colonne de TVA, taux ou base imposable | §7 : activité non déclarée. Un test le vérifie |
| `NUMERIC`, `REAL`, `DOUBLE PRECISION` | les montants sont des entiers de centimes. Un test le vérifie |
| Une colonne `kilometrage` sur `vehicules` | déduite par la vue. Un test le vérifie |
| Un `UPDATE` ou un `DELETE` possible sur `audit_log` | un déclencheur les refuse |
| Les tables `clients`, `missions`, `invoices` du socle | ce module ne facture pas |
