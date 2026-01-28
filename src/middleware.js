"use strict";


const { adminEmail } = require("./envConfig");
const { cookieOptions, expiryMsForRemember } = require("./security");

/**
 * This middleware uses the Supabase sessions table as the source of truth.
 * It reads the sid cookie, loads the session, refreshes last_seen/expires_at, and sets req.user.
 */
function createAuthMiddleware({ supabase }) {
  async function loadUserFromSession(req, res, next) {
    try {
      const sid = String(req.cookies?.sid || "");
      if (!sid) {
        req.user = null;
        req.sessionRow = null;
        return next();
      }

      const { data: row, error } = await supabase
        .from("sessions")
        .select("*")
        .eq("sid", sid)
        .maybeSingle();

      if (error) {
        console.error(error);
        res.clearCookie("sid", { path: "/" });
        req.user = null;
        req.sessionRow = null;
        return next();
      }

      if (!row) {
        res.clearCookie("sid", { path: "/" });
        req.user = null;
        req.sessionRow = null;
        return next();
      }

      const now = Date.now();
      const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : NaN;

      // Treat missing/invalid expiry as expired.
      if (!Number.isFinite(expiresAtMs) || expiresAtMs < now) {
        await supabase.from("sessions").delete().eq("sid", sid);
        res.clearCookie("sid", { path: "/" });
        req.user = null;
        req.sessionRow = null;
        return next();
      }

      const rememberMe = !!row.remember_me;
      const newExp = new Date(now + expiryMsForRemember(rememberMe)).toISOString();

      await supabase
        .from("sessions")
        .update({ last_seen: new Date(now).toISOString(), expires_at: newExp })
        .eq("sid", sid);

      res.cookie("sid", sid, cookieOptions(process.env.NODE_ENV === "production", rememberMe));

      req.user = {
        uuid: row.user_uuid,
        username: row.username,
        email: row.email,
        device_tag: row.device_tag,
      };
      req.sessionRow = row;

      return next();
    } catch (err) {
      console.error(err);
      req.user = null;
      req.sessionRow = null;
      return next();
    }
  }

  function requireAuth(req, res, next) {
    if (req.user) return next();
    return res.redirect("/login");
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return res.redirect("/login");
    if (!adminEmail) return res.status(403).send("Admin not configured");
    if (String(req.user.email || "").toLowerCase() !== adminEmail) return res.status(403).send("Forbidden");
    return next();
  }

  return { loadUserFromSession, requireAuth, requireAdmin };
}

module.exports = { createAuthMiddleware };
