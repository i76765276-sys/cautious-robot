"use strict";

const crypto = require("crypto");

function generateApiKey(prefix = "wrld") {
  const token = crypto.randomBytes(32).toString("base64url");
  return `${prefix}_${token}`;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return "••••••••••••";
  return `${key.slice(0, 6)}••••••••••${key.slice(-6)}`;
}

module.exports = { generateApiKey, maskKey };
