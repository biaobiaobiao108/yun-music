module.exports = {
  apps: [
    {
      name: 'yun-music',
      script: './server/index.js',
      interpreter: 'bun',
      max_memory_restart: '1024M',
      stop_exit_codes: [0],
      exp_backoff_restart_delay: 100,
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'data'],
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
}
