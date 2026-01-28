'use strict';

const crypto = require('crypto');

function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const rid = (incoming && String(incoming).trim()) || crypto.randomUUID();
    req.id = rid;
    res.setHeader('x-request-id', rid);
    next();
  };
}

module.exports = { requestId };
