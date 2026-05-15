module.exports = {
  apps: [
    {
      name: 'server-monitor-bot',
      script: './index.js',
      cwd: __dirname,
      watch: false,
      max_memory_restart: '300M',
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
