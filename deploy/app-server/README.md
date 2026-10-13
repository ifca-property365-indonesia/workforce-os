# App server preparation

These two files turn a server you own into an **app server** for Workforce OS: the place where the apps your
employees build are previewed (`https://<app>.<your domain>`).

- `prepare.sh` — run once by you, as root, on that server. Safe to run again (to update the helper, or after
  changing the domain).
- `wfos-app-helper` — installed by `prepare.sh` as `/usr/local/sbin/wfos-app-helper`. It is the only thing
  Workforce OS may run as root, and it checks every argument (app name, port, memory, paths) before doing anything.

Workforce OS never sees a root password. It logs in as an ordinary user (`wfos-apps`) with the workspace's own SSH
key, and only after you confirmed the server's host key fingerprint.

## What `prepare.sh` changes

- installs nginx, certbot, PostgreSQL, jq, git, rsync and build-essential (skips what is installed), Node.js of the
  requested major from NodeSource when node is missing or another major, and pnpm via corepack
- creates the user `wfos-apps` (no sudo group) with `~/apps`, and puts the workspace public key in its
  `~/.ssh/authorized_keys` with forwarding and pty disabled
- creates a separate PostgreSQL cluster `apps` on port 5433 (localhost only, small memory) for the apps' databases;
  your existing PostgreSQL is not touched
- installs `/usr/local/sbin/wfos-app-helper` and `/etc/sudoers.d/wfos-app-helper` (the user may run exactly that
  file as root; checked with `visudo` first), and writes `/etc/wfos-app-helper.conf`
- adds `/etc/nginx/wfos-apps/` and `/etc/nginx/conf.d/wfos-apps.conf` (a websocket map), then reloads nginx
- opens ports 80 and 443 in ufw when ufw is active

This version of the helper only answers two read-only questions (`version`, `info`: versions, disk, memory) so
Workforce OS can check the server. Running, building and publishing apps comes with Phase A2: each app will run as
its own sandboxed systemd unit (`wfos-app-<name>`) with a memory limit, no access to `/root`, other apps, Redis,
certificates or local services, and get its own nginx site and Let's Encrypt certificate. Re-run `prepare.sh`
then to update the helper.

## Steps

1. In Workforce OS: **Settings → Servers → Add server**. Copy the prepare command it shows (it contains the
   workspace public key and your domain).
2. Make sure DNS `*.<your domain>` points at the server (for example `*.preview.example.com`).
3. Copy both files to the server, next to each other, and run the command as root. Try it first with `--dry-run`
   (prints every action, changes nothing):

   ```bash
   sudo bash prepare.sh --public-key 'ssh-ed25519 AAAA… wfos-yourworkspace' --domain preview.example.com --dry-run
   sudo bash prepare.sh --public-key 'ssh-ed25519 AAAA… wfos-yourworkspace' --domain preview.example.com
   ```

   Options: `--user` (default `wfos-apps`), `--pg-port` (default `5433`), `--node-major` (default `24`).
4. It ends with the server's SSH host key fingerprint and `WFOS_SERVER_READY`. Back in Workforce OS press **Scan**,
   check that the fingerprint shown there is exactly the one printed here (or run
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then **Confirm & verify**.

If the fingerprints differ, do not confirm: you are not talking to that server.

## Removing it

```bash
sudo rm -f /etc/sudoers.d/wfos-app-helper /usr/local/sbin/wfos-app-helper   # Workforce OS loses root at once
sudo systemctl disable --now 'wfos-app-*'                                    # stop the apps
sudo deluser --remove-home wfos-apps                                         # and remove the login
```

Then, if you want: `pg_dropcluster --stop <version> apps`, remove `/etc/nginx/sites-*/wfos-app-*`,
`/etc/nginx/wfos-apps`, `/etc/nginx/conf.d/wfos-apps.conf`, `/etc/systemd/system/wfos-app-*.service` and
`/etc/wfos-app-helper.conf`.

## Tests

`bash deploy/app-server/test/app-server.sh` runs both scripts in dry-run mode only (nothing is installed or changed).
