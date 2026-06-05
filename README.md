# hermes-van

Self-hosted web client for [Hermes Agent](https://github.com/NousResearch/Hermes-Agent).

`hermes-van` is a browser interface for running Hermes Agent from a private web
app instead of a chat app or raw terminal. It connects to the native Hermes
gateway API, keeps the gateway key on the server, and gives you a multi-chat,
passkey-protected workspace for long agent sessions.

## Highlights

- Multi-chat UI with independent streamed runs.
- Server-sent event streaming for token-by-token responses.
- Slash command palette sourced from the live gateway.
- Provider/model selector sourced from `/v1/providers`.
- WebAuthn/passkey login with one-time bootstrap tokens.
- Recovery codes for account recovery.
- Local encrypted SQLite database through SQLCipher.
- Per-user scoping for chats, messages, uploads, sessions, and push subscriptions.
- Audit log, rate limits, CSRF protection, secure cookies, and security headers.
- File attachments, markdown rendering, activity stream, search, exports, metrics,
  backups, restore, and web push support.

## Status

Active self-hosted project. The current codebase includes the web UI, Hono server,
auth system, gateway proxy, encrypted local database, migrations, unit tests,
Playwright e2e tests, deployment artifacts, and operational runbooks.

This is not a generic hosted SaaS. It is designed to run beside your own Hermes
gateway, usually on localhost or behind a private HTTPS origin.

## Architecture

```text
browser
  |
  | passkeys, CSRF, SSE, REST
  v
hermes-van Hono server
  |
  | gateway key stays server-side
  v
Hermes Agent gateway API
  |
  v
agent runs, tools, providers, jobs, approvals
```

Local state lives in an encrypted SQLite database. The browser never receives
the upstream gateway API key.

## Requirements

- Node.js 22+
- pnpm
- A running Hermes Agent gateway with the API server enabled
- Linux/macOS for local development; Linux recommended for deployment

## Quick Start

```bash
git clone https://github.com/ivanxgb/hermes-van.git
cd hermes-van/web

pnpm install
cp .env.example .env
```

Edit `.env`:

```env
NODE_ENV=development
HERMES_VAN_GATEWAY_URL=http://127.0.0.1:8765
HERMES_VAN_GATEWAY_KEY=<your Hermes gateway api_server key>
HERMES_VAN_DB_PATH=./data/hermes-van.db
HERMES_VAN_DB_KEY=<64 hex chars from: openssl rand -hex 32>
HERMES_VAN_SESSION_SECRET=<64 hex chars from: openssl rand -hex 32>
HERMES_VAN_RP_ID=localhost
HERMES_VAN_RP_ORIGIN=http://localhost:3015
HERMES_VAN_RP_NAME=hermes-van
HERMES_VAN_PORT=3015
HERMES_VAN_HOST=127.0.0.1
```

Run migrations and start:

```bash
pnpm db:migrate
pnpm hermes-van:bootstrap
pnpm dev
```

Open `http://localhost:3015`, paste the bootstrap token on `/setup`, and
register your first passkey.

## Scripts

From `web/`:

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Start the development server. |
| `pnpm build` | Typecheck and build. |
| `pnpm start` | Run the server with `.env`. |
| `pnpm typecheck` | TypeScript check. |
| `pnpm lint` | ESLint. |
| `pnpm test` | Unit tests. |
| `pnpm test:e2e` | Playwright tests. |
| `pnpm db:migrate` | Apply database migrations. |
| `pnpm hermes-van:bootstrap` | Generate a one-time setup token. |
| `pnpm hermes-van:backup` | Back up the encrypted database. |
| `pnpm hermes-van:restore` | Restore an encrypted database backup. |
| `pnpm hermes-van:vapid` | Generate VAPID keys for web push. |

## Security Model

`hermes-van` assumes the Hermes gateway is powerful and private. The web app is
therefore built around a few hard boundaries:

- the gateway key is only read by the server
- browser sessions use signed cookies
- mutating requests require CSRF validation
- passkeys are the primary login mechanism
- recovery codes are one-time and hashed
- local tables are scoped per user
- logs redact secret-bearing fields
- production rejects placeholder secrets

See [web/docs/PENTEST.md](./web/docs/PENTEST.md) and
[web/docs/RUNBOOK.md](./web/docs/RUNBOOK.md) for operational checks.

## Deployment

Deployment examples live in [deploy/](./deploy) and [web/deploy/](./web/deploy).
They include nginx, systemd, Certbot, CI notes, backup/restore procedures, and
SSE-specific proxy settings.

Before deploying publicly:

- use HTTPS
- set a real `HERMES_VAN_RP_ID` and `HERMES_VAN_RP_ORIGIN`
- generate fresh DB and session keys
- keep `.env` mode `0600`
- verify the pentest checklist
- keep the gateway bound to localhost or a private network

## Repository Layout

```text
.
├── index.html              # public project/roadmap page
├── roadmap-v2.html         # status page
├── deploy/                 # production deploy examples
└── web/
    ├── src/                # React client + Hono server
    ├── scripts/            # migrate, bootstrap, backup, restore, vapid
    ├── tests/              # unit and e2e tests
    ├── docs/               # runbook and pentest checklist
    └── public/             # manifest, service worker, icon
```

## Notes

Some deployment examples include placeholder domains such as
`hermes.example.com` or a maintainer's own domain. Replace them before use.

## License

MIT. See [LICENSE](./LICENSE).
