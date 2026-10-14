# syntax=docker/dockerfile:1
#
# Mawdoo3 Visitors web application: the React SPA built with Node 24, served by unprivileged nginx
# with the contract's security headers, caching rules, SPA fallback and the /api reverse proxy
# (contract §10, §15; docs/decisions/phase-9-deploy.md).
#
# The build context is this directory; two small named contexts supply files that live elsewhere in the
# repository (docker-compose.yml passes them as additional_contexts):
#   vms_contract  docs/contract   (the shared pass-token vectors a type-checked test imports)
#   vms_nginx     deploy/nginx    (nginx.conf, the server template, snippets, the startup check)
#
#   docker build -t vms-frontend \
#     --build-context vms_contract=docs/contract --build-context vms_nginx=deploy/nginx frontend
#
# Run time: VMS_SERVER_NAME (required); host:port of the three API services, VMS_API_UPSTREAM (default
# backend:8000), VMS_API_RECEPTION_UPSTREAM (backend-reception:8000, one address per replica) and
# VMS_API_REPORTS_UPSTREAM (backend-reports:8000); and the TLS certificate chain and key mounted read-only at
# /etc/nginx/tls/tls.crt and tls.key. Listens on 8080 (redirect to HTTPS, health check) and 8443
# (HTTPS). Base images are pinned by tag and digest (multi-arch indexes); update tag and digest together.

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.5-alpine3.24-slim@sha256:3af0c10d960cc2502427fe1219c52989d309e7d65596869c60a34fd2fa2406f0

# ---- build: npm ci from the lock file, type-check and bundle (`npm run build`) ------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /src/frontend
# The build runs as the image's unprivileged `node` user (uid 1000).
RUN chown 1000:1000 /src/frontend
USER 1000:1000
COPY --chown=1000:1000 package.json package-lock.json ./
# Exactly the lock file's versions and integrity hashes. No install scripts run: none of the locked
# packages needs one on Linux (only the macOS-only fsevents declares one).
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    npm ci --ignore-scripts
# parsePassToken.test.ts imports ../../../docs/contract/pass-token-vectors.json, and `tsc -b`
# type-checks the tests too: keep the repository layout. (vms_contract and vms_nginx are named build
# contexts, not stages: hadolint's DL3022 does not know them.)
# hadolint ignore=DL3022
COPY --from=vms_contract --chown=1000:1000 pass-token-vectors.json /src/docs/contract/pass-token-vectors.json
COPY --chown=1000:1000 . .
# The guards fail the build when an expected file is missing or a source map would be shipped.
RUN npm run build \
    && test -f dist/index.html \
    && test -f dist/sw.js \
    && test -f dist/appearance.js \
    && test -f dist/sw-precache-manifest.js \
    && test -n "$(find dist/assets -name '*.wasm' -print -quit)" \
    && test -z "$(find dist -name '*.map' -print -quit)"

# ---- runtime: nginx (uid 101) serving dist ---------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Mawdoo3 Visitors web" \
      org.opencontainers.image.description="Mawdoo3 Visitors web application (nginx, unprivileged)"

# Only VMS_* and the resolver list are substituted into the template: every other $name in it is an
# nginx variable. The resolver list comes from /etc/resolv.conf (Docker's embedded DNS).
ENV NGINX_ENVSUBST_FILTER="^(VMS_|NGINX_LOCAL_RESOLVERS$)" \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    VMS_API_UPSTREAM=backend:8000 \
    VMS_API_RECEPTION_UPSTREAM=backend-reception:8000 \
    VMS_API_REPORTS_UPSTREAM=backend-reports:8000

USER 0:0
# The stock site and pages go; configuration and content are root-owned and read-only for nginx.
# /etc/nginx/conf.d stays writable for the entrypoint's template rendering (a tmpfs when the root
# filesystem is read-only).
RUN rm -f /etc/nginx/conf.d/default.conf \
    && rm -rf /usr/share/nginx/html/* \
    && mkdir -p /etc/nginx/templates /etc/nginx/snippets /etc/nginx/tls
# hadolint ignore=DL3022
COPY --from=vms_nginx --chown=0:0 --chmod=0644 nginx.conf /etc/nginx/nginx.conf
# hadolint ignore=DL3022
COPY --from=vms_nginx --chown=0:0 --chmod=0644 snippets/ /etc/nginx/snippets/
# hadolint ignore=DL3022
COPY --from=vms_nginx --chown=0:0 --chmod=0644 templates/vms.conf.template /etc/nginx/templates/vms.conf.template
# hadolint ignore=DL3022
COPY --from=vms_nginx --chown=0:0 --chmod=0755 docker-entrypoint.d/25-vms-check-config.sh /docker-entrypoint.d/25-vms-check-config.sh
COPY --from=build --chown=0:0 /src/frontend/dist/ /usr/share/nginx/html/
RUN find /usr/share/nginx/html /etc/nginx/snippets /etc/nginx/templates -type d -exec chmod 0755 {} + \
    && find /usr/share/nginx/html -type f -exec chmod 0644 {} +
# The base image's nginx user.
USER 101:101

EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
# ENTRYPOINT (/docker-entrypoint.sh), CMD (nginx -g 'daemon off;') and STOPSIGNAL (SIGQUIT, graceful)
# are the base image's.
