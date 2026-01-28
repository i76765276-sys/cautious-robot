'use strict';

const { HttpError } = require('../lib/httpError');

function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const isHttp = err instanceof HttpError;
    const status = isHttp ? err.status : 500;

    // Known noisy error from cors origin function
    const msg = (err && err.message) ? String(err.message) : 'Internal Server Error';

    const payload = {
      ok: false,
      error: {
        code: isHttp ? err.code : 'INTERNAL',
        message: status === 500 ? 'Internal Server Error' : msg
      },
      requestId: req.id
    };

    if (process.env.NODE_ENV !== 'production') {
      payload.error.debug = {
        message: msg,
        stack: err && err.stack ? String(err.stack) : undefined
      };
    }

    // eslint-disable-next-line no-console
    if (status >= 500) console.error('[api] error:', err);

    res.status(status).json(payload);
  };
}

module.exports = { errorHandler };
