const os = require("os");

const cpuCount = os.cpus().length;
const workers = Number(process.env.PM2_INSTANCES) || Math.min(Math.max(cpuCount - 1, 2), 4);

module.exports = {
  apps: [
    {
      name: "offers-api",
      script: "server.js",
      cwd: __dirname,
      instances: workers,
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "750M",
      listen_timeout: 10000,
      kill_timeout: 8000,
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
      },
      merge_logs: true,
      time: true,
      instance_var: "NODE_APP_INSTANCE",
    },
  ],
};
