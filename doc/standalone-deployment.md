# Standalone deployment behind a path prefix

Robin Admin can run without Robin MTA, Robin Sheriff, or any other Robin Suite
container. It requires only its own PostgreSQL database and persistent storage
for that database. MTA-dependent workspaces remain visible only when enabled by
the local configuration; requests to a disabled or unreachable Robin MTA return
an explicit `503` and do not prevent setup, login, administration, or module
configuration.

## `/admin` deployment

Run the UI image (`suite-admin-ui`) with `BASE_PATH=/admin/`; it rewrites the
built asset URLs at start, so the same image serves any prefix. Configure the
Robin Admin server with:

```dotenv
NODE_ENV=production
DB_HOST=<standalone-admin-postgres-host>
DB_PORT=5432
DB_NAME=robin_admin
DB_USER=robin_admin
DB_PASSWORD=<unique-database-password>
SESSION_SECRET=<unique-64-byte-random-secret>
ROBIN_ADMIN_ENCRYPTION_KEY=<unique-64-char-random-key>
ROBIN_ADMIN_PUBLIC_URL=https://admin.example.com/admin
COOKIE_PATH=/
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://admin.example.com
BASE_PATH=/admin/
ROBIN_API_ENABLED=false
MODULE_PROXY_SECRETS_JSON={}
MODULES_BOOTSTRAP_JSON=[]
FLEET_AGENTS_BOOTSTRAP_JSON=[]
FLEET_SERVICES_BOOTSTRAP_JSON=[]
```

Use a database and persistent volume dedicated to this deployment; do not point
`DB_*` at Sheriff or Robin MTA state. `ROBIN_API_URL` and
`ROBIN_METRICS_URL` are unnecessary while `ROBIN_API_ENABLED=false`.
The empty bootstrap arrays prevent the suite-oriented Compose defaults from
registering unreachable MTA, module, or agent services.
Leave `COOKIE_DOMAIN` unset for a host-only session cookie. Generated Fleet agent
commands retain the UI's `/admin` prefix; downloaded agent artifacts
come from the saved Administration Fleet settings, not frontend fallback values.

The external Caddy instance must own the `/admin` matcher and strip only the
`/admin` prefix from API and module requests before proxying. This leaves the
server's existing `/api` and `/modules` paths intact. Do not add a catch-all
root handler for Robin Admin. The proxy joins the `suite-admin` network, where
the server and UI answer on their role aliases:

```caddy
@robin_admin_root path /admin
redir @robin_admin_root /admin/ 308

@robin_admin_module_files {
	path /admin/modules/*
	not header Sec-Fetch-Dest document
}
handle @robin_admin_module_files {
	uri strip_prefix /admin
	reverse_proxy admin-backend:3001
}

handle /admin/api/* {
	uri strip_prefix /admin
	reverse_proxy admin-backend:3001
}

handle_path /admin/* {
	reverse_proxy admin-frontend:80
}
```

The API and module handlers are separate so authenticated module assets and
module backend proxies continue to use Robin Admin. Module pages in the UI share
the `/modules/` path with module files, so a browser opening or reloading a
module page (a request with `Sec-Fetch-Dest: document`) goes to the UI instead. The server receives paths
under `/api` and `/modules`, so its session cookie path must be `/`; Caddy
still exposes the Admin application only under `/admin/`. The UI emits browser
URLs under `/admin/` and serves its files from the stripped path.

For a root-hosted deployment, leave `BASE_PATH=/` and `COOKIE_PATH=/`.
