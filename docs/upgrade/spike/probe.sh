#!/bin/bash
# Boundary probe: run inside a candidate sandbox. Prints one line per check: ALLOWED / blocked.
W=${WORKER_PID:-1}
try() { local label="$1"; shift; if out=$(timeout 5 bash -o pipefail -c "$*" 2>&1); then echo "ALLOWED  $label ${out:0:80}"; else echo "blocked  $label (${out:0:70})"; fi; }
tcp() { try "connect $1:$2" "exec 3<>/dev/tcp/$1/$2"; }
echo "identity: $(id)"
try "list /root"                       "ls /root"
try "read app .env"                    "wc -c < /root/apps/workforce-os/.env | tr -d '\n' && echo ' bytes readable'"
try "read worktree .env"               "wc -c < /root/apps/workforce-os-v2/.env | tr -d '\n' && echo ' bytes readable'"
try "read /proc/1/environ"             "wc -c < /proc/1/environ | tr -d '\n' && echo ' bytes readable'"
try "read /proc/$W/environ (worker)"   "wc -c < /proc/$W/environ | tr -d '\n' && echo ' bytes readable'"
try "see worker process"               "test -d /proc/$W && cat /proc/$W/cmdline | head -c 40"
try "read /etc/shadow"                 "wc -c < /etc/shadow | tr -d '\n' && echo ' bytes readable'"
try "read postgres socket dir"         "ls /var/run/postgresql"
tcp 127.0.0.1 5432
tcp 127.0.0.1 6379
try "redis PING without password"      "exec 3<>/dev/tcp/127.0.0.1/6379; printf 'PING\r\n' >&3; timeout 2 head -c 7 <&3"
tcp 127.0.0.1 3010
tcp 1.1.1.1 443
try "DNS lookup example.com"           "getent hosts example.com"
try "write /etc"                       "touch /etc/wfos-probe && rm /etc/wfos-probe"
try "write /root"                      "touch /root/wfos-probe && rm /root/wfos-probe"
try "write /var/tmp"                   "touch /var/tmp/wfos-probe && rm /var/tmp/wfos-probe"
try "write /tmp (private?)"            "touch /tmp/wfos-probe && rm /tmp/wfos-probe"
try "write workspace"                  "touch \$PWD/file && echo \$PWD"
try "write .git/hooks in workspace"    "git init -q . && printf '#!/bin/sh\necho pwned\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit"
try "list other workspaces"            "ls /var/lib/wfos-spike-ws 2>&1 || ls /var/lib/private"
try "sudo"                             "sudo -n true"
try "setuid binary (su)"               "su -c true root </dev/null"
try "postgres via unix socket (peer auth)" "psql -h /var/run/postgresql -U postgres -Atc 'select 1' 2>&1 | grep -qx 1"
try "postgres via unix socket as workforce"  "psql -h /var/run/postgresql -U workforce -d workforce_os -Atc 'select 1' 2>&1 | grep -qx 1"
try "allocate 400 MB"                  "python3 -c 'b=bytearray(400*1024*1024); print(len(b))'"
echo "probe finished"
