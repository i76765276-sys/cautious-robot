'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { initDb } = require('./db');
const { requestId } = require('./middleware/requestId');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');
const { makeRouter } = require('./routes');

function createApp({ dbPath, corsOrigins, trustProxy }) {
  if (!dbPath) throw new Error('createApp: dbPath required');
  if (!Array.isArray(corsOrigins)) throw new Error('createApp: corsOrigins must be array');

  const app = express();

  // If behind a reverse proxy you must set this so req.ip / rate-limit works correctly
  app.set('trust proxy', !!trustProxy);

  // Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));

  // Request id for correlation (also returned in responses)
  app.use(requestId());

  // Logging (with request id)
  app.use(morgan(':method :url :status :res[content-length] - :response-time ms rid=:req[x-request-id]'));

  // Body parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Compression
  app.use(compression());

  // CORS
  app.use(cors({
    origin: (origin, cb) => {
      // Allow non-browser clients without Origin header
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS blocked'), false);
    },
    credentials: true,
    maxAge: 86400
  }));

  // Basic rate limiting (tune as needed)
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown'
  }));

  // DB
  const db = initDb(dbPath);

  // Routes
  app.use(makeRouter({ db }));

  // 404 + errors
  app.use(notFound());
  app.use(errorHandler());

  return app;
}

module.exports = { createApp };
