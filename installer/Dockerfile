FROM node:26.12.1-alpine AS runtime
# Patch Alpine OS packages so the release Trivy gate passes. npm is not used at
# runtime; removing it drops its bundled dependencies from the image.
RUN apk upgrade --no-cache && apk add --no-cache docker-cli \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY src ./src
COPY package.json ./package.json
USER root
CMD ["node", "src/container.js"]
