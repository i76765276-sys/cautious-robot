'use strict';

const http = require('http');
const { createApp } = require('./app');
const { mustEnv, envInt, envBool } = require('./lib/env');

function main() {
  // Load env from .env (safe even if missing in production)
  require('dotenv').config();

  const PORT =  3001;
  const TRUST_PROXY = envBool('TRUST_PROXY', false);

  // Required envs for prod readiness
  const DB_PATH = mustEnv('DB_PATH');
  const CORS_ORIGINS = mustEnv('CORS_ORIGINS');

  const app = createApp({
    dbPath: DB_PATH,
    corsOrigins: CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
    trustProxy: TRUST_PROXY
  });

  const server = http.createServer(app);

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${PORT} (node=${process.version}, env=${process.env.NODE_ENV || 'development'})`);
  });

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`[api] ${signal} received, shutting down...`);
    server.close((err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('[api] shutdown error:', err);
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.log('[api] closed.');
      process.exit(0);
    });

    // Force exit if hanging
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
