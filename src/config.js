"use strict";

const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  sessionSecret: process.env.SESSION_SECRET || "dev_secret_change_me",
  sessionDays: Number(process.env.SESSION_DAYS || 7),
  sessionHoursNoRemember: Number(process.env.SESSION_HOURS_NO_REMEMBER || 8),

  adminEmail: String(process.env.ADMIN_EMAIL || "").trim().toLowerCase(),

  siteName: process.env.WRLD_SITE_NAME || "WRLD ENT",
  serverName: process.env.WRLD_SERVER_NAME || "WRLD Ent Discord Server",
  tagline: process.env.WRLD_TAGLINE || "Community • Tools • Bots • Builds",
};

module.exports = { config };
