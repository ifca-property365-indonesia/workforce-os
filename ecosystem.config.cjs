// PM2 process file for a native (non-Docker) deployment.
module.exports = {
  apps: [
    {
      name: "wfos-web",
      cwd: __dirname + "/apps/web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3010 -H 127.0.0.1",
      env: { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=384" },
      max_memory_restart: "450M",
      time: true,
    },
    {
      name: "wfos-worker",
      cwd: __dirname + "/apps/worker",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      env: { NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=512" },
      max_memory_restart: "700M",
      kill_timeout: 15000,
      time: true,
    },
  ],
};
