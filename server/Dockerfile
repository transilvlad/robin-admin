FROM node:26.12.1-bookworm-slim AS builder

WORKDIR /app
ENV npm_config_update_notifier=false
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_retry_mintimeout=20000
ENV npm_config_fetch_retry_maxtimeout=120000

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:26.12.1-alpine3.23@sha256:bc2b334006f15c7167bbeb2f08f28c2df883f7594a0470e04454ebe7560cfe68 AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26.12.1-alpine3.23@sha256:bc2b334006f15c7167bbeb2f08f28c2df883f7594a0470e04454ebe7560cfe68 AS runtime

# Patch Alpine OS packages so the release Trivy gate passes.
RUN apk upgrade --no-cache \
    && apk add --no-cache "libexpat>=2.9.0-r0" \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
ENV NODE_ENV=production

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --from=builder --chown=node:node /app/dist ./dist
RUN mkdir /app/logs /app/module-identity && chown node:node /app/logs /app/module-identity

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ARG ROBIN_ADMIN_RELEASE=dev
ENV ROBIN_ADMIN_RELEASE=$ROBIN_ADMIN_RELEASE
CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
