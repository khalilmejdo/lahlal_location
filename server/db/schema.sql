-- =====================================================================
--  Lahlal — Gestion de flotte
--  Schema PostgreSQL. Idempotent : ce fichier se rejoue sans dommage.
-- =====================================================================
--
--  Il se lit en quatre parties :
--
--    1. Securite      : roles, permissions, comptes, sessions
--    2. Tracabilite   : journal d'audit chaine
--    3. Referentiels  : parametres reglables et types
--    4. La flotte     : vehicules, activites, entretiens, pieces jointes
--
--  Deux partis pris traversent tout le fichier.
--
--  LES MONTANTS SONT DES ENTIERS DE CENTIMES. Jamais de NUMERIC ni de
--  flottant : le resultat affiche — recette moins depense — doit tomber au
--  centime quel que soit le nombre de lignes additionnees.
--
--  AUCUNE NOTION FISCALE. Pas de TVA, pas de taux, pas de numero de piece
--  comptable. Le cahier des charges (§7) est explicite : ces montants sont
--  des depenses reellement engagees et des recettes reellement percues, et
--  rien dans le schema ne doit leur donner l'apparence d'une comptabilite
--  officielle.

-- Aucune extension n'est requise pour demarrer : les identifiants sont des
-- UUID v7 produits par l'application (server/core/crypto.js), pas par la
-- base. pg_trgm est demande plus bas, mais son absence n'empeche rien.

CREATE TABLE IF NOT EXISTS app_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
--  1. Securite : roles, permissions, utilisateurs, sessions
-- ---------------------------------------------------------------------
--
--  Repris tel quel de lahlal_samuplus : le modele a deja servi, il est
--  eprouve, et le reecrire n'aurait rien apporte.

CREATE TABLE IF NOT EXISTS roles (
  id           UUID PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  is_system    BOOLEAN NOT NULL DEFAULT FALSE,   -- role non supprimable
  -- Hierarchie : plus le rang est petit, plus le role est puissant. Les
  -- permissions disent ce qu'on peut faire ; le rang dit sur qui. Un
  -- administrateur (rang 10) n'agit pas sur un super-administrateur (rang 0).
  rank         INTEGER NOT NULL DEFAULT 100,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_customized BOOLEAN NOT NULL DEFAULT FALSE,  -- droits redefinis a l'ecran
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  code          TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  category      TEXT NOT NULL,
  is_sensitive  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id          UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY,
  username             TEXT NOT NULL,
  username_lower       TEXT NOT NULL UNIQUE,       -- unicite insensible a la casse
  email                TEXT,
  email_lower          TEXT UNIQUE,
  full_name            TEXT NOT NULL,
  phone                TEXT,
  password_hash        TEXT NOT NULL,
  password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  role_id              UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  last_login_ip        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active;

-- Exceptions propres a un compte, au-dessus de son role.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL,
  effect          TEXT NOT NULL CHECK (effect IN ('GRANT','DENY')),
  reason          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_permission_overrides
  ON user_permission_overrides(user_id, permission_code);

-- Le jeton de session n'est jamais stocke en clair : seul son condensat l'est.
-- Un vol de la base ne permet donc pas de rejouer une session.
CREATE TABLE IF NOT EXISTS sessions (
  id             UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  csrf_secret    TEXT NOT NULL,
  ip             TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT,
  ip          TEXT,
  success     BOOLEAN NOT NULL,
  reason      TEXT,
  user_agent  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_at ON login_attempts(at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, at DESC);

-- ---------------------------------------------------------------------
--  2. Tracabilite
-- ---------------------------------------------------------------------
--
--  Journal chaine : hash = SHA-256(prev_hash || contenu de l'entree).
--  Toute entree supprimee ou modifiee rompt la chaine, ce qui est detectable.
--  C'est ce qui permet de repondre a « qui a change ce kilometrage, quand,
--  et pourquoi ? » meme face a quelqu'un ayant un acces direct a la base.

CREATE TABLE IF NOT EXISTS audit_log (
  seq          BIGSERIAL PRIMARY KEY,
  id           UUID NOT NULL UNIQUE,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  username     TEXT,
  ip           TEXT,
  action       TEXT NOT NULL,          -- ex. activite.create
  entity       TEXT,                   -- ex. activite
  entity_id    UUID,
  entity_label TEXT,                   -- ex. « Remorquage Cannes -> Nice »
  summary      TEXT NOT NULL,
  changes      JSONB,                  -- diff champ par champ
  severity     TEXT NOT NULL DEFAULT 'info'
               CHECK (severity IN ('info','notice','warning','critical')),
  prev_hash    TEXT,
  hash         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);

-- Un journal qui se modifie n'est pas un journal.
CREATE OR REPLACE FUNCTION audit_log_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Le journal d audit ne se modifie pas.' USING ERRCODE = 'LF001';
END $$;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immuable();

-- ---------------------------------------------------------------------
--  3. Referentiels reglables
-- ---------------------------------------------------------------------

-- Parametres cle/valeur. Y vivent les seuils d'alerte (§15) et la posture de
-- securite. Regle 17 du cahier des charges : ce qui doit etre configurable ne
-- se code pas en dur.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  label       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Les types d'activite ET les types d'entretien, dans une seule table.
--
-- Deux tables auraient impose deux ecrans, deux routes et deux jeux de tests
-- pour la meme chose : un code, un libelle, un ordre, un interrupteur. La
-- colonne `domaine` suffit a les distinguer, et un type livre en standard
-- (is_system) ne se supprime pas — il se desactive, sinon l'historique qui
-- s'y rattache perdrait son libelle.
CREATE TABLE IF NOT EXISTS types (
  domaine     TEXT NOT NULL CHECK (domaine IN ('ACTIVITE','ENTRETIEN')),
  code        TEXT NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  libelle     TEXT NOT NULL CHECK (length(btrim(libelle)) BETWEEN 1 AND 60),
  -- Oriente le formulaire mobile : un type DEPENSE ouvre le clavier sur le
  -- champ depense, un type RECETTE sur la recette. Cela ne contraint RIEN —
  -- une location peut couter (le carburant) autant qu'elle rapporte.
  sens        TEXT NOT NULL DEFAULT 'MIXTE' CHECK (sens IN ('DEPENSE','RECETTE','MIXTE')),
  actif       BOOLEAN NOT NULL DEFAULT TRUE,
  ordre       INTEGER NOT NULL DEFAULT 100,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (domaine, code)
);

CREATE INDEX IF NOT EXISTS idx_types_actifs ON types(domaine, ordre) WHERE actif;

-- ---------------------------------------------------------------------
--  4. La flotte
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vehicules (
  id                    UUID PRIMARY KEY,
  immatriculation       TEXT NOT NULL CHECK (length(btrim(immatriculation)) BETWEEN 2 AND 20),
  -- Sans espace ni tiret : c'est elle qui porte l'unicite. « 1234-A-56 » et
  -- « 1234 A 56 » sont le meme vehicule.
  immatriculation_norm  TEXT NOT NULL UNIQUE,
  libelle               TEXT CHECK (libelle IS NULL OR length(btrim(libelle)) BETWEEN 1 AND 60),
  marque                TEXT,
  modele                TEXT,
  annee                 INTEGER CHECK (annee IS NULL OR annee BETWEEN 1950 AND 2100),

  -- LE KILOMETRAGE N'EST PAS STOCKE ICI, ET C'EST VOLONTAIRE.
  --
  -- Cette colonne porte le releve du compteur AU MOMENT OU LE VEHICULE A ETE
  -- AJOUTE, rien de plus. Le kilometrage courant se lit dans la vue
  -- v_vehicules : c'est le plus grand entre ce releve initial et le plus haut
  -- kilometrage des activites vivantes du vehicule.
  --
  -- Le cahier des charges (§28) demande de « recalculer le kilometrage
  -- actuel » apres modification d'une activite. Une colonne denormalisee
  -- l'aurait impose a chaque ecriture, a chaque suppression, a chaque
  -- restauration depuis la corbeille — et une seule de ces voies oubliee
  -- aurait laisse un vehicule afficher un kilometrage que plus aucune
  -- activite ne justifie. Deduit, il ne peut pas deriver : corriger la
  -- saisie fautive corrige l'affichage, sans une ligne de code de reprise.
  kilometrage_initial   INTEGER NOT NULL DEFAULT 0
                        CHECK (kilometrage_initial BETWEEN 0 AND 3000000),

  statut                TEXT NOT NULL DEFAULT 'DISPONIBLE'
                        CHECK (statut IN ('DISPONIBLE','EN_SERVICE','MAINTENANCE','IMMOBILISE','VENDU')),
  photo_id              UUID,   -- FK posee plus bas : fichiers reference vehicules
  notes                 TEXT,

  -- Archivage plutot que suppression (§29) : un vehicule porte tout son
  -- historique d'activites et d'entretiens.
  archived_at           TIMESTAMPTZ,
  archived_by           UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicules_actifs ON vehicules(immatriculation_norm)
  WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------
--  L'activite : le geste central de l'application
-- ---------------------------------------------------------------------
--
--  Une ligne = une chose faite avec un vehicule, un jour donne, avec ce
--  qu'elle a coute et ce qu'elle a rapporte. C'est le seul endroit ou entrent
--  des montants, et la seule source du kilometrage.

CREATE TABLE IF NOT EXISTS activites (
  id              UUID PRIMARY KEY,
  vehicule_id     UUID NOT NULL REFERENCES vehicules(id) ON DELETE RESTRICT,
  date_activite   DATE NOT NULL,
  type_code       TEXT NOT NULL,
  prestation      TEXT NOT NULL CHECK (length(btrim(prestation)) BETWEEN 1 AND 200),

  -- Facultatif : une prime d'assurance reglee au bureau n'a pas de
  -- kilometrage, et en inventer un fausserait le compteur du vehicule.
  kilometrage     INTEGER CHECK (kilometrage IS NULL OR kilometrage BETWEEN 0 AND 3000000),
  -- Le kilometrage saisi etait en recul sur le dernier releve connu, et
  -- quelqu'un l'a confirme (§4). La colonne existe pour que la fiche puisse
  -- le signaler ensuite : une valeur forcee reste une valeur a verifier.
  kilometrage_force BOOLEAN NOT NULL DEFAULT FALSE,

  depense_cents   BIGINT NOT NULL DEFAULT 0
                  CHECK (depense_cents >= 0 AND depense_cents <= 1000000000),
  recette_cents   BIGINT NOT NULL DEFAULT 0
                  CHECK (recette_cents >= 0 AND recette_cents <= 1000000000),
  -- Le resultat est calcule par la base, pas par l'application.
  --
  -- Trois endroits l'affichent — la fiche, le tableau de bord, l'export — et
  -- trois soustractions ecrites a trois endroits finissent par diverger le
  -- jour ou l'une oublie un signe. Ici il n'y en a qu'une.
  resultat_cents  BIGINT GENERATED ALWAYS AS (recette_cents - depense_cents) STORED,

  notes           TEXT,

  -- Renseigne quand l'activite est nee de la cloture d'un entretien (§34) :
  -- c'est ce lien qui fait que « Vidange faite a 150 200 km, 180 DH » apparait
  -- a la fois dans l'historique du vehicule et dans celui de l'entretien,
  -- sans etre saisi deux fois.
  entretien_id    UUID,

  -- Une saisie faite au telephone, dans une zone mal couverte, peut partir
  -- deux fois : l'application n'a pas recu la reponse, l'utilisateur
  -- retouche le bouton. La cle rend le second envoi inoffensif.
  idempotency_key TEXT,

  -- Corbeille plutot que suppression seche (§29).
  deleted_at      TIMESTAMPTZ,
  deleted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  delete_reason   TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,

  -- La cle du referentiel `types` est (domaine, code). Le domaine d'une
  -- activite vaut toujours 'ACTIVITE' : la colonne le materialise pour que
  -- la cle etrangere composite tienne, son defaut evite de l'ecrire, et sa
  -- contrainte interdit d'y mettre autre chose. Une activite ne peut donc
  -- pas pointer vers un type d'entretien.
  type_domaine    TEXT NOT NULL DEFAULT 'ACTIVITE' CHECK (type_domaine = 'ACTIVITE')
);

-- Index de filtrage demandes au §32.
CREATE INDEX IF NOT EXISTS idx_activites_vehicule_date
  ON activites(vehicule_id, date_activite DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activites_date
  ON activites(date_activite DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activites_type
  ON activites(type_code, date_activite DESC) WHERE deleted_at IS NULL;
-- Sert au calcul du kilometrage courant : MAX par vehicule, en une lecture
-- d'index, sans toucher la table.
CREATE INDEX IF NOT EXISTS idx_activites_kilometrage
  ON activites(vehicule_id, kilometrage DESC)
  WHERE deleted_at IS NULL AND kilometrage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activites_entretien
  ON activites(entretien_id) WHERE entretien_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_activites_idempotency
  ON activites(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- La recherche textuelle (§39) : prestation et notes.
--
-- Elle se fait en ILIKE '%...%', motif non ancre, auquel aucun index btree ne
-- repond : le plan est un Seq Scan. pg_trgm indexe les trigrammes et y
-- repond ; c'est une extension livree avec PostgreSQL (contrib).
--
-- Le bloc est garde, comme dans lahlal_samuplus : sur une base ou le role n'a
-- pas le droit de creer une extension, la migration continue et la recherche
-- garde son comportement d'avant. Elle est alors lente, jamais fausse.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm indisponible (%) : la recherche d activite reste sans index.', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_activites_rech_prestation
      ON activites USING gin (prestation gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_activites_rech_notes
      ON activites USING gin (notes gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_vehicules_rech_immat
      ON vehicules USING gin (immatriculation gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_vehicules_rech_libelle
      ON vehicules USING gin (libelle gin_trgm_ops);
  END IF;
END $$;

-- ---------------------------------------------------------------------
--  Entretiens et echeances
-- ---------------------------------------------------------------------
--
--  UNE SEULE TABLE POUR LES DEUX, et c'est le point de conception du module.
--
--  Le cahier des charges parle d'« entretiens » (§10) et d'« echeances
--  administratives » (§3) comme de deux choses. Du point de vue du calcul,
--  elles n'en font qu'une : quelque chose a refaire, echu a un kilometrage,
--  a une date, ou aux deux (§9). Une vidange n'a qu'un kilometrage, une
--  assurance n'a qu'une date, une revision a les deux — c'est la meme ligne
--  avec des colonnes laissees vides, pas trois tables.
--
--  Le compte a rebours (§14) et les quatre niveaux d'alerte (§15) se
--  calculent donc une fois, pour tout le monde.

CREATE TABLE IF NOT EXISTS entretiens (
  id               UUID PRIMARY KEY,
  vehicule_id      UUID NOT NULL REFERENCES vehicules(id) ON DELETE RESTRICT,
  type_code        TEXT NOT NULL,
  libelle          TEXT NOT NULL CHECK (length(btrim(libelle)) BETWEEN 1 AND 120),

  -- La derniere realisation.
  derniere_date    DATE,
  dernier_km       INTEGER CHECK (dernier_km IS NULL OR dernier_km BETWEEN 0 AND 3000000),

  -- Les intervalles, facultatifs. Ils servent a PROPOSER la prochaine
  -- echeance, jamais a l'imposer : §11 et §12 sont formels, une echeance
  -- saisie a la main doit etre respectee telle quelle.
  intervalle_km    INTEGER CHECK (intervalle_km IS NULL OR intervalle_km BETWEEN 100 AND 500000),
  intervalle_mois  INTEGER CHECK (intervalle_mois IS NULL OR intervalle_mois BETWEEN 1 AND 240),

  -- Les prochaines echeances, telles qu'elles s'appliquent. Que l'utilisateur
  -- les ait laissees se calculer ou qu'il les ait ecrites lui-meme, ce sont
  -- ces deux colonnes qui font foi, et elles seules.
  prochain_km      INTEGER CHECK (prochain_km IS NULL OR prochain_km BETWEEN 0 AND 3000000),
  prochaine_date   DATE,

  -- CLOS : l'echeance ne se reconduit pas (un vehicule vendu, un controle
  -- qui ne s'applique plus). Elle sort des alertes sans sortir de l'historique.
  statut           TEXT NOT NULL DEFAULT 'ACTIF' CHECK (statut IN ('ACTIF','CLOS')),
  notes            TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Une echeance qui ne dit ni quand ni a quel kilometrage ne surveille rien.
  -- La refuser a l'ecriture vaut mieux que l'afficher en permanence comme
  -- « sans echeance » dans une liste faite pour montrer ce qui approche.
  CONSTRAINT entretien_a_une_echeance
    CHECK (statut = 'CLOS' OR prochain_km IS NOT NULL OR prochaine_date IS NOT NULL),

  -- Meme raison que pour les activites : la cle du referentiel est composite.
  type_domaine     TEXT NOT NULL DEFAULT 'ENTRETIEN' CHECK (type_domaine = 'ENTRETIEN')
);

CREATE INDEX IF NOT EXISTS idx_entretiens_vehicule ON entretiens(vehicule_id, statut);
CREATE INDEX IF NOT EXISTS idx_entretiens_date     ON entretiens(prochaine_date)
  WHERE statut = 'ACTIF' AND prochaine_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entretiens_km       ON entretiens(vehicule_id, prochain_km)
  WHERE statut = 'ACTIF' AND prochain_km IS NOT NULL;

-- Le lien activite -> entretien, pose maintenant que les deux tables existent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activites_entretien_fk'
  ) THEN
    ALTER TABLE activites ADD CONSTRAINT activites_entretien_fk
      FOREIGN KEY (entretien_id) REFERENCES entretiens(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activites_type_fk'
  ) THEN
    ALTER TABLE activites ADD CONSTRAINT activites_type_fk
      FOREIGN KEY (type_domaine, type_code) REFERENCES types(domaine, code);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entretiens_type_fk'
  ) THEN
    ALTER TABLE entretiens ADD CONSTRAINT entretiens_type_fk
      FOREIGN KEY (type_domaine, type_code) REFERENCES types(domaine, code);
  END IF;
END $$;

-- ---------------------------------------------------------------------
--  Pieces jointes
-- ---------------------------------------------------------------------
--
--  Le contenu est stocke EN BASE, pas sur le disque. La raison est la meme
--  que dans lahlal_samuplus : un conteneur qui redemarre repart d'un systeme
--  de fichiers vide, et une photo de facture perdue ne se retrouve pas. La
--  sauvegarde de la base emporte alors les pieces avec elle.
--
--  Le type reel est determine par les octets d'en-tete du fichier, jamais par
--  son extension ni par le Content-Type annonce (server/domain/fichiers.js).

CREATE TABLE IF NOT EXISTS fichiers (
  id           UUID PRIMARY KEY,
  entity       TEXT NOT NULL CHECK (entity IN ('vehicule','activite','entretien')),
  entity_id    UUID NOT NULL,
  nom_origine  TEXT NOT NULL,
  mime         TEXT NOT NULL
               CHECK (mime IN ('image/jpeg','image/png','image/webp','image/heic','application/pdf')),
  taille       INTEGER NOT NULL CHECK (taille > 0),
  sha256       TEXT NOT NULL,
  contenu      BYTEA NOT NULL,
  ordre        INTEGER NOT NULL DEFAULT 0,

  -- Corbeille, comme pour les activites.
  --
  -- La suppression etait SECHE : le binaire disparaissait, et une photo de
  -- compteur effacee par erreur ne se retrouvait pas. C'etait le dernier
  -- geste irreversible du module, et il n'avait aucune raison de l'etre :
  -- une piece jointe pese quelques centaines de kilo-octets, la garder
  -- quelques mois ne coute rien au regard de ce que coute sa perte.
  --
  -- Seul le super-administrateur peut restaurer (« attachment.restore ») :
  -- un filet que tout le monde peut relever n'en est plus un.
  deleted_at   TIMESTAMPTZ,
  deleted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  delete_reason TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT
);

-- Les colonnes AVANT l'index qui les reference.
--
-- « CREATE TABLE IF NOT EXISTS » ne touche pas une table deja creee : sur
-- une base en service, les trois colonnes ci-dessus n'existent pas encore,
-- et un index partiel pose avant elles echoue sur « column deleted_at does
-- not exist ». La migration entiere est alors annulee — elle tourne dans
-- une seule transaction — et le conteneur refuse de demarrer.
--
-- Constate en rejouant le schema sur la base de developpement, le
-- 4 octobre 2026. L'ordre n'est donc pas une question de style.
ALTER TABLE fichiers ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ;
ALTER TABLE fichiers ADD COLUMN IF NOT EXISTS deleted_by    UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE fichiers ADD COLUMN IF NOT EXISTS delete_reason TEXT;

-- L'ancien index, sans la clause partielle : il porte le meme nom et
-- « IF NOT EXISTS » ne le remplacerait pas. On le retire pour que celui
-- d'en dessous soit bien celui qui s'applique.
DROP INDEX IF EXISTS idx_fichiers_entity;

-- Index partiel : la corbeille ne pese pas sur la lecture courante.
CREATE INDEX IF NOT EXISTS idx_fichiers_entity ON fichiers(entity, entity_id, ordre, created_at)
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vehicules_photo_fk'
  ) THEN
    ALTER TABLE vehicules ADD CONSTRAINT vehicules_photo_fk
      FOREIGN KEY (photo_id) REFERENCES fichiers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------
--  5. Vues
-- ---------------------------------------------------------------------

-- Le kilometrage courant d'un vehicule, defini UNE fois.
--
-- Tout ce qui affiche un kilometrage passe par ici : la liste, la fiche, le
-- calcul des echeances kilometriques, le tableau de bord. Ainsi la valeur
-- montree et la valeur comparee a `prochain_km` sont necessairement la meme.
CREATE OR REPLACE VIEW v_vehicules AS
SELECT
  v.*,
  GREATEST(
    v.kilometrage_initial,
    COALESCE(
      (SELECT MAX(a.kilometrage) FROM activites a
        WHERE a.vehicule_id = v.id AND a.deleted_at IS NULL AND a.kilometrage IS NOT NULL),
      0
    )
  )::int AS kilometrage,
  (SELECT MAX(a.date_activite) FROM activites a
    WHERE a.vehicule_id = v.id AND a.deleted_at IS NULL) AS derniere_activite_le
FROM vehicules v;
