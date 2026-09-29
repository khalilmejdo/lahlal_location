# =====================================================================
#  Lahlal — gestion de flotte : image de production
#
#  Construction en deux etapes : les outils d'installation ne se
#  retrouvent pas dans l'image finale, qui ne contient que le strict
#  necessaire a l'execution.
#
#  L'application tourne sous un compte non privilegie : une faille
#  applicative ne donnerait pas les droits root dans le conteneur.
# =====================================================================

# ---------- Etape 1 : dependances ------------------------------------
FROM node:24-alpine AS dependances

WORKDIR /app

# Copiees seules d'abord : tant que ces deux fichiers ne changent pas,
# Docker reutilise la couche et l'installation n'est pas rejouee.
COPY package.json package-lock.json* ./

# `pg` est du JavaScript pur : aucun outil de compilation n'est requis.
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Etape 2 : image finale -----------------------------------
FROM node:24-alpine AS production

# tini assure la reaction aux signaux et la recuperation des processus
# orphelins lorsque Node est le processus numero 1 du conteneur.
#
# Ni poppler ni aucun outil de rendu : ce module ne convertit pas de PDF.
# L'etat imprimable d'un vehicule est du HTML que le navigateur enregistre
# en PDF (server/routes/exports.js) — un moteur de rendu de plus dans
# l'image ne servirait a rien.
# tzdata : sans elle, Alpine ne connait aucun fuseau nomme, et TZ reste
# sans effet — le conteneur repart en UTC sans le dire.
RUN apk add --no-cache tini tzdata

# Empreinte du commit construit. Coolify la fournit en argument de build ;
# sans elle, rien ne distingue une image deployee d'une image restee en
# arriere, et l'on cherche le defaut dans le code plutot que dans la
# chaine de livraison.
ARG SOURCE_COMMIT=""

# TZ : les dates de ce module sont des dates CALENDAIRES. Sans lui, le
# conteneur tourne en UTC et, au Maroc, l'activite saisie apres minuit est
# refusee comme etant dans le futur. Il se surcharge au deploiement.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TZ=Africa/Casablanca \
    SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /app

COPY --from=dependances /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Dossier de travail : il porte l'ancre externe du journal d'audit.
#
# IL DOIT ETRE MONTE EN VOLUME. Sur un systeme de fichiers ephemere,
# l'ancre disparait a chaque redemarrage et ne prouve plus rien — c'est
# precisement ce qu'elle sert a eviter. Les pieces jointes, elles, vivent
# en base et ne dependent pas de ce dossier.
RUN mkdir -p /app/data \
 && chown -R node:node /app/data

# Aucune raison d'ecrire ailleurs que dans /app/data : le reste de
# l'arborescence appartient a root et reste en lecture seule pour l'app.
USER node

EXPOSE 3000

# Sonde interne, doublee par celle de l'orchestrateur.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/demarrer.js"]
