#!/usr/bin/env bash
# First-time certificate for docker compose deployments. Usage: ./deploy/init-letsencrypt.sh you@example.com
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
EMAIL="${1:?usage: $0 <email>}"
# 1) temporary self-signed cert so nginx can start
docker compose run --rm --entrypoint sh certbot -c "mkdir -p /etc/letsencrypt/live/$DOMAIN && \
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
  -out /etc/letsencrypt/live/$DOMAIN/fullchain.pem -subj /CN=localhost"
docker compose up -d nginx
# 2) replace with a real Let's Encrypt certificate via HTTP-01
docker compose run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf"
docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email
docker compose exec nginx nginx -s reload
echo "HTTPS ready at https://$DOMAIN"
