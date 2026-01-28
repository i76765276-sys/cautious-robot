'use strict';

const express = require('express');

const { healthRoutes } = require('./health');
const { usersRoutes } = require('./users');

function makeRouter({ db }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'api-server',
      version: '1.0.0',
      requestId: req.id
    });
  });

  router.use('/health', healthRoutes());
  router.use('/v1/users', usersRoutes({ db }));

  return router;
}

module.exports = { makeRouter };
