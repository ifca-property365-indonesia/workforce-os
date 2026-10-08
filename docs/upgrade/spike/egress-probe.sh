SOCK=/run/wfos-spike/egress.sock /opt/node/bin/node /run/wfos-spike/bridge.mjs & sleep 0.5
c() { printf "%-48s " "$1"; shift; out=$(curl -sS -o /dev/null -w "HTTP %{http_code}" --max-time 10 "$@" 2>&1); echo "${out:0:90}"; }
c "direct https://example.com (no proxy)"        https://example.com/
c "direct https://api.anthropic.com (no proxy)"  https://api.anthropic.com/
c "via proxy https://api.anthropic.com/"         -x http://127.0.0.1:3128 https://api.anthropic.com/
c "via proxy https://example.com/"               -x http://127.0.0.1:3128 https://example.com/
c "via proxy https://github.com/"                -x http://127.0.0.1:3128 https://github.com/
c "via proxy http://api.anthropic.com/ (plain)"  -x http://127.0.0.1:3128 http://api.anthropic.com/
c "via proxy CONNECT 127.0.0.1:6379 (redis)"     -x http://127.0.0.1:3128 -p http://127.0.0.1:6379/
c "via proxy https://169.254.169.254/"           -x http://127.0.0.1:3128 https://169.254.169.254/
