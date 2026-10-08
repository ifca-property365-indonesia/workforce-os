// PM2 process file for a native (non-Docker) deployment: pm2 start ecosystem.config.cjs
//
// There is no separate wfos-runner process: the worker starts each Workspace-mode run as a short-lived systemd unit
// with its own dynamic user (docs/upgrade/DECISIONS.md D27). The worker therefore runs as root on a native install.
//
// WFOS_WEB_INSTANCES=2 runs the web app in cluster mode, so `pm2 reload` (deploy/upgrade.sh) swaps instances one at a
// time without dropping requests. One instance (the default, for 2 GB hosts) restarts in place: a few seconds down.
const webInstances = Math.max(1, Number(process.env.WFOS_WEB_INSTANCES || 1));

module.exports = {
  apps: [
    {
      name: "wfos-web",
      cwd: __dirname + "/apps/web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3010 -H 127.0.0.1",
      instances: webInstances,
      exec_mode: webInstances > 1 ? "cluster" : "fork",
      env: { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=384" },
      max_memory_restart: "450M",
      kill_timeout: 8000,
      time: true,
    },
    {
      name: "wfos-worker",
      cwd: __dirname + "/apps/worker",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      env: { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=512" },
      max_memory_restart: "700M",
      // graceful stop: BullMQ workers close; deploy/upgrade.sh waits until no agent run is active first
      kill_timeout: 15000,
      time: true,
    },
  ],
};
