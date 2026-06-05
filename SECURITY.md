# Security Policy

`hermes-van` is a self-hosted web client for a powerful local Hermes Agent
gateway. The gateway can run tools and access private context, so deployment
secrets must be treated carefully.

## Secrets

Never commit:

- `.env`
- `HERMES_VAN_GATEWAY_KEY`
- `HERMES_VAN_DB_KEY`
- `HERMES_VAN_SESSION_SECRET`
- `HERMES_VAN_VAPID_PRIVATE`
- `HERMES_VAN_ALERT_BEARER`
- encrypted database files and backups
- upload directories or user exports

Use `web/.env.example` as a template only. Generate fresh keys for every
deployment:

```bash
openssl rand -hex 32
```

## Rotation

- Rotate `HERMES_VAN_GATEWAY_KEY` in the Hermes gateway and this app together.
- Rotate `HERMES_VAN_SESSION_SECRET` to invalidate all browser sessions.
- Rotate `HERMES_VAN_DB_KEY` with a planned SQLCipher re-encryption migration.
- Rotate VAPID keys if web push private material is exposed.

See [web/docs/RUNBOOK.md](./web/docs/RUNBOOK.md) for operational procedures.

## Deployment

Recommended production posture:

- keep the Hermes gateway on localhost or a private network
- terminate TLS in nginx or another trusted reverse proxy
- use a real `HERMES_VAN_RP_ID` and HTTPS `HERMES_VAN_RP_ORIGIN`
- keep `.env` mode `0600`
- run the pentest checklist before exposing the app

See [web/docs/PENTEST.md](./web/docs/PENTEST.md).

## Reporting

Open a private GitHub security advisory if available. If not, open an issue with
minimal details and avoid posting real tokens, private gateway URLs, logs, or
user data.
