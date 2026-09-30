# meerpad: convenience targets.
#
# `make up` runs the whole stack in Docker: Postgres and the server. `make dev`
# runs the server natively instead, with --reload, against the same Postgres;
# that is the faster loop for working on it. meerpic's Makefile, trimmed to
# what a single server needs.

COMPOSE ?= docker compose
VENV    ?= .venv
PY      := $(VENV)/bin/python
PIP     := $(VENV)/bin/pip
VERSION := $(shell cat VERSION)

# The ports docker-compose.yml publishes. Read from the environment (or the
# command line) so `MEERPAD_PORT=9000 make up` and `make dev` agree.
MEERPAD_PORT    ?= 8050
MEERPAD_DB_PORT ?= 5435

.PHONY: help config up down logs build infra psql dev venv test-db test lint \
        desktop images import

help:
	@echo "meerpad $(VERSION):"
	@echo "  make up         - build + run the stack (postgres + server) -> http://127.0.0.1:$(MEERPAD_PORT)"
	@echo "  make down       - stop it"
	@echo "  make logs       - tail the server (sign-in links land here when SMTP_HOST is empty)"
	@echo "  make psql       - a shell on the database"
	@echo "  make desktop    - run the Electron app against the local server"
	@echo "  make import     - import a Notion export: SRC=export.zip WORKSPACE=Farm MEERPAD_TOKEN=..."
	@echo "  make infra      - run only postgres (for native development)"
	@echo "  make dev        - run the server natively with --reload on :$(MEERPAD_PORT) (needs venv; stop 'make up' first)"
	@echo "  make venv       - create $(VENV) with the server's dependencies, pytest and ruff"
	@echo "  make test       - run the test suite (make test-db first)"
	@echo "  make lint       - ruff over app, tests and tools"
	@echo "  make images     - build meerpad-server:$(VERSION)"

# .env is made here from the example the first time, so the stack starts with
# the same values `make dev` reads. Nothing in it is required on a laptop.
config:
	@test -f .env || { cp .env.example .env && chmod 600 .env \
	  && echo "wrote .env from .env.example; SMTP and the rest are optional on a laptop"; }

up: config
	MEERPAD_VERSION=$(VERSION) $(COMPOSE) up --build -d
	@echo "meerpad on http://127.0.0.1:$(MEERPAD_PORT)"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f web

build:
	MEERPAD_VERSION=$(VERSION) $(COMPOSE) build

# --wait: until the healthcheck passes, so a `test-db` or `dev` straight after
# does not race a database that is still initialising.
infra:
	$(COMPOSE) up -d --wait db

psql:
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-meerpad} -d $${POSTGRES_DB:-meerpad}

desktop:
	# Unset because a terminal inside an Electron app (VS Code) can export it,
	# and it makes Electron start as plain Node. The shell defaults to the
	# hosted https://meerpad.com; from a checkout it means this one.
	cd electron && npm install && env -u ELECTRON_RUN_AS_NODE \
	  MEERPAD_URL=$${MEERPAD_URL:-http://localhost:$(MEERPAD_PORT)} npm start

# --- native development ------------------------------------------------------

venv:
	python3 -m venv $(VENV)
	$(PIP) install -q -r requirements.txt pytest httpx ruff
	@echo "ready: $(VENV)"

# On 8050, like the stack, because that is app/config.py's default BASE_URL:
# the login links it prints then open this server. It reads .env from here,
# whose DATABASE_URL points at the compose database on 127.0.0.1:5435, and
# starts that database first.
dev: infra
	$(VENV)/bin/uvicorn app.main:app --reload --port $(MEERPAD_PORT)

# A database of its own, dropped and rebuilt by the tests. Never the one your
# notes are in: every test starts by emptying every table.
TEST_DB ?= postgresql+psycopg://meerpad:meerpad@127.0.0.1:$(MEERPAD_DB_PORT)/meerpad_test

test-db: infra
	$(COMPOSE) exec -T db psql -U $${POSTGRES_USER:-meerpad} -d postgres \
	  -c "DROP DATABASE IF EXISTS meerpad_test" \
	  -c "CREATE DATABASE meerpad_test"

test:
	MEERPAD_TEST_DB=$(TEST_DB) $(VENV)/bin/pytest -q -ra

lint:
	$(VENV)/bin/ruff check app tests tools

images:
	docker build --build-arg MEERPAD_VERSION=$(VERSION) -t meerpad-server:$(VERSION) .

# --- Notion import -------------------------------------------------------------
#
# Uploads a Notion "Markdown & CSV" export to a running server, into the named
# workspace (tools/notion_import.py says what else it takes). The token is your API token:
# Settings -> API token in the app. Against the hosted service:
#   make import SRC=~/Downloads/Export.zip WORKSPACE=Farm \
#     BASE_URL=https://meerpad.com MEERPAD_TOKEN=...
BASE_URL      ?= http://localhost:$(MEERPAD_PORT)
MEERPAD_TOKEN ?=
WORKSPACE     ?= Work
SRC           ?=

import:
	@test -n "$(SRC)" || { echo "usage: make import SRC=path/to/export.zip WORKSPACE=Farm MEERPAD_TOKEN=..." >&2; exit 2; }
	@test -n "$(MEERPAD_TOKEN)" || { echo "MEERPAD_TOKEN is empty: copy your API token from the app's settings" >&2; exit 2; }
	$(PY) tools/notion_import.py --server $(BASE_URL) --token $(MEERPAD_TOKEN) \
	  --workspace "$(WORKSPACE)" "$(SRC)"
