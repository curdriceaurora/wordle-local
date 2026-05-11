# Pinned to a digest so the build is reproducible and supply-chain-
# safe. To refresh: query `https://hub.docker.com/v2/repositories/
# library/node/tags/20-alpine/` for the current `digest`, paste here,
# and update the comment date. Pin refresh cadence documented in
# CONTRIBUTING.md.
# node:20-alpine — digest fetched 2026-04-15
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY scripts ./scripts

RUN npm run build

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app
RUN chown -R node:node /app

USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node --from=build /app/public/dist ./public/dist
COPY --chown=node:node data ./data
COPY --chown=node:node lib ./lib
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node LICENSE ./LICENSE
COPY --chown=node:node THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --chown=node:node data/dictionaries/README.md ./data/dictionaries/README.md

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
