# syntax=docker/dockerfile:1
#
# Mawdoo3 Visitors API image (contract §3, §15; docs/decisions/phase-9-deploy.md).
#
#   docker build -t vms-backend backend
#
# One image, several commands (docker-compose.yml):
#   default            python -m app.serve             the API: one worker, no uvicorn proxy-header
#                                                      handling (TRUSTED_PROXIES alone decides when
#                                                      X-Forwarded-For is believed), no Server header,
#                                                      the application's own access log
#   migrate (one-shot) python -m alembic upgrade head  as the schema owner (MIGRATION_DATABASE_URL)
#   operations         python -m app.cli prune-sessions | create-admin | mark-no-shows
#
# The process runs as an unprivileged user and writes nothing to the filesystem, so the container can
# run with a read-only root filesystem (production e-mail goes through Resend; the outbox provider is
# refused in production). Configuration comes from the environment only: there is no .env file in the
# image. The base image is pinned by tag and digest (a multi-arch index); update both together.

ARG PYTHON_IMAGE=python:3.14.8-slim-trixie@sha256:3353bb7e9ae99c7cce6cad2b2f2b174e8f22813ac43e3b13e7a742627d2b01d8

# ---- build: the locked dependencies in a virtual environment ------------------------------------------
FROM ${PYTHON_IMAGE} AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore
RUN python -m venv /opt/venv
COPY requirements.txt /tmp/requirements.txt
# The hash-pinned lock (SEC-25): pip refuses every file whose sha256 is not listed, --no-deps installs
# exactly the lock and nothing it does not name, and --only-binary means no package's build code runs
# (every locked package has cp314 / abi3 / pure-Python wheels for linux/amd64 and linux/arm64).
# `pip check` then proves the lock is complete for this platform. pip itself is not shipped.
RUN /opt/venv/bin/python -m pip install --require-hashes --no-deps --only-binary=:all: \
        -r /tmp/requirements.txt \
    && /opt/venv/bin/python -m pip check \
    && /opt/venv/bin/python -m pip uninstall --yes pip

# ---- runtime -----------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Mawdoo3 Visitors API" \
      org.opencontainers.image.description="Mawdoo3 Visitors API (FastAPI, uvicorn, one worker)"

ARG VMS_UID=10001
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8000

# No package manager for Python at run time; an unprivileged user without a home or shell.
RUN python -m pip uninstall --yes --root-user-action=ignore pip \
    && groupadd --system --gid "${VMS_UID}" vms \
    && useradd --system --uid "${VMS_UID}" --gid vms --home-dir /nonexistent --no-create-home \
        --shell /usr/sbin/nologin vms

COPY --from=build /opt/venv /opt/venv
WORKDIR /app
# Root-owned and read-only for the service user. The bytecode is compiled here, so nothing is written
# at run time (PYTHONDONTWRITEBYTECODE also stops any attempt).
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
RUN python -m compileall -q -j 0 app alembic

USER ${VMS_UID}:${VMS_UID}
EXPOSE 8000

# GET /api/v1/health: 200 when the API and its database answer, 503 otherwise. No proxy is used for the
# loopback call even when HTTP(S)_PROXY is set for outgoing e-mail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request as r; r.build_opener(r.ProxyHandler({})).open('http://127.0.0.1:%s/api/v1/health' % os.environ.get('SERVER_PORT', '8000'), timeout=4)"]

# Host and port come from SERVER_HOST/SERVER_PORT (0.0.0.0:8000 here); everything else from the
# environment (deploy/env/backend.env.example). Single worker: the rate limiter is in memory.
CMD ["python", "-m", "app.serve"]
