FROM node:26.11.1-bookworm-slim AS builder

WORKDIR /app

# Built once with a placeholder base path; the runtime image rewrites it from
# BASE_PATH at start, so one image serves `/` and any prefix such as `/admin/`.
ENV VITE_BASE_PATH=/__ROBIN_ADMIN_BASE__/
ENV npm_config_update_notifier=false
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_retry_mintimeout=20000
ENV npm_config_fetch_retry_maxtimeout=120000

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:1.31.6-alpine AS runtime

# Patch Alpine OS packages (openssl et al.) so the release Trivy gate passes.
RUN apk upgrade --no-cache && apk add --no-cache 'pcre2>=10.49-r0'
RUN sed -Ei 's|pid[[:space:]]+/run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf

ENV BASE_PATH=/

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 docker-entrypoint.d/10-base-path.sh /docker-entrypoint.d/10-base-path.sh
COPY --chmod=0755 docker-entrypoint.d/20-security-policy.sh /docker-entrypoint.d/20-security-policy.sh
COPY --from=builder --chown=nginx:nginx /app/dist /usr/share/robin-admin

USER nginx

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
