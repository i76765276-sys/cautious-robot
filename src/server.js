
function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function makeApiKey() {
  // User-facing key. Store only a hash in the database.
  return "wrld_" + base64url(crypto.randomBytes(32));
}

function maskKeyFromPrefix(prefix) {
  const p = String(prefix || "").trim();
  if (!p) return "••••••••••••";
  return p.slice(0, 14) + "••••••••••••";
}

function keyPrefixFromKey(fullKey) {
  const k = String(fullKey || "");
  if (!k) return "";
  return k.slice(0, 14);
}

"use strict";

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server: SocketIOServer } = require("socket.io");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");

require('../tools/WSD/app')
require('../tools/WPH/deploy-commands')
require('../tools/WPH/index')
require('../tools/API/server')
const { siteName, sessionSecret, serverName, sessionDays, sessionHoursNoRemember, adminEmail, tagline, port,baseUrl } = require('./envConfig')
const { createServerSupabase } = require("./supabase");
const {
  makeUserUuid,
  makeSessionId,
  hashPassword,
  verifyPassword,
  getDeviceTag,
  cookieOptions,
  expiryMsForRemember,
  randomToken,
} = require("./security");
const { createAuthMiddleware } = require("./middleware");
const { generateApiKey, maskKey } = require("./keys");

// PostgREST filter helper for `.or(...)` clauses.
// Wrap values in double quotes and escape internal quotes.
function pgText(val) {
  const s = String(val ?? "");
  return `"${s.replace(/"/g, "\\\"")}"`;
}


const dataDir = path.join(__dirname, "..", "data");
const downloadsDir = path.join(dataDir, "downloads");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const seedDownloadsDir = path.join(__dirname, "..", "seed", "downloads");
function seedDownloads() {
  try {
    if (!fs.existsSync(seedDownloadsDir)) return;
    const seeds = fs.readdirSync(seedDownloadsDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);

    for (const name of seeds) {
      const src = path.join(seedDownloadsDir, name);
      const dst = path.join(downloadsDir, name);
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  } catch (err) {
    console.error("seedDownloads error:", err);
  }
}
seedDownloads();


const supabase = createServerSupabase();
const { loadUserFromSession, requireAuth, requireAdmin } = createAuthMiddleware({ supabase });

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(isProd ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(sessionSecret));

app.use("/assets", express.static(path.join(__dirname, "..", "public", "assets"), {
  maxAge: isProd ? "7d" : 0,
  etag: true,
  lastModified: true,
}));

// SQLite persistent session loader
app.use(loadUserFromSession);

// Realtime (Socket.IO) — dashboard updates when Device Agent reports in.
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { serveClient: true });

function parseCookieHeader(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

io.use(async (socket, next) => {
  try {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie || "");
    const sid = String(cookies.sid || "");
    if (!sid) return next(new Error("unauthorized"));

    const { data: row } = await supabase.from("sessions").select("*").eq("sid", sid).maybeSingle();
    if (!row) return next(new Error("unauthorized"));

    const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return next(new Error("unauthorized"));

    socket.data.user_uuid = row.user_uuid;
    return next();
  } catch {
    return next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userUuid = socket.data.user_uuid;
  if (userUuid) socket.join(String(userUuid));
});

// View locals + flash message
app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.year = new Date().getFullYear();
  res.locals.siteName = siteName;
  res.locals.serverName = serverName;
  res.locals.tagline = tagline;
  res.locals.user = req.user || null;
  res.locals.isAdmin = req.user && adminEmail && String(req.user.email).toLowerCase() === adminEmail;

  // Humanized helpers
  const hr = new Date().getHours();
  res.locals.greeting =
    hr < 5 ? "Up late?" :
    hr < 12 ? "Good morning" :
    hr < 18 ? "Good afternoon" :
    "Good evening";

  res.locals.humanTip = (kind) => {
    const tips = {
      home: [
        "If you’re new here, start with Register. You’ll land in the dashboard right away.",
        "Everything you do is visible: you can view and revoke active sessions at any time.",
        "Keep this tab open while you set things up—your dashboard will guide you."
      ],
      dash: [
        "Installed Apps appears after your device connects. Once it’s linked, the list updates any time you send a report.",
        "API keys are shown once when created—copy them right away and keep them private.",
        "Need to lock things down? Visit Sessions and revoke anything you don’t recognize."
      ],
      auth: [
        "Use a password you don’t reuse elsewhere. A password manager makes this easy.",
        "Uncheck “Remember me” if you’re signing in on a shared computer.",
        "If you ever think your account is at risk, revoke sessions and reset your password."
      ],
      downloads: [
        "If nothing shows yet, it just means there aren’t any downloads published right now.",
        "Check back later—new downloads appear here as soon as they’re available."
      ],
      sessions: [
        "If anything looks unfamiliar, revoke it. You can always sign in again.",
        "Revoking your current session will log you out right away."
      ],
      admin: [
        "Announcements should be short and clear—people scan before they read.",
        "If someone reports trouble signing in, you can revoke their sessions so they can start fresh."
      ],
    };
    const list = tips[kind] || tips.home;
    return list[Math.floor(Math.random() * list.length)];
  };


  try {
    res.locals.flash = req.cookies?.flash ? JSON.parse(req.cookies.flash) : null;
  } catch {
    res.locals.flash = null;
  }
  if (req.cookies?.flash) res.clearCookie("flash", { path: "/" });

  next();
});

function setFlash(res, type, text, extra = null) {
  const payload = { type, text };
  if (extra && typeof extra === "object") Object.assign(payload, extra);
  res.cookie("flash", JSON.stringify(payload), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10_000,
  });
}

// Pages
app.get("/", (req, res) => res.render("pages/home", { title: "Home" }));
app.get("/about", (req, res) => res.render("pages/about", { title: "About" }));

// Downloads
app.get("/downloads", (req, res) => {
  const items = fs.readdirSync(downloadsDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const full = path.join(downloadsDir, d.name);
      const stat = fs.statSync(full);
      return { name: d.name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  res.render("pages/downloads", { title: "Downloads", items });
});

app.get("/download/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return res.status(400).send("Invalid file name");
  const full = path.join(downloadsDir, name);
  if (!fs.existsSync(full)) return res.status(404).send("File not found");
  return res.download(full);
});

// Auth pages
app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/dash");
  return res.render("pages/login", { title: "Login" });
});

app.get("/register", (req, res) => {
  if (req.user) return res.redirect("/dash");
  return res.render("pages/register", { title: "Register" });
});

app.get("/forgot", (req, res) => {
  if (req.user) return res.redirect("/dash");
  return res.render("pages/forgot", { title: "Reset Password" });
});

// Register (creates user + creates session)
app.post("/register", async (req, res) => {
  try {
    if (req.user) return res.redirect("/dash");

    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const rememberMe = String(req.body.remember || "") === "on";

    if (!username || username.length < 3 || username.length > 24) {
      setFlash(res, "danger", "Username must be 3-24 characters.");
      return res.redirect("/register");
    }
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(username)) {
      setFlash(res, "danger", "Username may contain letters, numbers, _ - . only.");
      return res.redirect("/register");
    }
    if (!email || email.length > 120 || !email.includes("@")) {
      setFlash(res, "danger", "Enter a valid email address.");
      return res.redirect("/register");
    }
    if (!password || password.length < 8 || password.length > 72) {
      setFlash(res, "danger", "Password must be 8-72 characters.");
      return res.redirect("/register");
    }

    const { data: existing, error: existErr } = await supabase
      .from("users")
      .select("uuid")
      .or(`username.eq.${pgText(username)},email.eq.${pgText(email)}`)
      .maybeSingle();

    if (existErr) console.error(existErr);

    if (existing) {
      setFlash(res, "danger", "Username or email already registered.");
      return res.redirect("/register");
    }

    const userUuid = makeUserUuid();
    const passHash = hashPassword(password);
    const nowIso = new Date().toISOString();

    const { error: insErr } = await supabase.from("users").insert([
      { uuid: userUuid, username, email, password_hash: passHash, created_at: nowIso },
    ]);

    if (insErr) {
      console.error(insErr);
      setFlash(res, "danger", "Registration failed.");
      return res.redirect("/register");
    }

    const sid = makeSessionId();
    const deviceTag = getDeviceTag(req);
    const expiresAtIso = new Date(Date.now() + expiryMsForRemember(rememberMe)).toISOString();

    const { error: sessErr } = await supabase.from("sessions").insert([
      {
        sid,
        user_uuid: userUuid,
        username,
        email,
        device_tag: deviceTag,
        remember_me: rememberMe,
        created_at: nowIso,
        last_seen: nowIso,
        expires_at: expiresAtIso,
      },
    ]);

    if (sessErr) {
      console.error(sessErr);
      setFlash(res, "danger", "Registration failed.");
      return res.redirect("/register");
    }

    res.cookie("sid", sid, cookieOptions(isProd, rememberMe));
    setFlash(res, "good", "Account created. You’re signed in.");
    return res.redirect("/dash");
  } catch (err) {
    console.error(err);
    setFlash(res, "danger", "Registration failed.");
    return res.redirect("/register");
  }
});

// Login (creates new session row)
app.post("/login", async (req, res) => {
  try {
    if (req.user) return res.redirect("/dash");

    const login = String(req.body.login || "").trim();
    const password = String(req.body.password || "");
    const rememberMe = String(req.body.remember || "") === "on";

    if (!login || !password) {
      setFlash(res, "danger", "Enter your username/email and password.");
      return res.redirect("/login");
    }

    const loginLower = login.toLowerCase();

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .or(`username.eq.${pgText(login)},email.eq.${pgText(loginLower)}`)
      .maybeSingle();

    if (error) console.error(error);

    if (!user) {
      setFlash(res, "danger", "Invalid login.");
      return res.redirect("/login");
    }

    if (!verifyPassword(password, user.password_hash)) {
      setFlash(res, "danger", "Invalid login.");
      return res.redirect("/login");
    }

    const nowIso = new Date().toISOString();
    const sid = makeSessionId();
    const deviceTag = getDeviceTag(req);
    const expiresAtIso = new Date(Date.now() + expiryMsForRemember(rememberMe)).toISOString();

    const { error: sessErr } = await supabase.from("sessions").insert([
      {
        sid,
        user_uuid: user.uuid,
        username: user.username,
        email: user.email,
        device_tag: deviceTag,
        remember_me: rememberMe,
        created_at: nowIso,
        last_seen: nowIso,
        expires_at: expiresAtIso,
      },
    ]);

    if (sessErr) {
      console.error(sessErr);
      setFlash(res, "danger", "Login failed.");
      return res.redirect("/login");
    }

    res.cookie("sid", sid, cookieOptions(isProd, rememberMe));
    setFlash(res, "good", "Welcome back. You’re signed in.");
    return res.redirect("/dash");
  } catch (err) {
    console.error(err);
    setFlash(res, "danger", "Login failed.");
    return res.redirect("/login");
  }
});

// Logout (deletes session row)
app.get("/logout", async (req, res) => {
  try {
    const sid = String(req.cookies?.sid || "");
    if (sid) await supabase.from("sessions").delete().eq("sid", sid);
  } catch (err) {
    console.error(err);
  }
  res.clearCookie("sid", { path: "/" });
  setFlash(res, "good", "Logged out.");
  return res.redirect("/");
});

// Forgot password: create reset token (shown for testing)
app.post("/forgot", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setFlash(res, "danger", "Enter a valid email.");
      return res.redirect("/forgot");
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (error) console.error(error);

    // For privacy, don't reveal whether the email exists.
    if (!user) {
      setFlash(res, "good", "If that email matches an account, you’ll be taken to set a new password.");
      return res.redirect("/forgot");
    }

    const token = randomToken();
    const tokenHash = sha256Hex(token);
    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + 1000 * 60 * 20).toISOString(); // 20 minutes

    const { error: insErr } = await supabase.from("password_resets").insert([
      { user_uuid: user.uuid, token_hash: tokenHash, created_at: nowIso, expires_at: expiresAtIso, used_at: null },
    ]);

    if (insErr) {
      // Some Postgres clients dislike explicit null; handle by retrying without used_at
      console.error(insErr);
      const { error: insErr2 } = await supabase.from("password_resets").insert([
        { user_uuid: user.uuid, token_hash: tokenHash, created_at: nowIso, expires_at: expiresAtIso },
      ]);
      if (insErr2) {
        console.error(insErr2);
        setFlash(res, "danger", "Could not start a reset right now.");
        return res.redirect("/forgot");
      }
    }

    setFlash(res, "good", "Reset link created. Set a new password below.");
    return res.redirect(`/reset/${encodeURIComponent(token)}`);
  } catch (err) {
    console.error(err);
    setFlash(res, "danger", "Could not start a reset right now.");
    return res.redirect("/forgot");
  }
});

app.get("/reset/:token", (req, res) => {
  if (req.user) return res.redirect("/dash");
  const token = String(req.params.token || "");
  return res.render("pages/reset", { title: "Set New Password", token });
});

app.post("/reset/:token", async (req, res) => {
  try {
    if (req.user) return res.redirect("/dash");

    const token = String(req.params.token || "");
    const password = String(req.body.password || "");
    const tokenHash = sha256Hex(token);

    if (!password || password.length < 8 || password.length > 72) {
      setFlash(res, "danger", "Password must be 8-72 characters.");
      return res.redirect(`/reset/${encodeURIComponent(token)}`);
    }

    const { data: row, error } = await supabase
      .from("password_resets")
      .select("*")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (error) console.error(error);

    if (!row) {
      setFlash(res, "danger", "That reset link is not valid.");
      return res.redirect("/forgot");
    }

    const now = Date.now();
    const expiresMs = row.expires_at ? Date.parse(row.expires_at) : 0;
    if (row.used_at) {
      setFlash(res, "danger", "That reset link was already used.");
      return res.redirect("/forgot");
    }
    if (expiresMs && expiresMs < now) {
      setFlash(res, "danger", "That reset link expired.");
      return res.redirect("/forgot");
    }

    const newHash = hashPassword(password);

    const { error: upErr } = await supabase
      .from("users")
      .update({ password_hash: newHash })
      .eq("uuid", row.user_uuid);

    if (upErr) {
      console.error(upErr);
      setFlash(res, "danger", "Password reset failed.");
      return res.redirect("/forgot");
    }

    await supabase
      .from("password_resets")
      .update({ used_at: new Date().toISOString() })
      .eq("token_hash", tokenHash);

    // Kill all sessions for the user
    await supabase.from("sessions").delete().eq("user_uuid", row.user_uuid);

    setFlash(res, "good", "Password updated. Please log in.");
    return res.redirect("/login");
  } catch (err) {
    console.error(err);
    setFlash(res, "danger", "Password reset failed.");
    return res.redirect("/forgot");
  }
});

// Dash: 3 tables (Installed Apps from device report, Announcements, API Keys)
app.get("/dash", requireAuth, async (req, res) => {
  const { data: announcements, error: aErr } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  if (aErr) console.error(aErr);

  const { data: apiKeys, error: kErr } = await supabase
    .from("api_keys")
    .select("*")
    .eq("user_uuid", req.user.uuid)
    .order("created_at", { ascending: false });

  if (kErr) console.error(kErr);

  const apiKeysView = (apiKeys || []).map((k) => ({ ...k, masked: maskKey(k.key_prefix || (k.api_key ? k.api_key : "")) }));

  const { data: devices, error: dErr } = await supabase
    .from("device_reports")
    .select("device_tag, updated_at")
    .eq("user_uuid", req.user.uuid)
    .order("updated_at", { ascending: false });

  if (dErr) console.error(dErr);

  const requested = String(req.query.device_tag || "").trim();
  const selectedDevice = requested || (devices?.[0]?.device_tag || "");

  let installedApps = [];
  let reportUpdatedAt = null;

  if (selectedDevice) {
    const { data: report, error: rErr } = await supabase
      .from("device_reports")
      .select("apps_json, updated_at")
      .eq("user_uuid", req.user.uuid)
      .eq("device_tag", selectedDevice)
      .maybeSingle();

    if (rErr) console.error(rErr);

    if (report && report.apps_json) {
      const raw = report.apps_json;
      if (Array.isArray(raw)) installedApps = raw;
      else if (typeof raw === "string") {
        try { installedApps = JSON.parse(raw) || []; } catch { installedApps = []; }
      }
      if (!Array.isArray(installedApps)) installedApps = [];
      reportUpdatedAt = report.updated_at || null;
    }
  }

  return res.render("pages/dash", {
    title: "Dash",
    devices: devices || [],
    selectedDevice,
    installedApps,
    reportUpdatedAt,
    announcements: announcements || [],
    apiKeys: apiKeysView,
  });
});

app.get("/dash/device-agent", requireAuth, async (req, res) => {
  const { data: apiKeys, error: kErr } = await supabase
    .from("api_keys")
    .select("*")
    .eq("user_uuid", req.user.uuid)
    .order("created_at", { ascending: false });

  if (kErr) console.error(kErr);

  const apiKeysView = (apiKeys || []).map((k) => ({ ...k, masked: maskKey(k.key_prefix || (k.api_key ? k.api_key : "")) }));

  const { data: devices, error: dErr } = await supabase
    .from("device_reports")
    .select("device_tag, updated_at")
    .eq("user_uuid", req.user.uuid)
    .order("updated_at", { ascending: false });

  if (dErr) console.error(dErr);

  return res.render("pages/device-agent", {
    title: "Device Agent",
    baseUrl: baseUrl,
    apiKeys: apiKeysView,
    devices: devices || [],
  });
});

// API Keys: generate
app.post("/dash/apikeys/generate", requireAuth, async (req, res) => {
  const label = String(req.body.label || "").trim().slice(0, 32);
  const key = makeApiKey();
  const keyHash = sha256Hex(key);
  const keyPrefix = keyPrefixFromKey(key);

  const insertPreferred = async () => {
    return await supabase
      .from("api_keys")
      .insert([{ user_uuid: req.user.uuid, label, key_hash: keyHash, key_prefix: keyPrefix }]);
  };

  const insertFallback = async () => {
    return await supabase
      .from("api_keys")
      .insert([{ user_uuid: req.user.uuid, label, api_key: key }]);
  };

  let ins = await insertPreferred();
  if (ins.error) ins = await insertFallback();

  if (ins.error) {
    console.error(ins.error);
    setFlash(res, "bad", "Could not generate an API key. Try again.");
    return res.redirect("/dash");
  }

  setFlash(res, "good", "API key generated. Copy it now—this is the only time we show it.", { value: key });
  return res.redirect("/dash/device-agent");
});


// Sessions list + revoke
app.get("/dash/sessions", requireAuth, async (req, res) => {
  const { data: sessions, error } = await supabase
    .from("sessions")
    .select("sid, device_tag, remember_me, created_at, last_seen, expires_at")
    .eq("user_uuid", req.user.uuid)
    .order("last_seen", { ascending: false });

  if (error) console.error(error);

  return res.render("pages/sessions", {
    title: "Sessions",
    sessions: sessions || [],
    currentSid: String(req.cookies?.sid || ""),
  });
});

app.post("/dash/sessions/revoke", requireAuth, async (req, res) => {
  try {
    const sid = String(req.body.sid || "");
    if (!sid) return res.redirect("/dash/sessions");

    await supabase.from("sessions").delete().eq("sid", sid).eq("user_uuid", req.user.uuid);

    if (sid === String(req.cookies?.sid || "")) {
      res.clearCookie("sid", { path: "/" });
      setFlash(res, "good", "Session revoked (logged out).");
      return res.redirect("/");
    }

    setFlash(res, "good", "Session revoked.");
    return res.redirect("/dash/sessions");
  } catch (err) {
    console.error(err);
    setFlash(res, "danger", "Failed to revoke session.");
    return res.redirect("/dash/sessions");
  }
});

// Device apps: fetch for current device_tag
app.get("/api/device/devices", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("device_reports")
    .select("device_tag, updated_at")
    .eq("user_uuid", req.user.uuid)
    .order("updated_at", { ascending: false });

  if (error) console.error(error);
  return res.status(200).json({ ok: true, devices: data || [] });
});

app.get("/api/device/apps", requireAuth, async (req, res) => {
  const requested = String(req.query.device_tag || "").trim();
  let deviceTag = requested;

  if (!deviceTag) {
    const { data: latest, error: lErr } = await supabase
      .from("device_reports")
      .select("device_tag, updated_at")
      .eq("user_uuid", req.user.uuid)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lErr) console.error(lErr);
    deviceTag = latest?.device_tag || "";
  }

  if (!deviceTag) return res.status(200).json({ ok: true, device_tag: "", updated_at: null, apps: [] });

  const { data: report, error } = await supabase
    .from("device_reports")
    .select("apps_json, updated_at")
    .eq("user_uuid", req.user.uuid)
    .eq("device_tag", deviceTag)
    .maybeSingle();

  if (error) console.error(error);

  let apps = [];
  let updatedAt = null;

  if (report && report.apps_json) {
    const raw = report.apps_json;
    if (Array.isArray(raw)) apps = raw;
    else if (typeof raw === "string") {
      try { apps = JSON.parse(raw) || []; } catch { apps = []; }
    }
    if (!Array.isArray(apps)) apps = [];
    updatedAt = report.updated_at || null;
  }

  return res.status(200).json({ ok: true, device_tag: deviceTag, updated_at: updatedAt, apps });
});

// Device agent report endpoint (Bearer API key)
app.post("/api/device/report", async (req, res) => {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const apiKey = m ? m[1].trim() : "";

  if (!apiKey) return res.status(401).json({ ok: false, error: "missing_api_key" });

  const keyHash = sha256Hex(apiKey);

  // Prefer hashed lookup; fallback to plaintext for older installs.
  let keyRow = null;

  const { data: byHash, error: hErr } = await supabase
    .from("api_keys")
    .select("user_uuid")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (hErr) console.error(hErr);
  if (byHash && byHash.user_uuid) keyRow = byHash;

  if (!keyRow) {
    const { data: byPlain, error: pErr } = await supabase
      .from("api_keys")
      .select("user_uuid")
      .eq("api_key", apiKey)
      .maybeSingle();

    if (pErr) console.error(pErr);
    if (byPlain && byPlain.user_uuid) keyRow = byPlain;
  }

  if (!keyRow) return res.status(401).json({ ok: false, error: "invalid_api_key" });

  const userUuid = keyRow.user_uuid;

  const deviceTag = String(req.body?.device_tag || "").trim().slice(0, 120) || "Device Agent";
  const apps = Array.isArray(req.body?.apps) ? req.body.apps : [];

  const safeApps = apps
    .map((a) => ({
      name: String(a?.name || "").trim().slice(0, 80),
      version: String(a?.version || "").trim().slice(0, 40),
      source: String(a?.source || "").trim().slice(0, 24) || "agent",
    }))
    .filter((a) => a.name);

  const now = Date.now();

  const up = await supabase.from("device_reports").upsert(
    [{
      user_uuid: userUuid,
      device_tag: deviceTag,
      apps_json: safeApps,
      updated_at: new Date(now).toISOString(),
    }],
    { onConflict: "user_uuid,device_tag" }
  );

  if (up.error) {
    console.error(up.error);
    return res.status(500).json({ ok: false, error: "db_error" });
  }

  try { io.to(String(userUuid)).emit("device:report", { device_tag: deviceTag, updated_at: new Date(now).toISOString(), count: safeApps.length }); } catch {}

  return res.status(200).json({ ok: true, updated_at: new Date(now).toISOString(), count: safeApps.length });
});


// Admin panel
app.get("/admin", requireAdmin, async (req, res) => {
  const { data: users, error: uErr } = await supabase
    .from("users")
    .select("uuid, username, email, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (uErr) console.error(uErr);

  const { data: sessions, error: sErr } = await supabase
    .from("sessions")
    .select("sid, username, email, device_tag, remember_me, created_at, last_seen, expires_at")
    .order("last_seen", { ascending: false })
    .limit(100);
  if (sErr) console.error(sErr);

  const { data: announcements, error: aErr } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);
  if (aErr) console.error(aErr);

  return res.render("pages/admin", { title: "Admin", users: users || [], sessions: sessions || [], announcements: announcements || [] });
});

app.post("/admin/announcement", requireAdmin, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim().slice(0, 80);
    const body = String(req.body.body || "").trim().slice(0, 500);
    if (!title || !body) {
      setFlash(res, "danger", "Title and body required.");
      return res.redirect("/admin");
    }
    await supabase.from("announcements").insert([{ title, body, created_at: new Date().toISOString() }]);
    setFlash(res, "good", "Announcement created.");
    return res.redirect("/admin");
  } catch (err) {
    console.error(err);
    setFlash(res, "danger", "Failed to create announcement.");
    return res.redirect("/admin");
  }
});

app.post("/admin/session/revoke", requireAdmin, async (req, res) => {
  try {
    const sid = String(req.body.sid || "");
    if (sid) await supabase.from("sessions").delete().eq("sid", sid);
    setFlash(res, "good", "Session revoked.");
    return res.redirect("/admin");
  } catch (err) {
    console.error(err);
    setFlash(res, "danger", "Failed to revoke session.");
    return res.redirect("/admin");
  }
});

app.get("/api/me", (req, res) => {
  res.status(200).json({ ok: true, user: req.user || null });
});

app.use((req, res) => res.status(404).render("pages/404", { title: "Not Found" }));


(async () => {
  // Quick sanity check: verify Supabase connection
  const { error } = await supabase.from("announcements").select("id").limit(1);
  if (error) {
    console.error("❌ Supabase not ready. Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and run the schema SQL.", error);
    process.exit(1);
  }
  const server = new http.Server(app)
  app.listen(port, () => {
    console.log(`✅ ${siteName} running on ${baseUrl}`);
  });
})();

