'use strict';

function notFound() {
  return (req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        path: req.originalUrl
      },
      requestId: req.id
    });
  };
}

module.exports = { notFound };
