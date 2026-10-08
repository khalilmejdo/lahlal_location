# Mise en service sur Coolify

Déploiement du module **gestion de flotte** sur le serveur Hetzner qui
héberge déjà `lahlal_samuplus`.

Ce document est une procédure d'exploitation : il se suit dans l'ordre, du
haut vers le bas, et chaque étape se vérifie avant de passer à la suivante.
Les commandes `#` se lancent sur le serveur, en SSH. Les commandes `$` se
lancent depuis votre poste.

> **Les deux applications ne se touchent pas.** Projet Coolify distinct,
> sous-domaine distinct, base distincte, volumes distincts, secrets
> distincts. La seule chose qu'elles partagent est la machine et le proxy.
> Si l'une tombe, l'autre reste debout.

---

## Sommaire

1. [Avant de commencer](#1-avant-de-commencer)
2. [Le sous-domaine](#2-le-sous-domaine)
3. [Les secrets](#3-les-secrets)
4. [Le projet Coolify](#4-le-projet-coolify)
5. [Les variables d'environnement](#5-les-variables-denvironnement)
6. [Le domaine et la sonde de santé](#6-le-domaine-et-la-sonde-de-santé)
7. [Le premier déploiement](#7-le-premier-déploiement)
8. [Le super-administrateur — étape obligatoire](#8-le-super-administrateur--étape-obligatoire)
9. [Fermer la porte d'entrée](#9-fermer-la-porte-dentrée)
10. [Recette de mise en service](#10-recette-de-mise-en-service)
11. [Les sauvegardes](#11-les-sauvegardes)
12. [Le retour arrière](#12-le-retour-arrière)
13. [Les mises à jour courantes](#13-les-mises-à-jour-courantes)
14. [Quand quelque chose ne va pas](#14-quand-quelque-chose-ne-va-pas)

---

## 1. Avant de commencer

### Ce qu'il faut avoir sous la main

| Élément | Valeur |
|---|---|
| Serveur | le Hetzner qui porte `lahlal_samuplus` |
| Accès | SSH root, et le compte Coolify |
| Dépôt | `github.com/khalilmejdo/lahlal_location`, branche `main` |
| Sous-domaine | `flotte.lahlal-samuplus.ma` — un sous-domaine par application, comme `gestion.lahlal-samuplus.ma` pour SAMU PLUS |
| Zone DNS | chez Hetzner **ou** chez le registrar — fiche 15 § 2 et § 3 |
| Fichier compose | `docker-compose.coolify.yml` (**pas** `docker-compose.yml`) |

### Les deux fichiers compose, et pourquoi il y en a deux

`docker-compose.yml` est le montage du poste de développement : mot de
passe de base en clair, cookies non sécurisés, ports publiés sur la
machine. **Il ne doit jamais être déployé.**

`docker-compose.coolify.yml` est celui de la production : aucun secret
dans le fichier, aucun port publié, cookies sécurisés et HSTS actifs. Les
secrets se posent dans Coolify, et le déploiement échoue franchement si
l'un d'eux manque — plutôt que de démarrer sur une valeur vide.

### Vérifier que la place est libre

```sh
# Le serveur a-t-il de quoi tenir une base de plus ?
df -h /
free -m
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

Comptez ~400 Mo de mémoire pour PostgreSQL et ~150 Mo pour l'application,
plus la place du *build* : Coolify compile l'image sur le serveur.

**Lisez ces trois chiffres avant de continuer**, et n'y allez pas si :

| Mesure | Seuil de prudence |
|---|---|
| `free -m`, colonne *available* | moins de **700 Mo** |
| `df -h /`, colonne *Avail* | moins de **5 Go** |

> **Un déploiement qui déclenche le tueur de mémoire emporte aussi SAMU PLUS.**
> C'est le seul vrai risque de cette opération : les deux applications sont
> séparées en tout — projet, base, volumes, secrets — sauf qu'elles partagent
> la machine. Une mise en service de flotte qui manque de mémoire ne se
> contente pas d'échouer, elle fait tomber la facturation.
>
> Si la place manque : la fiche **08 — ESPACE DISQUE** de
> `PROCEDURES-SERVEUR` donne de quoi récupérer du disque (images Docker
> orphelines, anciens *builds*). Pour la mémoire, un serveur plus grand est la
> seule réponse honnête.

**Prenez une sauvegarde de SAMU PLUS avant de commencer.** Elle ne protège pas
flotte, qui n'a encore rien ; elle protège ce qui tourne déjà, au cas où le
serveur devait être redémarré en cours de route. C'est l'étape 5 de la
checklist `A-FAIRE-SAMU-PLUS-MISE-EN-LIGNE-ET-GOOGLE.md`.

---

## 2. Le sous-domaine

Un enregistrement `A` qui pointe `flotte.lahlal-samuplus.ma` vers l'adresse
IPv4 du serveur — la **même** que celle qui sert déjà
`gestion.lahlal-samuplus.ma`. Les deux applications partagent la machine et
son proxy ; c'est le nom qui les sépare, pas l'adresse.

### D'abord : où vit la zone DNS ?

La réponse décide de l'écran où aller. Depuis votre poste :

```powershell
Resolve-DnsName lahlal-samuplus.ma -Type NS -Server 8.8.8.8
```

- Les serveurs répondus contiennent **`hetzner`** → la zone est chez Hetzner,
  allez au § 2.1.
- Ils portent le nom du **registrar** (là où le domaine a été acheté) → § 2.2.

> La fiche **15 — CHANGEMENT DE DOMAINE** du dossier `PROCEDURES-SERVEUR`
> traite les deux cas en détail (§ 2 et § 3). Ce qui suit en est le strict
> nécessaire pour ajouter un sous-domaine de plus.

### 2.1 — La zone est chez Hetzner

[console.hetzner.com](https://console.hetzner.com) → le projet → **DNS** → la
zone `lahlal-samuplus.ma` → **Add record** :

| Champ | Valeur |
|---|---|
| Type | `A` |
| Name | `flotte` |
| Value | l'IPv4 du serveur |
| TTL | laisser le défaut |

**Le champ `Name` ne porte que `flotte`**, pas le domaine entier. Écrire
`flotte.lahlal-samuplus.ma` y créerait
`flotte.lahlal-samuplus.ma.lahlal-samuplus.ma` — l'erreur classique, et elle
ne se voit qu'au moment où le certificat échoue.

### 2.2 — La zone est chez le registrar

Même enregistrement, dans l'éditeur de zone du registrar : type `A`, nom
`flotte`, valeur l'IPv4 du serveur. Même piège sur le nom.

### Retrouver l'IPv4 du serveur

Si vous ne l'avez pas sous la main, elle est celle qui sert déjà SAMU PLUS :

```powershell
Resolve-DnsName gestion.lahlal-samuplus.ma -Type A -Server 8.8.8.8
```

### Attendre, et vérifier

```powershell
Resolve-DnsName flotte.lahlal-samuplus.ma -Type A -Server 8.8.8.8
```

La réponse doit être l'IP du serveur, et rien d'autre. **N'allez pas plus loin
avant.** Coolify demande le certificat à Let's Encrypt dès que le domaine est
posé sur le service ; si le nom ne résout pas encore, l'émission échoue et il
faut la relancer à la main.

Comptez quelques minutes, parfois une heure selon le TTL de la zone. Interroger
`8.8.8.8` plutôt que le résolveur du poste évite de lire une réponse négative
mise en cache localement.

---

## 3. Les secrets

Deux secrets de 64 caractères hexadécimaux, **distincts l'un de l'autre**,
plus le mot de passe de la base.

Depuis votre poste, dans le dépôt :

```sh
$ npm run keygen
```

Le script affiche `APP_SECRET` et `APP_PASSWORD_PEPPER`. Pour le mot de
passe de la base :

```sh
$ openssl rand -base64 30 | tr -d '/+=' | cut -c1-32
```

> ### `APP_PASSWORD_PEPPER` ne se change JAMAIS après la mise en service
>
> Il entre dans le calcul des empreintes de mots de passe. Le modifier
> rend **tous** les comptes inaccessibles d'un coup, y compris le vôtre,
> et la seule issue est de réinitialiser chaque mot de passe en ligne de
> commande. Notez-le dans le gestionnaire de mots de passe **maintenant**,
> avant de le coller dans Coolify.
>
> `APP_SECRET`, lui, peut être changé : cela déconnecte simplement tout le
> monde.

Ces trois valeurs vont dans le gestionnaire de mots de passe. Elles ne
vont **nulle part** dans le dépôt : `.env` est ignoré par git, et il doit
le rester.

---

## 4. Le projet Coolify

Un projet séparé, pour que rien ne se mélange avec samuplus.

1. Coolify → **Projects** → **+ Add**
   - Name : `lahlal-flotte`
   - Description : `Gestion de flotte et suivi d'activite`
2. Dans le projet, environnement **production** → **+ New** → **Resource**
3. Source :
   - dépôt privé → **Private Repository (with GitHub App)**
   - dépôt public → **Public Repository**, URL
     `https://github.com/khalilmejdo/lahlal_location`
4. Configuration :

   | Champ | Valeur |
   |---|---|
   | Branch | `main` |
   | Build Pack | **Docker Compose** |
   | Docker Compose Location | `/docker-compose.coolify.yml` |
   | Base Directory | `/` |

5. **Save**. Ne déployez pas encore — les variables ne sont pas posées.

Coolify lit le fichier et découvre deux services : `base` et
`application`. S'il n'en voit qu'un, ou aucun, le chemin du fichier est
faux : corrigez-le avant d'aller plus loin.

---

## 5. Les variables d'environnement

Onglet **Environment Variables** de la ressource. Une par ligne.

### Obligatoires

| Nom | Valeur |
|---|---|
| `POSTGRES_DB` | `flotte` |
| `POSTGRES_USER` | `flotte` |
| `POSTGRES_PASSWORD` | *(celui généré à l'étape 3)* |
| `APP_SECRET` | *(64 hex, étape 3)* |
| `APP_PASSWORD_PEPPER` | *(64 hex, étape 3, **différent du précédent**)* |
| `ALLOWED_ORIGINS` | `https://flotte.lahlal-samuplus.ma` |
| `BOOTSTRAP_ADMIN_PASSWORD` | *(un mot de passe fort, temporaire)* |

### Facultatives

| Nom | Défaut | Quand y toucher |
|---|---|---|
| `TZ` | `Africa/Casablanca` | jamais, sauf changement de pays |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | si vous voulez un autre identifiant |
| `UPLOAD_MAX_MB` | `10` | si les photos de compteur sont refusées |

### Trois pièges

**`ALLOWED_ORIGINS` n'a pas de barre oblique finale.** `https://flotte.lahlal-samuplus.ma/`
est une valeur différente de `https://flotte.lahlal-samuplus.ma`, et la protection
CSRF rejettera alors tout enregistrement : l'application s'affichera très
bien, et rien ne pourra être saisi.

**`BOOTSTRAP_ADMIN_PASSWORD` doit respecter la politique** — au moins 12
caractères, et il ne doit **pas contenir l'identifiant**. Un mot de passe
`admin2026!` sera refusé et le premier compte ne sera pas créé.

**Les deux secrets doivent être différents.** La vérification de
configuration refuse de démarrer s'ils sont identiques, et c'est voulu.

### Ce qui ne se règle PAS ici

Les seuils d'alerte — à partir de combien de kilomètres ou de combien de
jours une échéance devient « attention » puis « urgente » — ne sont pas
des variables d'environnement. Ils vivent en base et se règlent à l'écran,
**Paramètres**. Les chercher ici est une perte de temps ; les y poser
n'aurait aucun effet.

---

## 6. Le domaine et la sonde de santé

Dans **Configuration** → service `application` :

| Champ | Valeur |
|---|---|
| Domains | `https://flotte.lahlal-samuplus.ma` |
| Port | `3000` |

Le service `base` **n'a pas de domaine**. Il ne doit pas en avoir : la
base n'est joignable que par l'application, sur le réseau interne du
projet. C'est ce qui rend `DATABASE_SSL=off` légitime — le trafic ne
quitte pas la machine.

La sonde de santé est déjà déclarée dans le fichier compose et interroge
`/healthz`. Rien à saisir. Si Coolify propose un **Health Check Path**,
renseignez `/healthz`.

Vérifiez enfin, dans **Persistent Storage**, que les deux volumes nommés
apparaissent :

- `donnees-base` → `/var/lib/postgresql/data`
- `donnees-app` → `/app/data`

> **`donnees-app` n'est pas accessoire.** Il porte l'ancre externe du
> journal d'audit : à chaque écriture, la tête de la chaîne de condensats
> y est recopiée hors de la base. La chaîne détecte une entrée modifiée ;
> l'ancre détecte une **queue coupée** par quelqu'un qui tient la base.
> Sur un système de fichiers éphémère, elle disparaît à chaque
> redéploiement et ne prouve plus rien.
>
> Les pièces jointes, elles, sont en base : un conteneur qui redémarre ne
> perd aucune photo.

---

## 7. Le premier déploiement

**Deploy**. Comptez deux à quatre minutes.

Dans les journaux de `application`, vous devez voir, dans cet ordre :

```
  Base joignable en NN ms (tentative 1).
  Application du schema…
  Initialisation des donnees…
  Serveur en ecoute sur 0.0.0.0:3000
```

Le démarrage applique le schéma puis l'initialisation à **chaque**
redémarrage. Les deux sont idempotentes : elles n'écrasent jamais une
donnée existante. C'est ce qui permet de redéployer sans intervention.

Vérifiez de l'extérieur :

```sh
$ curl -i https://flotte.lahlal-samuplus.ma/healthz
```

Attendu : `HTTP/2 200`, et un corps JSON indiquant la base joignable.

### Si le déploiement échoue immédiatement

Un message de la forme `renseignez APP_SECRET` signifie exactement ce
qu'il dit : la variable manque. C'est le comportement voulu — mieux vaut
un déploiement qui refuse de partir qu'une application qui démarre avec un
secret vide.

---

## 8. Le super-administrateur — étape obligatoire

> **Ne sautez pas cette étape, et ne la remettez pas à plus tard.**

L'application a **deux rôles**, et deux seulement :

| Rôle | Rang | Ce qu'il peut faire |
|---|---|---|
| **Super-administrateur** | 0 | tout, sans exception |
| **Administrateur** | 10 | tout le travail quotidien |

Trois droits sont réservés au super-administrateur :

- `role.manage` — redéfinir les droits d'un rôle ;
- `user.manage` — créer un compte, en changer le mot de passe, le
  désactiver ;
- `attachment.restore` — ressortir une pièce jointe supprimée de la
  corbeille.

Le compte `admin` créé par `BOOTSTRAP_ADMIN_PASSWORD` est un
**administrateur**. Il ne peut donc **pas créer de comptes**. Tant que le
super-administrateur n'existe pas, l'installation est dans une impasse :
personne ne peut ajouter d'utilisateur.

### Pourquoi un script, et non un écran

Le super-administrateur est le seul rôle capable d'agir sur un
administrateur. Si l'interface permettait d'en créer un, il suffirait de
posséder `user.manage` — que tout administrateur posséderait — pour se
hisser au-dessus de sa propre hiérarchie. L'opération exige donc un accès
au serveur, c'est-à-dire à l'hébergement : un pouvoir qui ne se prend pas,
il se donne.

### La commande

Repérez le conteneur, puis lancez le script :

```sh
# docker ps --format '{{.Names}}' | grep -i application
# docker exec -it <nom-du-conteneur> \
    node scripts/superadmin.js --username direction --nom "Khalil Mejdoubi"
```

Le script affiche le mot de passe **une seule fois** :

```
  Compte super-administrateur cree.

    identifiant     direction
    mot de passe    XXXXXXXXXXXXXXXXXXXX

  Ce mot de passe ne sera plus affiche.
```

Copiez-le dans le gestionnaire de mots de passe immédiatement, puis
connectez-vous à `https://flotte.lahlal-samuplus.ma` et changez-le.

En cas de perte :

```sh
# docker exec -it <nom-du-conteneur> \
    node scripts/superadmin.js --username direction --reset
```

### Pourquoi deux rôles suffisent

L'administrateur peut tout faire au quotidien, y compris supprimer. Ce qui
protège ici n'est pas la restriction, c'est **la trace** :

- rien n'est réellement détruit — véhicules, activités et entretiens sont
  archivés, les pièces jointes partent en corbeille ;
- tout geste destructeur exige un **motif**, saisi et conservé ;
- chaque écriture est inscrite au journal d'audit, chaîné par condensats
  et ancré hors base ;
- un déclencheur PostgreSQL **refuse** toute modification ou suppression
  d'une ligne du journal, y compris en SQL direct.

Multiplier les rôles aurait ajouté de la configuration à maintenir sans
rien ajouter à la sécurité réelle.

---

## 9. Fermer la porte d'entrée

Une fois le super-administrateur créé **et** la connexion vérifiée :

1. Coolify → **Environment Variables** → **supprimer**
   `BOOTSTRAP_ADMIN_PASSWORD`.
2. **Redeploy**.

La variable n'a plus d'usage : le compte initial n'est créé qu'une fois,
et seulement si la base n'a aucun compte. La laisser en place, c'est
laisser un mot de passe d'installation dans la configuration d'un service
en production.

Décidez aussi du sort du compte `admin` initial : s'il ne sert à personne,
désactivez-le depuis l'écran **Comptes**, connecté en
super-administrateur.

---

## 10. Recette de mise en service

À passer **en entier**, dans l'ordre, avant d'annoncer l'application. Sur
un téléphone de préférence : c'est l'usage principal.

### Accès et sécurité

- [ ] `https://flotte.lahlal-samuplus.ma` répond, certificat valide, cadenas fermé.
- [ ] `http://flotte.lahlal-samuplus.ma` redirige vers `https`.
- [ ] `https://flotte.lahlal-samuplus.ma/healthz` → `200`.
- [ ] Connexion en super-administrateur : acceptée.
- [ ] Connexion avec un mot de passe faux : refusée, et après 5 essais le
      compte est verrouillé 15 minutes.
- [ ] Déconnexion : le retour arrière du navigateur ne redonne pas l'accès.
- [ ] **samuplus répond toujours normalement.**

### Les deux rôles

- [ ] Écran **Comptes** : exactement deux rôles, pas un de plus.
- [ ] En super-administrateur : création d'un compte administrateur
      possible.
- [ ] En administrateur : l'écran Comptes n'offre **ni** création **ni**
      modification de compte.
- [ ] En administrateur : aucune action possible sur le compte du
      super-administrateur.

### Le travail quotidien

- [ ] Créer un véhicule, avec son kilométrage initial.
- [ ] Saisir une activité avec une recette et une dépense — le résultat
      s'affiche sans qu'on le calcule.
- [ ] Prendre **plusieurs photos** en une fois depuis le téléphone.
- [ ] Saisir une activité datée d'aujourd'hui : **acceptée**.
      *(Si elle est refusée comme « dans le futur », le fuseau du
      conteneur est faux — voir §14.)*
- [ ] Saisir un kilométrage inférieur au précédent : refusé, message clair.
- [ ] Filtrer les dépenses par semaine, puis par mois.
- [ ] Basculer en **darija** : l'écran passe en arabe, de droite à gauche,
      et les **noms saisis restent tels quels**.

### Les alertes — le cœur du module

À vérifier sur une échéance d'essai, en modifiant le kilométrage du
véhicule :

- [ ] Loin du seuil → **normale**, l'échéance n'apparaît pas en alerte.
- [ ] En approche → **attention** (orange).
- [ ] Tout près → **urgente** (rouge).
- [ ] Seuil atteint → **dépassée**.
- [ ] Seuil franchi de plusieurs centaines de kilomètres → toujours
      **dépassée**, et le dépassement est chiffré.
- [ ] Même exercice sur une échéance **à date** : à +60 jours, +25, +5,
      puis −3.
- [ ] Une échéance qui a **les deux** critères prend le pire des deux.
- [ ] Le tableau de bord affiche **exactement** les mêmes nombres que la
      liste des alertes.
- [ ] Déclarer l'entretien fait : l'alerte disparaît et la suivante est
      calculée.
- [ ] Déclarer fait une échéance **sans périodicité** : refusée tant qu'on
      n'a pas explicitement demandé à la clore.

Et ce qui ne doit **pas** alerter :

- [ ] une échéance close ;
- [ ] un véhicule sans relevé de kilométrage ;
- [ ] un véhicule archivé.

> Ces vingt-cinq situations sont couvertes par la suite automatisée
> (`test/integration/alertes.test.js`). La recette manuelle vérifie
> qu'elles tiennent **sur le serveur réel**, avec son fuseau et ses
> données.

### L'historisation

- [ ] Écran **Journal** : les gestes des minutes précédentes y figurent,
      avec leur auteur et leur horodatage.
- [ ] Supprimer une pièce jointe : un **motif** est exigé.
- [ ] La pièce supprimée n'apparaît plus dans la liste du véhicule.
- [ ] En super-administrateur, la **corbeille** la contient, et la
      restauration la ramène.
- [ ] En administrateur, la corbeille est inaccessible.
- [ ] **Vérifier l'intégrité du journal** → chaîne intacte, ancre externe
      concordante.

### Les exports

- [ ] Export Excel : s'ouvre, les montants sont des nombres, pas du texte.
- [ ] Export CSV : s'ouvre, les accents sont corrects.
- [ ] L'export suit les filtres affichés à l'écran.

---

## 11. Les sauvegardes

### Ce qu'il faut sauvegarder

| Quoi | Où | Pourquoi |
|---|---|---|
| La base | volume `donnees-base` | tout : véhicules, activités, pièces jointes, journal |
| L'ancre d'audit | volume `donnees-app` | sans elle, une restauration ne prouve plus rien |
| Les secrets | gestionnaire de mots de passe | sans le *pepper*, la sauvegarde est inexploitable |

> **Une sauvegarde de la base sans le `APP_PASSWORD_PEPPER` ne permet de
> reconnecter personne.** Les deux vont ensemble.

### Sauvegarde manuelle

```sh
# docker ps --format '{{.Names}}' | grep -i base
# docker exec <conteneur-base> pg_dump -U flotte -d flotte -Fc \
    > /root/sauvegardes/flotte-$(date +%F).dump
# docker cp <conteneur-application>:/app/data/. \
    /root/sauvegardes/flotte-data-$(date +%F)/
```

### Sauvegarde planifiée

Coolify sait sauvegarder une base PostgreSQL : **Databases** → le service
`base` → **Backups**. Une sauvegarde quotidienne, rétention 14 jours, vers
le même stockage externe que samuplus.

### La seule sauvegarde qui compte est celle qu'on a restaurée

Restaurez-en une dans une base jetable, au moins une fois, et notez la
date où vous l'avez fait. Une sauvegarde jamais restaurée est une
hypothèse, pas une sécurité.

```sh
# docker exec -i <conteneur-base> createdb -U flotte flotte_essai
# docker exec -i <conteneur-base> pg_restore -U flotte -d flotte_essai \
    < /root/sauvegardes/flotte-2026-10-04.dump
# docker exec -i <conteneur-base> psql -U flotte -d flotte_essai \
    -c 'SELECT count(*) FROM vehicules;'
# docker exec -i <conteneur-base> dropdb -U flotte flotte_essai
```

---

## 12. Le retour arrière

### Revenir à la version précédente

Coolify garde l'historique des déploiements : **Deployments** → le
déploiement précédent → **Redeploy**.

**Le retour arrière du code est sûr dans ce module.** Le schéma n'est
jamais modifié de façon destructrice : il n'ajoute que des colonnes, des
tables et des index, et ne supprime ni ne renomme rien. Une version
antérieure de l'application retrouve donc une base qu'elle sait lire.

Ce qui ne revient **pas** en arrière : les données saisies entre-temps, et
le journal d'audit. C'est normal et voulu.

### Revenir à une sauvegarde

À ne faire que sur incident grave, et après avoir prévenu les utilisateurs
— tout ce qui a été saisi depuis la sauvegarde sera perdu.

```sh
# docker stop <conteneur-application>
# docker exec -i <conteneur-base> dropdb -U flotte flotte
# docker exec -i <conteneur-base> createdb -U flotte flotte
# docker exec -i <conteneur-base> pg_restore -U flotte -d flotte \
    < /root/sauvegardes/flotte-<date>.dump
# docker start <conteneur-application>
```

Puis, connecté à l'application, **vérifiez l'intégrité du journal**. Si
l'ancre externe ne concorde plus avec la tête de chaîne restaurée, c'est
attendu : la base a reculé, pas le fichier. Notez-le dans le registre
d'exploitation, avec la date et la raison — c'est précisément ce que
l'ancre sert à rendre visible.

---

## 13. Les mises à jour courantes

1. Travaillez sur votre poste, et lancez la suite complète :

   ```sh
   $ npm run verify
   ```

   Elle doit être **entièrement verte**. Pas « verte sauf un test ».

2. Poussez sur `main`.
3. Coolify → **Deploy** (ou laissez le déploiement automatique faire).
4. Surveillez les journaux jusqu'à `Serveur en ecoute`.
5. Repassez, au minimum, le bloc **Les alertes** et le bloc
   **L'historisation** de la recette du §10.

Préférez les déploiements en fin de journée, quand personne ne saisit.

---

## 14. Quand quelque chose ne va pas

### L'application ne démarre pas

Journaux du service `application` :

| Message | Cause | Remède |
|---|---|---|
| `renseignez APP_SECRET` | variable absente | la poser dans Coolify |
| `APP_SECRET et APP_PASSWORD_PEPPER doivent differer` | même valeur collée deux fois | en régénérer une |
| `Base injoignable` pendant 90 s | `base` n'est pas partie | journaux de `base`, souvent un volume aux droits cassés |
| `column … does not exist` | schéma partiellement appliqué | voir ci-dessous |

Le schéma s'applique dans **une seule transaction** : en cas d'échec, rien
n'est appliqué et la base reste dans son état précédent. Il n'y a donc pas
de demi-migration à rattraper — corrigez la cause et redéployez.

### Tout s'affiche mais rien ne s'enregistre

`ALLOWED_ORIGINS` ne correspond pas exactement au domaine servi. Vérifiez
le protocole (`https`), l'absence de barre oblique finale, et l'absence de
`www`. Redéployez après correction.

### L'activité du jour est refusée comme « dans le futur »

Le fuseau du conteneur est faux. Vérifiez :

```sh
# docker exec <conteneur-application> date
```

La réponse doit être l'heure du Maroc. Sinon, posez `TZ=Africa/Casablanca`
dans les variables et redéployez.

> Ce défaut est réel et il a été rencontré : sans `TZ`, le conteneur
> tourne en UTC, et entre minuit et une heure du matin il est déjà demain
> localement et encore aujourd'hui en UTC. L'activité qu'on vient de
> terminer est alors rejetée.

### Les photos sont refusées

Augmentez `UPLOAD_MAX_MB` (plafond 50), et vérifiez que le proxy de
Coolify ne limite pas la taille des corps de requête en amont.

### Les alertes semblent fausses

Avant de suspecter le code, vérifiez dans l'ordre :

1. **Paramètres** : les seuils sont-ils ceux que vous croyez ?
2. Le véhicule a-t-il un relevé de kilométrage récent ? Sans relevé, une
   échéance kilométrique ne peut pas alerter — c'est voulu.
3. L'échéance est-elle close ? Le véhicule est-il archivé ?
4. Le fuseau du conteneur est-il correct ? Une échéance à date se décale
   d'un jour si le serveur n'est pas à l'heure du Maroc.

### Reprendre la main sur les comptes

Tout passe par le script, sur le serveur :

```sh
# docker exec -it <conteneur-application> \
    node scripts/superadmin.js --username direction --reset
```

### Ce qu'il ne faut pas faire

- **Ne modifiez jamais `APP_PASSWORD_PEPPER`** après la mise en service.
- **N'écrivez jamais dans la table `audit_log`** : un déclencheur refuse
  la modification et la suppression, et c'est une protection, pas une
  gêne.
- **Ne déployez pas `docker-compose.yml`** : c'est le fichier du poste de
  développement.
- **Ne publiez pas le port de la base.** Elle n'a aucune raison d'être
  joignable depuis l'extérieur.
- **Ne touchez pas au projet samuplus** pour régler un problème de ce
  module. Ils sont séparés ; ils doivent le rester.
