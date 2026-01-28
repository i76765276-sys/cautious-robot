'use strict';

const express = require('express');

function healthRoutes() {
  const r = express.Router();

  r.get('/', (req, res) => {
    res.json({
      ok: true,
      status: 'up',
      now: new Date().toISOString(),
      requestId: req.id
    });
  });

  return r;
}

module.exports = { healthRoutes };
