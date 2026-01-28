'use strict';

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message || 'Error');
    this.name = 'HttpError';
    this.status = status || 500;
    this.code = code || 'ERR';
    this.details = details;
  }
}

function badRequest(message, code, details) {
  return new HttpError(400, message || 'Bad Request', code || 'BAD_REQUEST', details);
}
function unauthorized(message, code, details) {
  return new HttpError(401, message || 'Unauthorized', code || 'UNAUTHORIZED', details);
}
function forbidden(message, code, details) {
  return new HttpError(403, message || 'Forbidden', code || 'FORBIDDEN', details);
}
function notFound(message, code, details) {
  return new HttpError(404, message || 'Not Found', code || 'NOT_FOUND', details);
}
function conflict(message, code, details) {
  return new HttpError(409, message || 'Conflict', code || 'CONFLICT', details);
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
