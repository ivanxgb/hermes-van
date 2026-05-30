#!/usr/bin/env bash
# hermes-van — Certbot bootstrap.
#
# Issues a Let's Encrypt cert for hermes.vintek.io via the http-01
# challenge served from /var/www/certbot. Idempotent: re-running renews
# if the cert is within 30 days of expiry, otherwise no-op.
#
# Usage:
#   sudo deploy/scripts/certbot.sh [domain] [email]
#
# Defaults:
#   domain: hermes.vintek.io
#   email:  certs@vintek.io
#
# Prereqs:
#   - nginx is running and serves /.well-known/acme-challenge/ from
#     /var/www/certbot (the bundled hermes-van.conf already does this
#     in its :80 server block).
#   - DNS A/AAAA for $DOMAIN points at this host.
#   - Certbot is installed (apt install certbot).
#
# Exit codes:
#   0  cert was issued or renewed (or already valid)
#   1  preflight failed (binary missing, nginx not running, etc.)
#   2  Certbot failed to obtain/renew

set -euo pipefail

DOMAIN="${1:-hermes.vintek.io}"
EMAIL="${2:-certs@vintek.io}"
WEBROOT="/var/www/certbot"

log() { printf '[certbot] %s\n' "$*"; }
err() { printf '[certbot][error] %s\n' "$*" >&2; }

if [[ "${EUID}" -ne 0 ]]; then
    err "must run as root (sudo)"
    exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
    err "certbot not installed (try: apt install certbot)"
    exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
    err "nginx not installed"
    exit 1
fi

# Ensure webroot exists for the http-01 challenge.
mkdir -p "${WEBROOT}"
chmod 755 "${WEBROOT}"

# Test that nginx is reloadable and the public port answers.
if ! nginx -t >/dev/null 2>&1; then
    err "nginx -t failed; fix config before issuing cert"
    exit 1
fi

systemctl reload nginx || systemctl restart nginx

# Probe the HTTP path that Certbot will use. If this 404s on a fresh
# domain it usually means DNS isn't set yet.
if ! curl -fsS --max-time 5 "http://${DOMAIN}/.well-known/acme-challenge/_probe" >/dev/null 2>&1; then
    log "preflight probe returned non-2xx (expected for first run, continuing)"
fi

LIVE_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
if [[ -f "${LIVE_PATH}" ]]; then
    log "existing cert found, attempting renewal"
    certbot renew --quiet --webroot -w "${WEBROOT}" || {
        err "renew failed"
        exit 2
    }
    log "renewed (or skipped if not due)"
else
    log "no cert yet, requesting new one"
    certbot certonly \
        --webroot -w "${WEBROOT}" \
        -d "${DOMAIN}" \
        --email "${EMAIL}" \
        --agree-tos \
        --no-eff-email \
        --non-interactive || {
            err "issuance failed"
            exit 2
        }
fi

log "reloading nginx with new cert"
systemctl reload nginx

log "done — cert at ${LIVE_PATH}"
