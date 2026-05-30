# hermes-van Runbook

Operational procedures for hermes-van running on the VPS.

## Deployment

### First deploy

```bash
# On the VPS, in ~/projects/hermes-van/web
pnpm install
pnpm rebuild better-sqlite3 @node-rs/argon2 esbuild --foreground-scripts

# Generate secrets (32 bytes hex each)
DB_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)

# Write .env (chmod 0600). Note: prefer HV_* prefixed vars in
# environments where the host already exports HERMES_* vars (Hermes
# Agent runtime). Without renaming, the host's HERMES_API_KEY etc.
# will override values from .env when sourced into the same shell.
cat > .env <<EOF
NODE_ENV=production
HERMES_API_URL=http://127.0.0.1:8765
HERMES_API_KEY=<paste from ~/.hermes/config.yaml gateway.platforms.api_server.key>
HERMES_WEB_DB_PATH=/var/lib/hermes-van/hermes-van.db
HERMES_WEB_DB_KEY=$DB_KEY
HERMES_WEB_SESSION_SECRET=$SESSION_SECRET
HERMES_WEB_RP_ID=hermes.vintek.io
HERMES_WEB_RP_ORIGIN=https://hermes.vintek.io
HERMES_WEB_RP_NAME=hermes-van
HERMES_WEB_PORT=3015
HERMES_WEB_HOST=127.0.0.1
HERMES_WEB_LOG_LEVEL=info
EOF
chmod 600 .env

# Apply migrations (runs against HERMES_WEB_DB_PATH)
node --env-file=.env node_modules/.bin/tsx scripts/migrate.ts

# Build
pnpm build
```

Service unit (run under user systemd with linger):

```ini
# ~/.config/systemd/user/hermes-van.service
[Unit]
Description=hermes-van web client
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ivanxgb/projects/hermes-van/web
EnvironmentFile=/home/ivanxgb/projects/hermes-van/web/.env
ExecStart=/usr/bin/node ./dist/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now hermes-van
loginctl enable-linger ivanxgb
```

Nginx site:

```bash
sudo cp deploy/nginx-hermes-van.conf /etc/nginx/sites-available/hermes-van
sudo ln -s /etc/nginx/sites-available/hermes-van /etc/nginx/sites-enabled/
sudo certbot --nginx -d hermes.vintek.io
sudo nginx -t && sudo systemctl reload nginx
```

### Subsequent deploys

```bash
cd ~/projects/hermes-van/web
git pull
pnpm install
pnpm rebuild better-sqlite3 @node-rs/argon2 esbuild --foreground-scripts
node --env-file=.env node_modules/.bin/tsx scripts/migrate.ts
pnpm build
systemctl --user restart hermes-van
```

## First-user bootstrap

```bash
cd ~/projects/hermes-van/web
node --env-file=.env node_modules/.bin/tsx scripts/bootstrap.ts --hours 1
# → prints a one-time token, valid 1 hour. Visit /setup, paste token,
#   pick username, register passkey. Save the 10 recovery codes shown
#   immediately after registration.
```

## Rotation

### Rotate `HERMES_API_KEY` (gateway key)

1. Update `gateway.platforms.api_server.key` in `~/.hermes/config.yaml`.
2. `hermes gateway restart` (or however your gateway restarts).
3. Update `HERMES_API_KEY` in hermes-van's `.env`.
4. `systemctl --user restart hermes-van`.
5. Verify `/api/health` returns `gateway.ok = true`.

### Rotate `HERMES_WEB_SESSION_SECRET`

Rotating session secret invalidates ALL active sessions (every user must re-auth).

```bash
NEW_SECRET=$(openssl rand -hex 32)
sed -i "s/^HERMES_WEB_SESSION_SECRET=.*/HERMES_WEB_SESSION_SECRET=$NEW_SECRET/" .env
systemctl --user restart hermes-van
```

### Rotate `HERMES_WEB_DB_KEY` (SQLCipher master key)

Requires a key migration: dump → re-encrypt → restore.

```bash
systemctl --user stop hermes-van
OLD_KEY=$(grep HERMES_WEB_DB_KEY .env | cut -d= -f2)
NEW_KEY=$(openssl rand -hex 32)
DB_PATH=$(grep HERMES_WEB_DB_PATH .env | cut -d= -f2)

# Use sqlite3 with SQLCipher CLI (or write a tiny migration script).
# Pseudo:
node -e "
const Db = require('better-sqlite3-multiple-ciphers');
const src = new Db('$DB_PATH');
src.pragma(\"key='$OLD_KEY'\");
src.pragma('cipher_compatibility=4');
src.exec(\"ATTACH DATABASE '$DB_PATH.new' AS migrated KEY '$NEW_KEY';\");
src.exec(\"SELECT sqlcipher_export('migrated');\");
src.exec('DETACH DATABASE migrated');
src.close();
require('fs').renameSync('$DB_PATH', '$DB_PATH.bak.\$(date +%s)');
require('fs').renameSync('$DB_PATH.new', '$DB_PATH');
"

sed -i "s/^HERMES_WEB_DB_KEY=.*/HERMES_WEB_DB_KEY=$NEW_KEY/" .env
systemctl --user start hermes-van
```

Test the new connection by visiting `/api/health`. Keep the `.bak.<ts>`
file for at least 7 days before deleting.

## Backup / restore

### Backup

```bash
# Hot backup via SQLite's online backup API (requires brief lock).
DB_PATH=/var/lib/hermes-van/hermes-van.db
DB_KEY=$(grep HERMES_WEB_DB_KEY ~/projects/hermes-van/web/.env | cut -d= -f2)
DEST=/var/backups/hermes-van/$(date +%F).db

mkdir -p $(dirname $DEST)
node -e "
const Db = require('better-sqlite3-multiple-ciphers');
const src = new Db('$DB_PATH');
src.pragma(\"key='$DB_KEY'\");
src.pragma('cipher_compatibility=4');
src.backup('$DEST').then(() => { console.log('OK'); src.close(); });
"
```

Schedule with cron or systemd timer. Off-site copy via `rsync` or `rclone`
to S3/B2 (encrypt with `age` or use SQLCipher's at-rest encryption — the
backup is already encrypted with the DB key).

### Restore

```bash
systemctl --user stop hermes-van
cp /var/backups/hermes-van/2026-05-30.db /var/lib/hermes-van/hermes-van.db
chmod 600 /var/lib/hermes-van/hermes-van.db
systemctl --user start hermes-van
```

## Session management

### Revoke a single session

Using the user-facing UI: `/settings` → "Revoke all sessions" (logs the
user out everywhere). Phase 4 will add per-session revocation via the
admin panel.

To revoke server-side:

```bash
DB_PATH=/var/lib/hermes-van/hermes-van.db
DB_KEY=$(grep HERMES_WEB_DB_KEY ~/projects/hermes-van/web/.env | cut -d= -f2)

node -e "
const Db = require('better-sqlite3-multiple-ciphers');
const db = new Db('$DB_PATH');
db.pragma(\"key='$DB_KEY'\");
db.pragma('cipher_compatibility=4');
db.prepare('UPDATE web_sessions SET revoked_at = unixepoch()*1000 WHERE id = ?').run('<sessionId>');
db.close();
"
```

## Observability

- Server logs: `journalctl --user -u hermes-van -f`
- Audit log queries:

```bash
node -e "
const Db = require('better-sqlite3-multiple-ciphers');
const db = new Db('/var/lib/hermes-van/hermes-van.db');
db.pragma(\"key='\$DB_KEY'\");
db.pragma('cipher_compatibility=4');
console.log(JSON.stringify(db.prepare('SELECT ts, event, user_id, ip FROM audit_log ORDER BY ts DESC LIMIT 50').all(), null, 2));
db.close();
"
```

## Incident response

### Suspected credential compromise

1. Revoke all sessions for the user via SQL (or the user does it via /settings).
2. Force the user to re-auth.
3. Optionally invalidate every passkey for that user (DELETE FROM
   webauthn_credentials WHERE user_id = X) and require re-bootstrap with
   a new setup token.
4. Audit `audit_log` for `login.ok` events outside expected hours/IPs.

### Suspected DB compromise

1. Stop the service: `systemctl --user stop hermes-van`.
2. Snapshot the DB file forensically (`cp -a` to a separate location).
3. Rotate `HERMES_WEB_DB_KEY` (above).
4. Re-issue recovery codes for every user (delete from recovery_codes,
   force users to regenerate via /settings — Phase 3 feature).
5. Consider revoking all passkeys and forcing re-registration.

### Brute-force / scanner activity

- Rate limiter automatically blocks IPs that hit `/auth/login/*` more
  than 5 times in 15 min, `/auth/recovery` more than 3 in 1 hour.
- Persistent attackers: add an nginx `limit_req` zone or a fail2ban
  filter against the `journalctl` output.

## Health checks

- `GET /api/health` returns `{status, gateway: {ok, latencyMs}}`. Wire
  this into a watchdog (cronjob or external uptime monitor) to alert on
  `status=degraded` or non-200.
