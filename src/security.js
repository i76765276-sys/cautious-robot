"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const { sessionDays, sessionHoursNoRemember } = require("./envConfig");

function makeUserUuid() {
  return crypto.randomUUID();
}

function makeSessionId() {
  return crypto.randomBytes(48).toString("base64url");
}

function hashPassword(password) {
  const salt = bcrypt.genSaltSync(12);
  return bcrypt.hashSync(password, salt);
}

function verifyPassword(password, passwordHash) {
  return bcrypt.compareSync(password, passwordHash);
}

function msFromDays(days) {
  return Math.max(1, Number(days || 1)) * 24 * 60 * 60 * 1000;
}

function msFromHours(hours) {
  return Math.max(1, Number(hours || 1)) * 60 * 60 * 1000;
}

function getDeviceTag(req) {
  const ua = String(req.headers["user-agent"] || "Unknown");
  const short = ua.length > 80 ? ua.slice(0, 80) + "…" : ua;
  return short.replace(/[\n\r\t]/g, " ");
}

function cookieOptions(isProd, rememberMe = true) {
  const base = {
    httpOnly: true,
    sameSite: "lax",
    secure: !!isProd,
    path: "/",
  };
  if (rememberMe) return { ...base, maxAge: msFromDays(sessionDays) };
  return base; // session cookie
}


function expiryMsForRemember(rememberMe) {
  return rememberMe ? msFromDays(sessionDays) : msFromHours(sessionHoursNoRemember);
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

module.exports = {
  makeUserUuid,
  makeSessionId,
  hashPassword,
  verifyPassword,
  msFromDays,
  msFromHours,
  getDeviceTag,
  cookieOptions,
  expiryMsForRemember,
  sha256Hex,
  randomToken,
};
