# Lahlal — gestion de flotte

Suivre une flotte au quotidien, depuis un téléphone : les véhicules, ce qu'ils
coûtent, ce qu'ils rapportent, et ce qui arrive à échéance.

> **Je dois pouvoir enregistrer une activité en moins d'une minute, et
> comprendre l'état de mes véhicules en quelques secondes.**

Deux phrases, et c'est tout le cahier des charges. Le reste de ce fichier
explique comment l'application s'y tient.

---

## Ce que l'application fait

| | |
|---|---|
| **Véhicules** | Une fiche par véhicule, son compteur, son état en un coup d'œil |
| **Activités** | Ce qui a été fait, ce que ça a coûté, ce que ça a rapporté |
| **Entretiens** | Échéances au kilométrage, à la date, ou aux deux |
| **Alertes** | Compte à rebours et quatre niveaux, aux seuils réglables |
| **Pièces jointes** | Photo du compteur, facture de garage, attestation |
| **Statistiques** | Par période, par véhicule, par type d'activité |
| **Exports** | Classeur Excel, CSV, état imprimable d'un véhicule |

### Ce qu'elle ne fait pas, volontairement

**Aucune notion fiscale.** Pas de TVA, pas de taux, pas de numéro de pièce
comptable. Les montants enregistrés sont des dépenses réellement engagées et
des recettes réellement perçues. Ce n'est pas une comptabilité officielle, et
rien dans l'application ne leur en donne l'apparence — le schéma de base
n'a aucune colonne de taux, et un test le vérifie à chaque exécution
(`test/coherence.test.js`).

---

## Démarrer

Il faut Node.js 22.5 ou plus récent, et un PostgreSQL 14 ou plus récent.
Aucune autre dépendance : l'application n'utilise qu'un seul paquet, `pg`.

```bash
npm install

cp .env.example .env
npm run keygen -- --write      # génère les secrets dans .env
#  … renseignez DATABASE_URL et BOOTSTRAP_ADMIN_PASSWORD dans .env

npm run check -- --db          # vérifie la configuration et la base
npm run migrate                # applique le schéma
npm run seed                   # pose les droits, les types et les seuils
npm start
```

L'application écoute sur `http://localhost:8080`. Le premier compte est celui
de `BOOTSTRAP_ADMIN_USERNAME` ; son mot de passe doit être changé à la
première connexion.

Pour un compte super-administrateur — le seul qui puisse redéfinir les droits
d'un rôle — il faut un accès au serveur :

```bash
npm run superadmin -- --username direction --nom "Nom Prénom"
```

C'est délibéré : si l'application permettait de créer un tel compte depuis un
écran, il suffirait de posséder `user.manage` pour se hisser au-dessus de sa
propre hiérarchie.

### En conteneur

```bash
docker compose up --build
```

`scripts/demarrer.js` attend la base, applique le schéma, sème les
référentiels puis démarre le serveur. Les trois étapes sont idempotentes :
un redéploiement ne demande aucune intervention.

**Le dossier `data/` doit être persistant.** Il porte l'ancre externe du
journal d'audit (voir plus bas). Les pièces jointes, elles, sont en base et
ne dépendent pas de ce dossier.

---

## Vérifier

```bash
npm run verify
```

Trois passages, dans cet ordre :

| Commande | Ce qu'elle exerce |
|---|---|
| `npm run check:imports` | Chaque import nommé correspond bien à un export |
| `npm test` | 107 essais unitaires, sans base ni serveur |
| `npm run test:integration` | 62 essais sur l'application réelle, par HTTP |

Les essais d'intégration montent **une base jetable** à chaque exécution, y
appliquent le schéma, démarrent un vrai serveur et lui parlent par le réseau —
permissions, jeton CSRF et contrôle d'origine compris. Ils la détruisent
ensuite. Rien n'est joué sur la base de travail.

Ils prennent leur base dans `TEST_DATABASE_URL`, sinon dans le `DATABASE_URL`
du fichier `.env`. Sans l'une ni l'autre, ils s'arrêtent en le disant plutôt
que de deviner.

---

## Comment c'est construit

Node.js sans framework, une seule dépendance (`pg`), interface en JavaScript
natif. Ce n'est pas une contrainte subie : c'est l'architecture des deux
projets dont ce module reprend le socle, et elle a l'avantage de ne rien
devoir à une chaîne de construction.

```
server/
  core/        configuration, erreurs, journal d'audit, droits, sessions
  http/        routeur, analyse du corps, en-têtes de sécurité, statique
  db/          accès PostgreSQL, schéma, données de départ
  domain/      LE MÉTIER : échéances, seuils, flotte, pièces jointes
  routes/      la surface HTTP
public/
  css/app.css  la charte, reprise de lahlal_samuplus
  js/          l'application : core.js, app.js, vues/
```

### Ce qui vient d'ailleurs

Le cahier des charges demandait de ne rien réécrire qui existe déjà. Trois
familles ont été reprises telles quelles, ou adaptées :

| Repris | De | Adapté comment |
|---|---|---|
| Routeur, sessions, CSRF, limitation de débit, en-têtes | `lahlal_samuplus` | tels quels |
| Journal d'audit chaîné et son ancre externe | `lahlal_samuplus` | registre 09-08 retiré (aucune donnée de santé ici) |
| Charte visuelle `app.css` | `lahlal_samuplus` | ~900 lignes retirées (vitrine, assistant, éditeur de facture) |
| Chiffrement AES, index aveugle, masque PHI | `lahlal_samuplus` | **non repris** : rien à protéger de cette nature |
| Barème de TVA | `lahlal_samuplus` | **non repris** : §7 l'interdit |
| Intervalle d'entretien, prochaine échéance km/date | `location_voiture` | c'est ce qui manquait à samuplus |

---

## Les quatre décisions qui structurent le module

### 1. Le kilométrage d'un véhicule est déduit, jamais écrit

La table `vehicules` porte le relevé du compteur **au moment où le véhicule a
été ajouté**, rien de plus. Le kilométrage courant se lit dans la vue
`v_vehicules` : le plus grand entre ce relevé initial et le plus haut
kilométrage des activités vivantes du véhicule.

Le §28 demande de « recalculer le kilométrage actuel » après modification
d'une activité. Il n'y a rien à recalculer : corriger la saisie corrige
l'affichage, mettre une activité à la corbeille fait reculer le compteur,
la restaurer le rend. Une colonne dénormalisée aurait imposé ce recalcul à
chaque écriture, chaque suppression, chaque restauration — et une seule de
ces voies oubliée aurait laissé un véhicule afficher un kilométrage que plus
aucune activité ne justifie.

### 2. Le résultat est calculé par la base

```sql
resultat_cents BIGINT GENERATED ALWAYS AS (recette_cents - depense_cents) STORED
```

Trois écrans l'affichent, un export le reprend. Une seule soustraction existe,
et elle ne peut pas diverger.

### 3. Une seule table pour les entretiens et les échéances

Le cahier des charges en parle comme de deux choses. Du point de vue du
calcul, elles n'en font qu'une : quelque chose à refaire, échu à un
kilométrage, à une date, ou aux deux. Une vidange n'a qu'un kilométrage, une
assurance n'a qu'une date, une révision a les deux — c'est la même ligne
avec des colonnes laissées vides, pas trois tables.

Conséquence : le compte à rebours et les quatre niveaux d'alerte se calculent
une fois, pour tout le monde (`server/domain/echeances.js`, fonctions pures,
exercées par 39 essais sans base).

### 4. Les seuils sont des données, pas du code

À partir de combien de kilomètres une vidange devient « urgente » est une
décision d'exploitation. Elle se règle à l'écran, s'applique au prochain
affichage, et survit au redéploiement. Les valeurs du §15 ne sont que le
point de départ.

---

## La logique des alertes

Pour chaque échéance active, deux axes indépendants :

```
kilomètres restants = prochain_km   − kilométrage courant du véhicule
jours restants      = prochaine_date − aujourd'hui
```

Chaque axe reçoit un niveau, et **le pire des deux l'emporte** — « l'alerte
est déclenchée dès qu'une des deux conditions arrive à échéance » (§9).

| Niveau | Kilomètres restants | Jours restants |
|---|---|---|
| Normal | > 2 000 | > 30 |
| Attention | 500 à 2 000 | 15 à 30 |
| Urgent | < 500 | < 15 |
| **Dépassé** | **≤ 0** | **≤ 0** |

**Zéro est déjà dépassé**, et c'est un choix. Le §47 est explicite pour le
kilométrage : lorsque le véhicule *atteint* 162 300 km, la vidange doit
s'afficher en rouge. Zéro kilomètre restant n'est donc pas « il reste zéro »
mais « c'est maintenant ». La même règle vaut pour les dates, par cohérence :
elle coûte un jour d'avance sur le rappel, ce qui est le bon sens du côté où
l'on se trompe.

Un entretien **clos** sort des alertes sans sortir de l'historique. Une
échéance kilométrique sur un véhicule sans aucun relevé n'est pas « normale » :
elle est **non surveillable**, et le dire évite de la compter comme saine.

### Calcul de la prochaine échéance

L'intervalle **propose**, il n'impose pas (§11, §12).

Une vidange faite à 150 000 km avec un intervalle de 10 000 propose 160 000.
Si l'utilisateur écrit 158 000, c'est 158 000 qui s'applique, et rien ne la
ramènera à 160 000 par la suite. Les colonnes `prochain_km` et
`prochaine_date` font foi, et elles seules. L'écran affiche la proposition à
côté du champ plutôt que de le pré-remplir : un champ pré-rempli se valide
sans être lu.

### Cohérence du kilométrage (§4)

Une saisie en recul sur ce que l'on sait déjà **demande confirmation**, elle
n'est pas refusée : un compteur se remplace, un relevé se corrige. L'activité
garde alors la trace qu'elle a été forcée, et le journal dit qui a tranché.

Le contrôle tient compte de la date, et les deux bornes ne traitent pas le
même jour de la même façon :

- **borne basse** : le plus haut relevé à cette date *ou avant*. Dans une
  journée, le compteur ne descend pas.
- **borne haute** : le plus bas relevé d'un jour *strictement postérieur*.

Sans cette asymétrie, la deuxième activité d'une même journée déclencherait un
avertissement dès qu'elle porte un kilométrage supérieur à la première —
c'est-à-dire toujours. Un avertissement qui se déclenche toujours est un
avertissement qu'on confirme sans le lire.

Un bond démesuré (plus de 50 000 km d'un coup) demande confirmation lui aussi :
c'est la même faute de frappe vue dans l'autre sens.

---

## Les pièces jointes

> **Le type d'un fichier est celui de ses octets, jamais celui de son nom.**

Ni l'extension ni le `Content-Type` annoncé ne servent à décider : tous deux
sont écrits par le client. Un exécutable renommé `recu.png` et annoncé
`image/png` est refusé.

Formats acceptés : JPEG, PNG, WEBP, **HEIC** et PDF. Le HEIC est le format
natif des photos d'iPhone — refuser la photo d'un compteur parce qu'elle vient
d'un iPhone n'aurait aucun sens — mais aucun navigateur hors Safari ne sait
l'afficher : il reçoit l'icône générique, comme un PDF.

Autres garde-fous :

- taille bornée par `UPLOAD_MAX_MB` (10 Mo par défaut) ;
- **un envoi mixte est rejeté en entier** : quatre photos dont la troisième est
  un exécutable ne laissent pas les deux premières en base ;
- nom nettoyé (séparateurs de chemin, octet nul, caractères de contrôle) et
  extension réécrite d'après le type réel ;
- empreinte SHA-256 vérifiée à la restitution : une pièce altérée en base ne
  sort pas ;
- restitution en `nosniff` + `Content-Disposition: attachment`, sauf pour les
  images qu'on affiche en miniature.

Le contenu est stocké **en base**, pas sur le disque : un conteneur qui
redémarre repart d'un système de fichiers vide, et une photo de facture perdue
ne se retrouve pas.

Côté navigateur, les images sont **réduites avant l'envoi** (1 600 px, JPEG
82 %) : une photo de 5 Mo en pèse quelques centaines de kilo-octets, ce qui
compte quand on saisit depuis le bord de la route.

---

## La sécurité

Reprise du socle, et vérifiée par les essais :

- mots de passe en **scrypt** + sel + poivre applicatif hors base ;
- session par cookie `HttpOnly`, jeton jamais stocké en clair (condensat seul) ;
- **jeton CSRF** sur toute écriture, dans l'en-tête ; contrôle d'origine ;
- verrouillage progressif du compte après N échecs, réglable à l'écran ;
- limitation de débit par adresse, budget distinct pour les fichiers statiques
  et pour les téléversements ;
- **une route sans annotation est refusée** : l'oubli ferme l'accès au lieu de
  l'ouvrir. Un essai vérifie que chaque route déclare une permission, et que
  les seules routes publiques sont `/healthz`, `/api/auth/session` et
  `/api/auth/login` ;
- **hiérarchie par rang** : les permissions disent ce qu'on peut faire, le rang
  dit *sur qui*. Un compte n'agit que sur un rang strictement inférieur au
  sien — deux administrateurs ne se touchent pas l'un l'autre ;
- un changement de rôle ou une désactivation **ferme les sessions ouvertes** :
  elles portent les anciens droits, et une session vit jusqu'à douze heures.

### Le journal d'audit

Chaque entrée est chaînée à la précédente par un condensat, et un déclencheur
PostgreSQL refuse tout `UPDATE` et tout `DELETE` sur la table.

La chaîne attrape une entrée modifiée ; l'ancrage par la séquence attrape une
queue coupée. Mais qui tient la base tient aussi la séquence. L'**ancre
externe** — la tête de chaîne écrite dans `data/journal-ancre.json` après
chaque validation — impose de tenir la base *et* le disque pour raccourcir le
journal sans être vu. Ce n'est pas une garantie absolue ; elle est écrite comme
telle dans le message rendu à l'écran, et se désactive par
`AUDIT_ANCRE_EXTERNE=false`.

Un refus de droit sur une écriture **laisse une trace**. Ce qu'un contrôle
cherche n'est pas la liste de ce qui a marché : c'est qui a tenté ce qu'il
n'avait pas le droit de faire. Ces traces passent par une file — une connexion
au plus — pour qu'une rafale de refus n'épuise pas le pool.

`/healthz` passe en **503** si une entrée du journal n'a pas pu être écrite :
un journal muet est un incident, pas un détail.

---

## Documentation

| Fichier | Contenu |
|---|---|
| [`docs/API.md`](docs/API.md) | Toutes les routes, leurs paramètres et leurs droits |
| [`docs/EXPLOITATION.md`](docs/EXPLOITATION.md) | Déploiement, variables, sauvegarde, incidents |
| [`docs/MODELE.md`](docs/MODELE.md) | Tables, colonnes, index, migrations |
| [`.env.example`](.env.example) | Chaque variable, avec sa raison d'être |

---

## Rôles livrés

| Rôle | Rang | Ce qu'il fait |
|---|---|---|
| Super-administrateur | 0 | Seul à redéfinir les droits d'un rôle ; se crée en ligne de commande |
| Administrateur | 10 | Tout le reste : flotte, comptes, seuils, journal |
| Gestionnaire de flotte | 20 | Véhicules, activités, entretiens, pièces |
| Saisie terrain | 40 | Enregistre et photographie. Ne modifie ni ne supprime |
| Consultation | 60 | Lit, sans rien changer |

Les droits de chaque rôle se redéfinissent à l'écran ; un rôle ainsi modifié
porte `is_customized` et le redémarrage suivant ne le rejoue pas.
