# App server preparation

These two files turn a server you own into an **app server** for Workforce OS: the place where the apps your
employees build are previewed (`https://<app>.<your domain>`) and, once released, run live at a client's own domain
(`https://app.client.com`).

- `prepare.sh` — run by you, as root, on that server. Safe to run again (to update the helper, after changing the
  domain, or to upgrade an earlier install in place).
- `wfos-app-helper` — installed by `prepare.sh` as `/usr/local/sbin/wfos-app-helper`. It is the only thing
  Workforce OS may run as root. It checks every argument and every stdin payload (instance name, commit, port,
  memory, domain names, env lines, password hash) before doing anything. This is helper version 3 (`version`,
  `info.helperVersion`); Workforce OS shows a server with an older helper as outdated until you re-run `prepare.sh`.

Workforce OS never sees a root password. It logs in as an ordinary user (`wfos-apps`) with the workspace's own SSH
key, and only after you confirmed the server's host key fingerprint.

## What `prepare.sh` installs and changes

- packages (skips what is installed): nginx, certbot, openssl, PostgreSQL, nftables, jq, git, rsync, build-essential; Node.js
  of the requested major from NodeSource's signed apt repository (keyring in `/etc/apt/keyrings/nodesource.gpg`)
  when node is missing or another major
- pnpm (default `10.33.0`) prepared by corepack into `/opt/wfos-apps/corepack`, shared and read-only for every app,
  so no app downloads a package manager at run time
- the group `wfos-app-run` (every app process runs with it; the firewall matches it)
- the user `wfos-apps` (no sudo group) with `~/incoming` (uploads) and the workspace public key in
  `~/.ssh/authorized_keys` (forwarding and pty disabled). Files in that home are written as the user, never by root
- folders: `/srv/wfos-apps` (the apps), `/etc/wfos-apps/{env,start,htpasswd}` (app config, root-owned),
  `/var/lib/wfos-apps` (certificate counter)
- a separate PostgreSQL cluster `apps` on port 5433 for the apps' databases. It has **no TCP at all**: its only
  socket is `/run/wfos-apps-pg/.s.PGSQL.5433` (folder `postgres:wfos-app-run 0750`, recreated at boot by
  `/etc/tmpfiles.d/wfos-apps-pg.conf`), set in `/etc/postgresql/<v>/apps/conf.d/90-wfos-apps.conf`. Its
  `pg_hba.conf` lets `postgres` in by peer, and each app role only into its own database through its own peer map
  (`pg_ident.conf`: the app's OS user `wa-<app>` and `postgres`, which the helper uses to dump and restore the app's
  database *as the app role*; no superuser session ever runs inside an app's database). Every other OS user is
  refused, even with the password. App roles have `CONNECTION LIMIT 10` and 60 s `statement_timeout` /
  `idle_in_transaction_session_timeout` (a session may raise its own). No statement is logged
  (`log_statement = none`, `log_min_error_statement = panic`), so a role password never lands in a log.
  `CONNECT` on `postgres` and `template1` is revoked from `PUBLIC`. Your other PostgreSQL clusters are not touched
- the app firewall: `/etc/wfos-apps/nftables.conf` holds its own table `inet wfos_apps` (no other table is ever
  flushed or changed), loaded now and at every boot by `wfos-apps-firewall.service`:
  - processes of group `wfos-app-run` may answer connections and use DNS (127.0.0.53 and the resolvers in
    `/etc/resolv.conf`), and reach the public internet (npm during builds). They cannot open connections to any
    address of this host (`fib daddr type local`, so also after an address change), 127.0.0.0/8, ::1, 0.0.0.0,
    private networks (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (incl. cloud metadata), CGNAT
    (100.64/10), multicast/broadcast, 168.63.129.16, 192.0.0.0/24, 198.18.0.0/15 or NAT64 (64:ff9b::/96). So an app
    cannot reach your production database, Redis, the Workforce OS web app or another app's port
  - ports 4100–4499 (the apps) answer loopback only, so the outside world reaches an app through nginx only
- `wfos-apps.slice`: every app and every build runs in it, so together they never use more than 40 % of the
  memory (throttled from 35 %), two CPUs and 2048 tasks, and they yield disk I/O. The helper also starts at most
  `--max-running` apps at once (default 3) and creates at most `--max-apps` apps (default 20)
- `/usr/local/sbin/wfos-app-helper` (installed from a root-only copy that was syntax-checked) and
  `/etc/sudoers.d/wfos-app-helper` (the user may run exactly that file as root;
  checked with `visudo` first), and `/etc/wfos-app-helper.conf`
- `/etc/nginx/conf.d/wfos-apps.conf` (a websocket map and `server_names_hash_bucket_size 512`, enough for any valid
  host name) and the catch-all site `wfos-apps-catchall` (names under the preview domain that no app owns: 404 over
  http, TLS handshake refused over https; it never covers live domains), then reloads nginx; ufw: allows 80 and 443
  when it is active

An earlier install (Phase A1) kept apps in `~wfos-apps/apps`. `prepare.sh` moves `APPS_ROOT` to `/srv/wfos-apps`,
turns the A1 `apps` cluster into a socket-only one (it restarts it once, only when the settings change), and
removes the old empty `~/apps` folder.

## Previews and live environments

Every command of the helper takes an **instance name**: the app's slug for its preview, `<slug>-live` for its live
environment (2 to 35 of `a-z 0-9 -`, starting with a letter, no `--`, not one of the reserved names `www api app apps
admin mail preview static assets cdn status`). Below, `<app>` means that instance name. A preview and the live
environment of the same app are two separate instances: their own user, folder, releases, env file, start script,
unit, port, nginx site, certificate and database (`app_<slug>_live`), so a preview never touches live data.

`publish <name> <port> [--auth] [--domain <fqdn> [--alias <fqdn>]...] [--index]` (options in any order):

- without `--domain`: the preview site `https://<name>.<preview domain>`, as before, `X-Robots-Tag: noindex`
- with `--domain`: a lower-case host name of at least two labels (no IP, no wildcard), never the preview domain or a
  name under it; up to three `--alias` names (e.g. `www.`) that answer with a permanent redirect (301) to
  `https://<domain>` over http and https. One Let's Encrypt certificate (`--cert-name <domain>`) covers the domain and
  every alias and counts once against the daily cap; when the set of names changes (an alias added or dropped) the
  certificate is requested again for exactly the new set
- `--index` leaves out `X-Robots-Tag: noindex` (a live site may be indexed); `--auth` adds basic auth (a bcrypt line
  on stdin), without it there is none
- every name is refused (`server_name_taken`, nothing is written) when another nginx site on this server already
  serves it; for live names also when another site's wildcard (`*.example.com`, `.example.com`, `www.example.*`)
  covers it. Each name needs an A/AAAA record pointing at this server before the certificate can be issued

Removing an instance (`app-remove <name> [--drop-db] [--keep-db-dump]`) also deletes its certificates (best effort,
`certbot delete`): the preview name's and the live domain it published (recorded in
`/var/lib/wfos-apps/domains/<name>`), so certbot never keeps renewing a site that is gone. A certificate another
instance records or another nginx site still serves is kept. Publishing a live environment under a new domain
deletes the old domain's certificate the same way, once the new site is in place.

### Database dumps kept on removal

`app-remove <name> --drop-db --keep-db-dump` first dumps the instance's database (`pg_dump -Fc` as its own role) to
`/var/lib/wfos-apps/removed/<name>-<UTC yyyymmddTHHMMZ>.dump` (root, 0600) and prints `kept database dump: <path>`
as its last line; when the dump fails nothing is removed. Dumps older than 30 days are deleted at the next such
removal. To restore one by hand (as root), into a fresh database of the apps cluster:

```bash
f=/var/lib/wfos-apps/removed/shop-live-20261014T0930Z.dump
psql() { runuser -u postgres -- /usr/lib/postgresql/<v>/bin/psql -h /run/wfos-apps-pg -p 5433 "$@"; }
psql -d postgres -c 'CREATE DATABASE restored_shop_live'
runuser -u postgres -- /usr/lib/postgresql/<v>/bin/pg_restore -h /run/wfos-apps-pg -p 5433 -d restored_shop_live \
  --no-owner --no-privileges --single-transaction < "$f"
```

(`pg_restore -l "$f"` lists what is in it; `pg_restore -f out.sql "$f"` turns it into plain SQL.) To give it back to
an app, deploy the app again (Workforce OS creates its role and database), then restore into that database with
`-d app_<name with _> --clean --if-exists --no-owner --no-privileges --single-transaction`.

## How an app runs

Each app instance gets its own system user `wa-<app>` (names over 28 characters: `wa-<first 19>-<8 hex of a hash>`) (no login shell, no home, only in `wfos-app-run`, uid/gid from the
range 460000–460999, comment `Workforce OS app <app>`; the helper never uses or deletes an account with that name
that lacks either). Its folder:

```
/srv/wfos-apps/<app>/          root      (the structure; the app cannot rename or replace anything in it)
  releases/<commit>/           wa-<app>  (unpacked and built by the app's own user)
  current -> releases/<commit> (switched by root, atomically)
  data/                        wa-<app>  (persistent files, $APP_DATA_DIR)
  cache/                       wa-<app>  (pnpm store, caches; also $HOME)
  next-cache/                  wa-<app>  (Next.js runtime cache, emptied when a new version is activated)
  backups/                     root      (database dumps, the newest 7)
```

The app runs as the systemd unit `wfos-app-<app>.service`; installs, builds and migrations run the same way as a
transient unit (`systemd-run`, as the app's user). Both get the same sandbox:

- the user `wa-<app>` with primary group `wfos-app-run`, no capabilities, `NoNewPrivileges`, `@system-service`
  system calls only (without io_uring and userfaultfd), IPv4/IPv6/unix sockets only, no new namespaces,
  `UMask=0077`; the unit does not start (`ExecStartPre`) and builds do not run while the app firewall is not loaded
- its own view of the files: `/srv/wfos-apps` is empty except its own folder (read-only; a build may also write its
  release), `data/` and `cache/` writable, and for a Next.js app `next-cache/` mounted on the running release's
  `.next/cache` (images, ISR, fetch cache; the release itself stays read-only), the rest of the system read-only
  (`ProtectSystem=strict`). `/run` and `/opt` are empty except the DNS stub resolver (`/run/systemd/resolve`), the
  shared pnpm (`/opt/wfos-apps/corepack`) and, when the app has a database (or for a migrate step), the apps
  cluster socket: no sockets of PostgreSQL, Redis, Docker or D-Bus. No `/home`, `/root`, `/etc/nginx`,
  `/etc/letsencrypt`, `/etc/wfos-apps` (except its own start script), `/var/log`, `/var/www`, `/var/lib/cloud`,
  `/mnt`, `/media`, `/usr/local/sbin`
- other processes are invisible (`ProtectProc=invisible`, `ProcSubset=pid`, `PrivatePIDs` on systemd 257+),
  private `/tmp` and devices
- limits: memory (the app's own limit, a build 1.5 GB; never more than half the server's memory), no swap, one CPU,
  256 tasks, 4096 open files, files of at most 2 GB, `OOMScoreAdjust=500` (the kernel picks an app before anything
  else), all inside `wfos-apps.slice`; a build also has a time limit, a lower priority and no network access to
  loopback or private ranges at all (systemd `IPAddressDeny`, DNS excepted). Unpacking, installs, builds and
  starting an app stop when less than 2 GB disk is free
- the app listens on `127.0.0.1:<port>` (`HOST`, `PORT`) and may bind only that port; nginx publishes a preview at
  `https://<app>.<domain>` with a Let's Encrypt certificate (at most 10 new certificates a day), HSTS,
  `X-Robots-Tag: noindex` and, by default, a preview password (basic auth; Workforce OS sends only a bcrypt hash),
  and a live environment at its own domain (see above)

**Disk (residual risk).** There is no per-app disk quota (it needs a filesystem of its own per app): a running app
can fill the disk through `data/` or `next-cache/` (files are capped at 2 GB each, not in total). The 2 GB guard
stops new unpacks, builds and starts, and Workforce OS reads `diskFreeMb` from `info` every hour; for real
isolation put `/srv/wfos-apps` on its own partition or volume.

Env values (`/etc/wfos-apps/env/<app>.env`, root 0600) and the start command (`/etc/wfos-apps/start/<app>.sh`) come
from Workforce OS on stdin and are written by root to root-owned files; root never reads a file the app or the SSH
user could have planted. Uploads are read by `wfos-apps` and unpacked by `wa-<app>`; archives with absolute or `..`
names, links leaving the release, special files or more than 200 000 entries are refused, and unpacking runs in a
memory-, task- and time-limited scope. The nginx site strips the `Authorization` header before the app (the
preview password stays nginx's), and its http→https redirect always names the app's own domain.

**Use a dedicated domain for previews.** An app can set cookies for its parent domains up to the registrable one.
When the preview domain shares that with other sites (e.g. `preview.example.com` next to `app.example.com`), apps
can toss cookies at them; `prepare.sh` warns loudly when it finds such a site in `nginx -T`. Prefer a domain of
its own (e.g. `example-previews.com`).

## Steps

1. In Workforce OS: **Settings → Servers → Add server**. Copy the prepare command it shows (it contains the
   workspace public key and your domain).
2. Make sure DNS `*.<your domain>` points at the server (for example `*.preview.example.com`). A live domain (and
   each alias) needs its own A/AAAA record pointing at the server; Workforce OS checks it before it publishes.
3. Copy both files to the server, next to each other, and run the command as root. Try it first with `--dry-run`
   (prints every action, changes nothing):

   ```bash
   sudo bash prepare.sh --public-key 'ssh-ed25519 AAAA… wfos-yourworkspace' --domain preview.example.com --dry-run
   sudo bash prepare.sh --public-key 'ssh-ed25519 AAAA… wfos-yourworkspace' --domain preview.example.com
   ```

   Options: `--user` (default `wfos-apps`), `--pg-port` (default `5433`), `--node-major` (default `24`),
   `--pnpm-version` (default `10.33.0`; the apps' `packageManager` should name the same version), `--max-running`
   (default `3`), `--max-apps` (default `20`).
4. It ends with the server's SSH host key fingerprint and `WFOS_SERVER_READY`. Back in Workforce OS press **Scan**,
   check that the fingerprint shown there is exactly the one printed here (or run
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then **Confirm & verify**.

If the fingerprints differ, do not confirm: you are not talking to that server.

Re-run `prepare.sh` when the server's DNS resolvers change (the firewall lists them).

## Removing it

```bash
sudo rm -f /etc/sudoers.d/wfos-app-helper /usr/local/sbin/wfos-app-helper   # Workforce OS loses root at once
sudo systemctl disable --now 'wfos-app-*'                                    # stop the apps
sudo systemctl disable --now wfos-apps-firewall.service                      # removes the nft table
sudo deluser --remove-home wfos-apps                                         # and remove the login
```

Then, if you want: delete the app users (`getent passwd | grep '^wa-.*:Workforce OS app '`, then `userdel` and
`groupdel` each) and
the group `wfos-app-run`; `pg_dropcluster --stop <version> apps`; remove `/srv/wfos-apps`, `/etc/wfos-apps`,
`/var/lib/wfos-apps` (also the kept database dumps in `removed/`), `/opt/wfos-apps`, `/etc/tmpfiles.d/wfos-apps-pg.conf`,
`/etc/systemd/system/wfos-app-*.service`, `/etc/systemd/system/wfos-apps-firewall.service`,
`/etc/systemd/system/wfos-apps.slice`, `/etc/apt/sources.list.d/nodesource.list`,
`/etc/nginx/sites-*/wfos-app-*`, `/etc/nginx/sites-*/wfos-apps-catchall`, `/etc/nginx/conf.d/wfos-apps.conf` (and the
A1 folder `/etc/nginx/wfos-apps`) and `/etc/wfos-app-helper.conf`. Certificates stay in `/etc/letsencrypt`
(`certbot delete --cert-name <app>.<domain>`, and `--cert-name <live domain>` for a live environment).

## Tests

`bash deploy/app-server/test/app-server.sh` runs both scripts in dry-run mode only, against a temporary config,
APPS_ROOT and system prefix (nothing is installed, run as root or changed).
