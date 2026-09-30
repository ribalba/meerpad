# meerpad-server: the notes app, its sync API, and every published website,
# in one process (app/main.py tells them apart by the Host header). The shape
# is meerpic's; what it stores is meerato's: a database and a folder of files.
FROM python:3.14-slim

ARG MEERPAD_VERSION=0.0.0

LABEL org.opencontainers.image.title="meerpad-server" \
      org.opencontainers.image.description="meerpad: notes, docs and wikis that are yours. Offline first, open source." \
      org.opencontainers.image.source="https://github.com/ribalba/meerpad" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${MEERPAD_VERSION}"

# Uploads and Notion imports live under /data, which compose mounts a named
# volume over. The database is Postgres and holds everything else, so /data
# plus the database volume is the whole install.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UPLOAD_DIR=/data/uploads \
    IMPORT_DIR=/data/imports

WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the world.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app /app/app
COPY VERSION /app/VERSION
# The build's own number wins over whatever the tree happened to hold, so an
# image cannot claim a version it was not built from (meerpic's rule).
RUN [ "$MEERPAD_VERSION" = "0.0.0" ] || printf '%s\n' "$MEERPAD_VERSION" > /app/VERSION

# An unprivileged user of its own. /data is made here, owned by that user,
# because a fresh named volume copies the ownership of the directory it is
# mounted over: without this the first upload would fail with EACCES on a
# root-owned volume. No VOLUME instruction: compose names the volume, and a
# VOLUME line would leave an anonymous one behind every plain `docker run`.
RUN useradd --create-home --uid 10001 meerpad \
 && mkdir -p /data/uploads /data/imports \
 && chown -R meerpad /app /data
USER meerpad

EXPOSE 8000
# localhost is always "the app" to app/sites.py, never a published site, so
# this reaches /healthz whatever BASE_URL says.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/healthz').status==200 else 1)"

# --proxy-headers with every address trusted: in production the only thing
# that can reach port 8000 is the reverse proxy (Coolify's Traefik reaches it
# over the project network, and docker-compose.yml publishes it on 127.0.0.1
# only), and the proxy is what knows the browser's address and that the
# request came in over https. Publish the port on a public address without a
# proxy in front and anyone can claim any X-Forwarded-For.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
