# hermes-van — deploy

Production deploy artifacts for `hermes.vintek.io` (or any other domain
you point at the VPS).

## Layout

```
deploy/
├── README.md                       # this file
├── nginx/
│   └── hermes-van.conf             # nginx site (TLS, HSTS, SSE, /sw.js)
├── systemd/
│   └── hermes-van.service          # user-scope systemd unit
└── scripts/
    └── certbot.sh                  # Let's Encrypt issuer + renewer
```

The Hono app listens on `127.0.0.1:3015` by default. Nginx terminates
TLS and proxies to it. Nothing in this directory binds to a public
port directly — that's nginx's job.

## Prereqs (one-time)

```bash
# nginx + Certbot
sudo apt install nginx certbot

# pnpm in PATH for systemd
which pnpm   # usually /usr/bin/pnpm or ~/.local/bin/pnpm

# Linger so the user unit survives logout (Hermes already enables
# this on ivanxgb — re-run is harmless).
sudo loginctl enable-linger "$USER"

# Webroot for ACME http-01.
sudo mkdir -p /var/www/certbot && sudo chmod 755 /var/www/certbot
```

## Install order

1. **Build & migrations**
   ```bash
   cd ~/projects/hermes-van/web
   pnpm install --frozen-lockfile
   pnpm hermes-van:vapid >> .env  # one-time, only if VAPID not set
   pnpm db:migrate
   ```

2. **Nginx site (HTTP only, for the ACME challenge)**

   First-time, the `:443` block in the bundled config will fail nginx
   `-t` because the cert doesn't exist yet. Use the http-only template
   to bootstrap:

   ```bash
   sudo tee /etc/nginx/sites-available/hermes-van.conf <<'EOF'
   server {
       listen 80;
       server_name hermes.vintek.io;
       location /.well-known/acme-challenge/ { root /var/www/certbot; }
       location / { return 200 'pending TLS\n'; }
   }
   EOF
   sudo ln -sf /etc/nginx/sites-available/hermes-van.conf \
              /etc/nginx/sites-enabled/hermes-van.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. **Issue the cert**
   ```bash
   sudo bash ~/projects/hermes-van/deploy/scripts/certbot.sh \
       hermes.vintek.io certs@vintek.io
   ```

4. **Swap in the full nginx config (TLS + SSE + /sw.js)**
   ```bash
   sudo cp ~/projects/hermes-van/deploy/nginx/hermes-van.conf \
           /etc/nginx/sites-available/hermes-van.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```

5. **systemd user service**
   ```bash
   mkdir -p ~/.config/systemd/user
   cp ~/projects/hermes-van/deploy/systemd/hermes-van.service \
      ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now hermes-van
   systemctl --user status hermes-van
   ```

6. **Verify**
   ```bash
   curl -fsS https://hermes.vintek.io/api/health | jq
   journalctl --user -u hermes-van -n 50 --no-pager
   ```

## Updates

```bash
cd ~/projects/hermes-van && git pull
cd web && pnpm install --frozen-lockfile && pnpm db:migrate
systemctl --user restart hermes-van
```

## Renew certs

Certbot's apt package installs a systemd timer that runs twice daily.
You don't have to do anything. To force a check:

```bash
sudo bash ~/projects/hermes-van/deploy/scripts/certbot.sh
```

## Reverting

Stop the service and remove nginx site:

```bash
systemctl --user disable --now hermes-van
sudo rm /etc/nginx/sites-enabled/hermes-van.conf
sudo systemctl reload nginx
```

The cert remains under `/etc/letsencrypt/live/<domain>/` until you
explicitly `sudo certbot delete --cert-name <domain>`.

## Caveats

- **Service worker scope**: `/sw.js` is served from the root scope and
  must NOT be cached. The nginx config disables caching for that path.
- **SSE timeouts**: The `/api/runs/:id/events` location disables
  `proxy_buffering` and raises the read timeout to 1h. If you front
  this with Cloudflare, switch the proxy to "bypass cache" and disable
  any rocket-loader features for that path.
- **HSTS preload**: HSTS header in this config is `includeSubDomains`
  with a 1-year max-age but no `preload` flag. Add `preload` and
  submit at https://hstspreload.org once you're confident the domain
  will stay HTTPS forever.
