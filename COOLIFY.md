# Deploying meerpad with Coolify

This deploys meerpad, Postgres and the server, as one Coolify resource from
[`docker-compose.coolify.yml`](docker-compose.coolify.yml). Coolify's Traefik
terminates TLS in front of the server; the database is not reachable from
outside the host at all.

The app itself takes four steps. Published websites need nothing more: they
live at `https://meerpad.com/v/<name>`, a path on the app's own domain. Only a
custom domain someone points at a site needs one line in Coolify;
[Published websites](#6-published-websites) has it.

## What you need

| | |
| --- | --- |
| **Host** | 1 GB RAM is plenty for the server and Postgres. Disk for what people upload: every file dropped into a page, and Notion exports while they import (up to `MAX_IMPORT_BYTES`, 4 GB by default, each). |
| **Coolify** | v4. The compose file uses its magic variables (`SERVICE_PASSWORD_*`) and required variables (`${BASE_URL:?}`). |
| **DNS for the app** | An A record for the app's hostname (`meerpad.com`) pointing at the Coolify host. |

## 1. Create the resource

1. **+ New → Docker Compose** (under Applications), pointing at this repository,
   branch `main`.
2. Set **Docker Compose Location** to `/docker-compose.coolify.yml`.
3. Save. Coolify parses the file and pre-fills the Environment Variables tab
   with everything it references. **Do not deploy yet.**

## 2. Set the environment variables

In the resource's **Environment Variables** tab:

| Variable | |
| --- | --- |
| `BASE_URL` | **Required**, e.g. `https://meerpad.com`. Coolify refuses the deploy while it is empty. It is the app's one address: login links and every published website's address (`BASE_URL/v/<name>`) are built from it, and its host is what separates "the app" from a custom domain pointed at a published website. Any request for another host is looked up as a custom domain, so a wrong `BASE_URL` shows up as every page answering "No site is published at this address". It deliberately does not follow the Domains field (step 3), because that field also collects the custom domains of published sites. |
| `SERVICE_PASSWORD_POSTGRES` | Leave it alone. Coolify generates it once (letters and digits only, so it is safe inside `DATABASE_URL`) and reuses it on every redeploy. Postgres only reads it when it creates the database volume, so changing it later breaks the connection rather than changing the password; meerail's [COOLIFY.md](https://github.com/ribalba/meerail/blob/main/COOLIFY.md#troubleshooting-postgres) has the recovery. |
| `SERVICE_PASSWORD_64_MEERPAD` | Leave it alone. The `SECRET_KEY` that signs login codes; changing it only invalidates sign-in links and codes still in flight. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_USE_TLS`, `EMAIL_FROM` | Needed before anyone but you can sign in. Without `SMTP_HOST` the sign-in link and code are printed to the `web` container's log instead, which is how you sign in the first time (step 5). `EMAIL_FROM` defaults to `hello@meerpad.com`. |
| `PUBLIC_IP` | This server's public IPv4. The publish dialog shows it as the address to point a custom domain's A record at. Purely informational: nothing checks DNS. |
| `DEFAULT_WORKSPACES` | Default `Work,Private`: the workspaces a new account starts with. |
| `MAX_UPLOAD_BYTES`, `MAX_IMPORT_BYTES` | Default 50 MB per file, 4 GB per Notion export. See [Large Notion imports](#large-notion-imports) for the proxy's side of the second. |
| `HISTORY_IDLE_MINUTES`, `HISTORY_MAX_SESSION_MINUTES`, `HISTORY_KEEP_SESSIONS` | Default 10, 60 and 200: a page's edits group into a session that ends after 10 quiet minutes or at an hour, and 200 finished sessions are kept per page. |
| `LOGIN_*`, `SESSION_TTL_MINUTES`, `VERIFY_RATE_MAX`, `FETCH_TIMEOUT_SECONDS` | Optional; [`.env.example`](.env.example) explains each. |

`FETCH_ALLOW_PRIVATE` is not a variable on this stack: the compose file pins it
to `false`, because "download this pasted link" must never be able to reach the
host's own network from a server on the internet.

## 3. Give the app its domain

On the **`web`** service, set **Domains** to `https://meerpad.com:8000`. The
`:8000` tells Coolify which container port to route to. Coolify writes the
Traefik labels and gets the certificate over Let's Encrypt's HTTP challenge.
`https://www.meerpad.com:8000` can go in the same field, comma separated: the
app treats `www.` + its own host as itself.

Declarative alternative, as in meerail's file: uncomment the
`SERVICE_FQDN_WEB_8000` line in the compose file and Coolify generates a
hostname off the server's wildcard domain. The UI field is the reliable path.

Do **not** add `ports:` to either service. Postgres has no business on the
internet, and the server trusts `X-Forwarded-For` from whoever can reach port
8000 directly (uvicorn runs with `--forwarded-allow-ips '*'`, which is right
only while the proxy is the one thing that can).

## 4. Deploy

Deploy. The image builds from this repository (a minute or two), Postgres comes
up healthy, and the server creates its schema on first start and applies any
new migrations on every later one (`app/migrations.py`). The image has a
healthcheck on `/healthz`, which Coolify shows.

## 5. Sign in the first time

Open `https://meerpad.com`, press **Sign in** and enter your address. With SMTP
configured the mail arrives as usual. Without it, the link and the code are in
the log: **`web` → Logs** in Coolify, or on the host

```bash
docker ps --filter name=web- --format '{{.Names}}'
docker logs <that container> 2>&1 | grep -A16 '\[EMAIL\]' | tail -20
```

The link and the code are both in there; either signs you in.

## 6. Published websites

meerpad serves every published site from the same container as the app, at
`https://meerpad.com/v/<name>` (the owner picks the name in the publish dialog,
which checks that it is free). That is a path on the app's own domain, so
**there is nothing to set up**: no DNS record, no Coolify domain, no
certificate.

On top of that, a site can have a custom domain. meerpad tells those apart by
the `Host` header (`app/main.py` hands every host other than `BASE_URL`'s to
`app/sites.py`), so nothing in meerpad needs configuring per domain either;
what does is getting the request for that hostname to the container, with a
certificate for it.

### Custom domains

Someone publishes a page and enters `eggs.example.org` as its custom domain.
From there:

1. **They** create an A record for `eggs.example.org` pointing at the address
   the publish dialog shows (`PUBLIC_IP`). No AAAA record unless this server
   has IPv6: a stale one sends part of the internet somewhere else and makes
   the certificate fail.
2. **You**, once `dig +short eggs.example.org` prints that address, append
   `https://eggs.example.org:8000` to the `web` service's Domains, comma
   separated, and **redeploy**: Coolify writes Traefik's labels at deploy time,
   so a restart is not enough. Traefik then gets the certificate over the HTTP
   challenge.

The app needs nothing: the site's custom domain is already stored with the site,
and the request arrives with that `Host` header.

Order matters. If Traefik asks Let's Encrypt before the record resolves, the
challenge fails, and Let's Encrypt allows only a few failed validations per
hostname per hour. Wait for DNS, then add the domain.

## Large Notion imports

Traefik stops reading a request that takes longer than 60 seconds
(`respondingTimeouts.readTimeout`, the default since Traefik 2.11.2), and a
multi-gigabyte Notion export over an ordinary uplink takes longer than that.
The upload then fails partway with no error from meerpad, which never saw the
end of it. If people import large workspaces, raise it for the HTTPS entry point
in the proxy's `command` list and restart the proxy:

```yaml
      - '--entrypoints.https.transport.respondingTimeouts.readTimeout=30m'
```

It applies to every app behind this proxy. Traefik has no request body limit by
default, so `MAX_IMPORT_BYTES` is the only ceiling on size.

## Operating it

| | |
| --- | --- |
| **Backups** | Two volumes: `pg-data` (every page, block and account) and `meerpad-data` (uploaded files and imports in progress). Back them up together: pages point at files by id. |
| **Upgrades** | Redeploy. Migrations run at startup. The browser apps keep working through the restart (they are offline-first) and push what they queued once the server is back. Avoid redeploying in the middle of a large Notion import. |
| **Postgres major upgrade** | The volume is mounted at `/var/lib/postgresql`, not `.../data`, which is what keeps `pg_upgrade --link` available later. |
| **Sign-in mails** | Without SMTP they are in the `web` log. With SMTP and none arriving, the log says why. |
| **A custom domain shows "No site is published at this address"** | The request reached meerpad, so DNS and the proxy are fine: the hostname matches no enabled site. Check the custom domain in the publish dialog. |
| **A custom domain gives a certificate error or a 404 from Traefik** | The request never reached meerpad. The name is missing from the Domains list, or its DNS points elsewhere. |

## Local development is unaffected

`docker-compose.yml` and `docker-compose.dev.yml` are untouched by any of this;
`make up` and `make dev` work as [README.md](README.md) describes. This file is
additive.
