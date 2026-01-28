
  "use strict";

  // Inline, single-file Discord mirror + web panel (NO AUTH)
  const dotenv = require("dotenv");
  dotenv.config();

  const path = require("path");
  const fs = require("fs");
  const http = require("http");

  const express = require("express");
  const helmet = require("helmet");
  const rateLimit = require("express-rate-limit");
  const { Server } = require("socket.io");

  const sqlite3 = require("sqlite3").verbose();

  const {
    Client,
    GatewayIntentBits,
    Partials,
    ChannelType,
    PermissionsBitField,
  } = require("discord.js");

  function mustEnv(name) {
    const v = process.env[name];
    if (!v) {
      console.error(`[FATAL] Missing environment variable: ${name}`);
      process.exit(1);
    }
    return v;
  }

  const BOT_TOKEN = mustEnv("WSD_TOKEN");
const GUILD_ID = mustEnv("WSD_GUILD");
const BASE_URL = mustEnv("WSD_BASE");
const SESSION_SECRET = mustEnv("SESSION_SECRET");
const OWNER_DISCORD_ID = mustEnv("WSD_OD");
const PORT = mustEnv("WSD_PORT");
const TRUST_PROXY = parseInt("0", 10);
const COOKIE_SECURE = "1";
// ---------- DB ----------
const DATA_DIR = path.join(process.cwd(), "data", "wsd");
const DB_PATH = path.join(DATA_DIR, "mirror.db");
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ALLOW_DANGER =  "1";
const ALLOW_IMPORT =  "1";
const ALLOW_ASSIGN = "1";
const ALLOW_EXPORT =  "1";

const PORT_NUM = (() => {
  const n = parseInt(String(PORT), 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[FATAL] WSD_PORT must be a valid port number. Got: ${PORT}`);
    process.exit(1);
  }
  return n;
})();
  function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  async function migrate(db) {
    await dbRun(db, "PRAGMA journal_mode = WAL;");
    await dbRun(db, "PRAGMA foreign_keys = ON;");

    await dbRun(db, `
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color INTEGER NOT NULL DEFAULT 0,
        hoist INTEGER NOT NULL DEFAULT 0,
        mentionable INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        permissions TEXT NOT NULL,
        managed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);

    await dbRun(db, `
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        type INTEGER NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        topic TEXT,
        nsfw INTEGER NOT NULL DEFAULT 0,
        rate_limit INTEGER NOT NULL DEFAULT 0,
        bitrate INTEGER NOT NULL DEFAULT 0,
        user_limit INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);

    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id);`);
  }

  async function openDb() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = new sqlite3.Database(DB_PATH);
    await migrate(db);
    return db;
  }

  // ---------- Mirror ----------
  function now() { return Date.now(); }

  function channelFields(ch) {
    const base = {
      id: ch.id,
      type: ch.type,
      name: ch.name ?? "(unknown)",
      parent_id: ch.parentId ?? null,
      position: ch.rawPosition ?? 0,
      topic: null,
      nsfw: 0,
      rate_limit: 0,
      bitrate: 0,
      user_limit: 0,
    };

    if (typeof ch.topic === "string") base.topic = ch.topic;
    if (typeof ch.nsfw === "boolean") base.nsfw = ch.nsfw ? 1 : 0;
    if (typeof ch.rateLimitPerUser === "number") base.rate_limit = ch.rateLimitPerUser;

    if (typeof ch.bitrate === "number") base.bitrate = ch.bitrate;
    if (typeof ch.userLimit === "number") base.user_limit = ch.userLimit;

    return base;
  }

  async function upsertRole(db, role) {
    const permissions = role.permissions?.bitfield?.toString?.() ?? "0";
    await dbRun(
      db,
      `
      INSERT INTO roles (id, name, color, hoist, mentionable, position, permissions, managed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        color=excluded.color,
        hoist=excluded.hoist,
        mentionable=excluded.mentionable,
        position=excluded.position,
        permissions=excluded.permissions,
        managed=excluded.managed,
        updated_at=excluded.updated_at
      `,
      [
        role.id,
        role.name,
        role.color ?? 0,
        role.hoist ? 1 : 0,
        role.mentionable ? 1 : 0,
        role.position ?? 0,
        permissions,
        role.managed ? 1 : 0,
        now(),
      ]
    );
  }

  async function upsertChannel(db, ch) {
    const f = channelFields(ch);
    await dbRun(
      db,
      `
      INSERT INTO channels (id, type, name, parent_id, position, topic, nsfw, rate_limit, bitrate, user_limit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,
        name=excluded.name,
        parent_id=excluded.parent_id,
        position=excluded.position,
        topic=excluded.topic,
        nsfw=excluded.nsfw,
        rate_limit=excluded.rate_limit,
        bitrate=excluded.bitrate,
        user_limit=excluded.user_limit,
        updated_at=excluded.updated_at
      `,
      [
        f.id,
        f.type,
        f.name,
        f.parent_id,
        f.position,
        f.topic,
        f.nsfw,
        f.rate_limit,
        f.bitrate,
        f.user_limit,
        now(),
      ]
    );
  }

  async function fullSync({ client, db, guildId }) {
    const guild = await client.guilds.fetch(guildId);

    const roles = await guild.roles.fetch();
    const roleIds = new Set();
    for (const role of roles.values()) {
      roleIds.add(role.id);
      await upsertRole(db, role);
    }
    const dbRoles = await dbAll(db, `SELECT id FROM roles`);
    for (const r of dbRoles) {
      if (!roleIds.has(r.id)) await dbRun(db, `DELETE FROM roles WHERE id=?`, [r.id]);
    }

    await guild.channels.fetch();
    const chans = guild.channels.cache;
    const channelIds = new Set();
    for (const ch of chans.values()) {
      if (ch.isThread?.()) continue;
      channelIds.add(ch.id);
      await upsertChannel(db, ch);
    }
    const dbChannels = await dbAll(db, `SELECT id FROM channels`);
    for (const c of dbChannels) {
      if (!channelIds.has(c.id)) await dbRun(db, `DELETE FROM channels WHERE id=?`, [c.id]);
    }

    return { roles: roleIds.size, channels: channelIds.size };
  }

  // ---------- HTML helpers ----------
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function layout(title, body, extraHead = "", extraScript = "") {
    return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg:#0b0e14; --card:#111827; --line:#1f2937; --text:#e5e7eb; --muted:#9ca3af; --primary:#5865F2;
        --danger:#ef4444;
      }
      *{box-sizing:border-box}
      body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Arial;
        background:radial-gradient(1200px 600px at 20% -10%, #1a2445 0%, transparent 60%),
                   radial-gradient(900px 500px at 100% 0%, #2b1c3d 0%, transparent 55%),
                   var(--bg);
        color:var(--text)}
      a{color:#a5b4fc;text-decoration:none} a:hover{text-decoration:underline}
      .top{position:sticky;top:0;z-index:10;display:flex;flex-direction:column;justify-content:center;align-items:center;
  text-align:center;padding:16px 18px;border-bottom:1px solid var(--line);background:rgba(10,12,18,.75);backdrop-filter:blur(12px)}
      .brand{font-weight:800;font-size:18px}
      .container{max-width:1100px;margin:0 auto;padding:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
      .card{border:1px solid var(--line);background:linear-gradient(180deg, rgba(17,24,39,.95) 0%, rgba(15,23,42,.85) 100%);
        border-radius:16px;padding:16px;width:100%;box-shadow:0 18px 60px rgba(0,0,0,.35)}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:18px;width:100%;justify-content:center;align-items:start}
      @media(max-width:980px){.row{grid-template-columns:1fr}}
      .muted{color:var(--muted)}
      .small{font-size:12px}
      .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}
      .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 12px;border-radius:12px;
        border:1px solid var(--line);color:var(--text);background:rgba(17,24,39,.9);cursor:pointer}
      .btn:hover{filter:brightness(1.08)}
      .btn-primary{background:rgba(88,101,242,.9);border-color:rgba(88,101,242,.55)}
      .btn-danger{background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.55)}
      .table-wrap{overflow:auto;border-radius:12px;border:1px solid var(--line)}
      table{width:100%;border-collapse:collapse;min-width:760px}
      th,td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle;text-align:center}
      th{text-align:left;color:var(--muted);font-weight:700;font-size:12px}
      tr:hover td{background:rgba(0,0,0,.18)}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
      @media(max-width:980px){.grid{grid-template-columns:1fr}}
      label span{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
      input,select{width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);
        background:rgba(2,6,23,.55);color:var(--text);outline:none}
      .inline{display:flex;align-items:center;gap:10px}
      .inline input[type="checkbox"]{width:18px;height:18px}
      .actions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
      .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid rgba(239,68,68,.45);
        background:rgba(239,68,68,.10);color:#fecaca;margin-left:8px}
      .note{margin-top:12px;font-size:12px}
      .alert{margin:10px 0;padding:10px 12px;border-radius:12px;border:1px solid rgba(239,68,68,.5);
        background:rgba(239,68,68,.12);color:#fecaca}
      .perm-grid{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:10px;margin-top:10px}
      @media(max-width:980px){.perm-grid{grid-template-columns:1fr}}
      .perm{border:1px solid var(--line);padding:10px;border-radius:12px;background:rgba(2,6,23,.25)}
      code{background:rgba(2,6,23,.45);padding:2px 6px;border-radius:8px;border:1px solid var(--line)}
      ${extraHead}
    </style>
  </head>
  <body>
    <div class="top">
      <div>
        <div class="brand">Discord Mirror Panel</div>
        <div class="muted small">Inline build • No auth enabled • Guild: <code class="mono">${escapeHtml(guildIdShort())}</code></div>
      </div>
      <div class="inline">
        <form method="POST" action="/sync"><button class="btn" type="submit">Sync now</button></form>
        <a class="btn" href="/export">Export Users</a>
        <a class="btn" href="/assign">Assign Roles</a>
        <a class="btn" href="/import">Import JSON</a>
        <a class="btn btn-danger" href="/about">Warning</a>
      </div>
    </div>
    <div class="container">
      ${body}
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      (function(){
        try{
          var s = io();
          function refresh(){
            if (location.pathname === "/" || location.pathname === "") setTimeout(function(){ location.reload(); }, 650);
          }
          s.on("mirror:sync", refresh);
          s.on("mirror:role", refresh);
          s.on("mirror:channel", refresh);
        }catch(e){}
      })();
    </script>
    ${extraScript}
  </body>
  </html>`;
  }

  function guildIdShort() {
    const g = String(GUILD_ID || "");
    return g.length > 8 ? (g.slice(0, 4) + "…" + g.slice(-4)) : g;
  }

  function typeNameMap() {
    const map = {};
    for (const [k, v] of Object.entries(ChannelType)) {
      if (typeof v === "number") map[v] = k;
    }
    return map;
  }

function normalizeKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveChannelType(v) {
  if (typeof v === "number") return v;
  const s = String(v || "").trim();
  if (!s) throw new Error("Channel type is required");
  const wanted = normalizeKey(s);
  for (const [k, val] of Object.entries(ChannelType)) {
    if (typeof val !== "number") continue;
    if (normalizeKey(k) === wanted) return val;
  }
  const alias = {
    guildtext: ChannelType.GuildText,
    text: ChannelType.GuildText,
    guildvoice: ChannelType.GuildVoice,
    voice: ChannelType.GuildVoice,
    category: ChannelType.GuildCategory,
    guildcategory: ChannelType.GuildCategory,
    announcement: ChannelType.GuildAnnouncement,
    guildannouncement: ChannelType.GuildAnnouncement,
    stage: ChannelType.GuildStageVoice,
    stagevoice: ChannelType.GuildStageVoice,
    forum: ChannelType.GuildForum,
    guildforum: ChannelType.GuildForum,
  };
  if (alias[wanted] !== undefined) return alias[wanted];
  throw new Error(`Unknown channel type: ${s}`);
}

function resolvePermissions(input) {
  if (input === undefined || input === null || input === "") return undefined;

  if (Array.isArray(input)) {
    return new PermissionsBitField(input);
  }

  const s = String(input).trim();
  if (!s) return undefined;

  if (/^\d+$/.test(s)) {
    try { return new PermissionsBitField(BigInt(s)); } catch {}
  }

  if (s.includes(",")) {
    const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
    return new PermissionsBitField(parts);
  }

  return new PermissionsBitField([s]);
}

function resolveOverwritePerms(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (!s) return [];
  if (/^\d+$/.test(s)) {
    return BigInt(s);
  }
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
}


  const PERM_FLAGS = Object.keys(PermissionsBitField.Flags)
    .filter((k) => typeof PermissionsBitField.Flags[k] === "bigint")
    .sort();

  function parseHexColor(s) {
    if (!s) return null;
    const x = String(s).trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(x)) return null;
    return parseInt(x.replace("#", ""), 16);
  }

  function boolFromForm(v) {
    return v === "on" || v === "true" || v === "1";
  }

function parseUserIdList(input) {
  const raw = String(input || "");
  const parts = raw.split(/[\s,]+/g).map((x) => x.trim()).filter(Boolean);
  const ids = [];
  const seen = new Set();
  for (const p of parts) {
    if (!/^\d{15,25}$/.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    ids.push(p);
  }


async function promisePool(limit, items, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { __error: true, error: e };
      }

function membersToCsv(rows) {
  const esc = (s) => {
    const v = String(s ?? "");
    if (v.includes('"') || v.includes(",") || v.includes("\n") || v.includes("\r")) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  };
  const headers = ["id", "username", "globalName", "isBot"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([r.id, r.username, r.globalName, String(!!r.isBot)].map(esc).join(","));
  }
  return lines.join("\n") + "\n";
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

    }
  });
  await Promise.all(runners);
  return results;
}
  return ids;
}

function requireAdminKey(req, res, why) {
  const key = String(req.headers["x-admin-key"] || req.body.admin_key || "").trim();
  if (!ADMIN_KEY) {
    res.status(403).type("html").send(layout("Blocked", `
      <div class="card">
        <h1>Admin key not set</h1>
        <p class="muted">Set <code>ADMIN_KEY</code> in your .env to use ${escapeHtml(why)}.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/">Home</a></div>
      </div>
    `));
    return false;
  }
  if (key !== ADMIN_KEY) {
    res.status(401).type("html").send(layout("Unauthorized", `
      <div class="card">
        <h1>Unauthorized</h1>
        <p class="muted">Missing or wrong admin key.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/">Home</a></div>
      </div>
    `));
    return false;
  }
  return true;
}

function requireDanger(req, res) {
  if (!ALLOW_DANGER) {
    res.status(403).type("html").send(layout("Blocked", `
      <div class="card">
        <h1>Danger actions are disabled</h1>
        <p class="muted">Set <code>ALLOW_DANGER=1</code> in your .env to enable this page.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/">Home</a></div>
      </div>
    `));
    return false;
  }
  return requireAdminKey(req, res, "Danger Zone");
}

function requireImport(req, res) {
  if (!ALLOW_IMPORT) {
    res.status(403).type("html").send(layout("Blocked", `
      <div class="card">
        <h1>JSON Import is disabled</h1>
        <p class="muted">Set <code>ALLOW_IMPORT=1</code> in your .env to enable JSON import.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/">Home</a></div>
      </div>
    `));
    return false;
  }
 return requireAdminKey(req, res, "JSON Import");
}
function requireAssign(req, res) {
  if (!ALLOW_ASSIGN) {
    res.status(403).type("html").send(layout("Blocked", `
      <div class="card">
        <h1>Role assignment is disabled</h1>
        <p class="muted">Set <code>ALLOW_ASSIGN=1</code> in your .env to enable role assignment.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/">Home</a></div>
      </div>
    `));
    return false;
  }
    return requireAdminKey(req, res, "Role assignment");
}

function requireExport(req, res) {
  if (!ALLOW_EXPORT) {
    res.status(403).type("html").send(layout("Blocked", `
      <div class="card">
        <h1>User export is disabled</h1>
        <p class="muted">Set <code>ALLOW_EXPORT=1</code> in your .env to enable user export.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/">Home</a></div>
      </div>
    `));
    return false;
  }
  return requireAdminKey(req, res, "User export");
}


 


  // ---------- Main ----------
  async function main() {
    const db = await openDb();

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
      partials: [Partials.Channel],
    });

    const app = express();
    app.set("trust proxy", TRUST_PROXY);
    const server = http.createServer(app);
    const io = new Server(server, { serveClient: true });

    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(rateLimit({
      windowMs: 60 * 1000,
      limit: 180,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }));
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // About / warning page
    app.get("/about", (_req, res) => {
      res.type("html").send(layout("Warning", `
        <div class="card">
          <h1>Security warning</h1>
          <p class="muted">This build has <strong>NO authentication</strong>. Anyone who can reach this URL can edit your Discord server.</p>
          <p class="muted">If you deploy it, put it behind a VPN, firewall allowlist, reverse-proxy auth, or bind to localhost only.</p>
          <div class="actions">
            <a class="btn" href="/">Back</a>
          </div>
        </div>
      `));
    });

    // Home: roles + channels table
    app.get("/", async (_req, res) => {
      const roles = await dbAll(db, `SELECT * FROM roles ORDER BY position DESC, name ASC`);
      const channelsRaw = await dbAll(
        db,
        `SELECT * FROM channels ORDER BY type = ? DESC, parent_id IS NULL DESC, parent_id ASC, position ASC, name ASC`,
        [ChannelType.GuildCategory]
      );

      const nameById = {};
      for (const c of channelsRaw) nameById[c.id] = c.name;

      const types = typeNameMap();
      const channels = channelsRaw.map((c) => ({
        ...c,
        type_name: types[c.type] || String(c.type),
        parent_name: c.parent_id ? (nameById[c.parent_id] || c.parent_id) : null,
      }));

      const roleRows = roles.map(r => `
        <tr>
          <td>${escapeHtml(r.name)}${r.managed ? `<span class="pill">Managed</span>` : ""}</td>
          <td class="mono">${escapeHtml(r.id)}</td>
          <td class="mono">#${(Number(r.color) >>> 0).toString(16).padStart(6, "0")}</td>
          <td>${escapeHtml(r.position)}</td>
          <td><a href="/role/${encodeURIComponent(r.id)}">Edit</a></td>
        </tr>
      `).join("");

      const channelRows = channels.map(c => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td class="mono">${escapeHtml(c.id)}</td>
          <td class="mono">${escapeHtml(c.type_name)}</td>
          <td>${escapeHtml(c.parent_name || "-")}</td>
          <td><a href="/channel/${encodeURIComponent(c.id)}">Edit</a></td>
        </tr>
      `).join("");

      res.type("html").send(layout("Admin", `
        <div class="row">
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div>
                <h2>Roles</h2>
                <div class="muted small">Mirrored from Discord. Click Edit to update.</div>
              </div>
            </div>

            <div class="table-wrap" style="margin-top:10px">
              <table>
                <thead><tr><th>Name</th><th>ID</th><th>Color</th><th>Position</th><th></th></tr></thead>
                <tbody>${roleRows || `<tr><td colspan="5" class="muted">No roles in database yet.</td></tr>`}</tbody>
              </table>
            </div>

            <div class="note muted">Managed roles are often not editable by Discord.</div>
          </div>

          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div>
                <h2>Channels</h2>
                <div class="muted small">Mirrored from Discord. Click Edit to update.</div>
              </div>
              <form method="POST" action="/sync"><button class="btn" type="submit">Sync now</button></form>
            </div>

            <div class="table-wrap" style="margin-top:10px">
              <table>
                <thead><tr><th>Name</th><th>ID</th><th>Type</th><th>Parent</th><th></th></tr></thead>
                <tbody>${channelRows || `<tr><td colspan="5" class="muted">No channels in database yet.</td></tr>`}</tbody>
              </table>
            </div>

            <div class="note muted">If you change Discord, this page auto-refreshes within a second or two.</div>
          </div>
        </div>

        <div class="card" style="border-color:rgba(239,68,68,.55)">
          <h2>Danger Zone</h2>
          <p class="muted small">Delete all channels or roles (protected by ADMIN_KEY + confirmation).</p>
          <div class="actions" style="justify-content:center">
            <a class="btn btn-danger" href="/danger">Open Danger Zone</a>
            <a class="btn" href="/import">Open JSON Import</a>
            <a class="btn" href="/assign">Open Role Assignment</a>
            <a class="btn" href="/export">Open User Export</a>
          </div>
        </div>

      `));
    });

    // Manual sync
    app.post("/sync", async (_req, res) => {
      try {
        await fullSync({ client, db, guildId: GUILD_ID });
        io.emit("mirror:sync", { reason: "manual_sync", at: Date.now() });
      } catch (err) {
        console.error("manual sync failed:", err);
      }
      res.redirect("/");
    });

    // Edit role page
    app.get("/role/:id", async (req, res) => {
      const roleRow = await dbGet(db, `SELECT * FROM roles WHERE id=?`, [req.params.id]);
      if (!roleRow) return res.status(404).type("html").send(layout("Not Found", `<div class="card"><h1>Not found</h1><a class="btn" href="/">Back</a></div>`));

      const current = BigInt(roleRow.permissions || "0");
      const permChecks = PERM_FLAGS.map(flag => {
        const bit = PermissionsBitField.Flags[flag];
        const checked = (current & bit) === bit;
        return `<label class="inline perm"><input type="checkbox" name="perm_${escapeHtml(flag)}" ${checked ? "checked" : ""} /><span>${escapeHtml(flag)}</span></label>`;
      }).join("");

      const colorHex = `#${(Number(roleRow.color) >>> 0).toString(16).padStart(6, "0")}`;

      res.type("html").send(layout("Edit Role", `
        <div class="card">
          <h1>Edit role</h1>
          <div class="muted small mono">${escapeHtml(roleRow.id)}</div>

          ${roleRow.managed ? `<div class="alert"><strong>Managed role:</strong> Discord may refuse edits to this role.</div>` : ""}

          <form method="POST" action="/role/${encodeURIComponent(roleRow.id)}">
            <div class="grid">
              <label>
                <span>Name</span>
                <input name="name" value="${escapeHtml(roleRow.name)}" maxlength="100" required />
              </label>

              <label>
                <span>Color (hex)</span>
                <input name="color" value="${escapeHtml(colorHex)}" />
              </label>

              <label class="inline">
                <input type="checkbox" name="hoist" ${roleRow.hoist ? "checked" : ""} />
                <span>Show separately</span>
              </label>

              <label class="inline">
                <input type="checkbox" name="mentionable" ${roleRow.mentionable ? "checked" : ""} />
                <span>Mentionable</span>
              </label>

              <label class="wide">
                <span>Permissions bitfield (advanced)</span>
                <input class="mono" name="permissions_raw" value="${escapeHtml(String(roleRow.permissions || "0"))}" />
              </label>
            </div>

            <h2 style="margin-top:14px">Permissions (checkboxes)</h2>
            <div class="muted small">If you edit the raw bitfield above, it overrides the checkboxes on save.</div>
            <div class="perm-grid">${permChecks}</div>

            <div class="actions">
              <a class="btn" href="/">Cancel</a>
              <button class="btn btn-primary" type="submit">Save changes</button>
            </div>
          </form>
        </div>
      `));
    });

    app.post("/role/:id", async (req, res) => {
      const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
      const role = await guild.roles.fetch(req.params.id).catch(() => null);
      if (!role) return res.status(404).type("html").send(layout("Not Found", `<div class="card"><h1>Not found</h1><a class="btn" href="/">Back</a></div>`));

      const name = String(req.body.name || "").trim();
      const color = parseHexColor(req.body.color);
      const hoist = boolFromForm(req.body.hoist);
      const mentionable = boolFromForm(req.body.mentionable);

      // Permissions: prefer raw if valid bigint-like
      let perms = null;
      const raw = String(req.body.permissions_raw || "").trim();
      if (/^\d+$/.test(raw)) {
        try { perms = BigInt(raw); } catch { perms = null; }
      }
      if (perms === null) {
        perms = 0n;
        for (const k of PERM_FLAGS) {
          if (req.body[`perm_${k}`]) perms |= PermissionsBitField.Flags[k];
        }
      }

      try {
        await role.edit({
          name: name || role.name,
          color: color === null ? role.color : color,
          hoist,
          mentionable,
          permissions: perms,
        });

        const updated = await guild.roles.fetch(role.id);
        await upsertRole(db, updated);
        io.emit("mirror:sync", { reason: "role_edit", at: Date.now() });
        res.redirect("/");
      } catch (err) {
        const msg = escapeHtml(String(err?.message || err));
        res.status(400).type("html").send(layout("Role Update Failed", `
          <div class="card">
            <h1>Update failed</h1>
            <div class="alert">${msg}</div>
            <div class="actions">
              <a class="btn" href="/role/${encodeURIComponent(req.params.id)}">Back</a>
              <a class="btn" href="/">Home</a>
            </div>
          </div>
        `));
      }
    });

    // Edit channel page
    app.get("/channel/:id", async (req, res) => {
      const row = await dbGet(db, `SELECT * FROM channels WHERE id=?`, [req.params.id]);
      if (!row) return res.status(404).type("html").send(layout("Not Found", `<div class="card"><h1>Not found</h1><a class="btn" href="/">Back</a></div>`));

      const categories = await dbAll(db, `SELECT id, name FROM channels WHERE type=? ORDER BY position ASC`, [ChannelType.GuildCategory]);
      const catOptions = categories.map(c => {
        const sel = row.parent_id === c.id ? "selected" : "";
        return `<option value="${escapeHtml(c.id)}" ${sel}>${escapeHtml(c.name)}</option>`;
      }).join("");

      const showTextFields = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(row.type);
      const showVoiceFields = [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(row.type);
      const isCategory = row.type === ChannelType.GuildCategory;

      res.type("html").send(layout("Edit Channel", `
        <div class="card">
          <h1>Edit channel</h1>
          <div class="muted small mono">${escapeHtml(row.id)}</div>

          <form method="POST" action="/channel/${encodeURIComponent(row.id)}">
            <div class="grid">
              <label>
                <span>Name</span>
                <input name="name" value="${escapeHtml(row.name)}" maxlength="100" required />
              </label>

              ${!isCategory ? `
                <label>
                  <span>Parent category</span>
                  <select name="parent_id">
                    <option value="">(no category)</option>
                    ${catOptions}
                  </select>
                </label>
              ` : ""}

              ${showTextFields ? `
                <label class="wide">
                  <span>Topic</span>
                  <input name="topic" value="${escapeHtml(row.topic || "")}" maxlength="1024" />
                </label>

                <label class="inline">
                  <input type="checkbox" name="nsfw" ${row.nsfw ? "checked" : ""} />
                  <span>NSFW</span>
                </label>

                <label>
                  <span>Slowmode (seconds)</span>
                  <input type="number" min="0" max="21600" name="rate_limit" value="${escapeHtml(row.rate_limit || 0)}" />
                </label>
              ` : ""}

              ${showVoiceFields ? `
                <label>
                  <span>Bitrate</span>
                  <input type="number" min="8000" max="384000" name="bitrate" value="${escapeHtml(row.bitrate || 0)}" />
                </label>

                <label>
                  <span>User limit</span>
                  <input type="number" min="0" max="99" name="user_limit" value="${escapeHtml(row.user_limit || 0)}" />
                </label>
              ` : ""}

              <label class="wide">
                <span>Type</span>
                <input class="mono" value="${escapeHtml(String(row.type))}" disabled />
              </label>
            </div>

            <div class="actions">
              <a class="btn" href="/">Cancel</a>
              <button class="btn btn-primary" type="submit">Save changes</button>
            </div>

            <div class="note muted">If Discord rejects the edit, it’s usually bot permissions or unsupported fields.</div>
          </form>
        </div>
      `));
    });

    app.post("/channel/:id", async (req, res) => {
      const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
      const ch = await guild.channels.fetch(req.params.id).catch(() => null);
      if (!ch || ch.isThread?.()) return res.status(404).type("html").send(layout("Not Found", `<div class="card"><h1>Not found</h1><a class="btn" href="/">Back</a></div>`));

      const name = String(req.body.name || "").trim();
      const topic = String(req.body.topic || "").trim();
      const nsfw = boolFromForm(req.body.nsfw);

      const parentId = String(req.body.parent_id || "").trim() || null;

      const rateLimitPerUser = Number.isFinite(Number(req.body.rate_limit)) ? Math.max(0, parseInt(req.body.rate_limit, 10)) : undefined;
      const bitrate = Number.isFinite(Number(req.body.bitrate)) ? Math.max(8000, parseInt(req.body.bitrate, 10)) : undefined;
      const userLimit = Number.isFinite(Number(req.body.user_limit)) ? Math.max(0, parseInt(req.body.user_limit, 10)) : undefined;

      const patch = {};
      if (name) patch.name = name;

      // parent only if not category
      if (ch.type !== ChannelType.GuildCategory) {
        patch.parent = parentId;
      }

      // only apply supported fields
      if ("topic" in ch) patch.topic = topic;
      if ("nsfw" in ch) patch.nsfw = nsfw;
      if ("rateLimitPerUser" in ch && rateLimitPerUser !== undefined) patch.rateLimitPerUser = rateLimitPerUser;

      if ("bitrate" in ch && bitrate !== undefined) patch.bitrate = bitrate;
      if ("userLimit" in ch && userLimit !== undefined) patch.userLimit = userLimit;

      try {
        await ch.edit(patch);
        const updated = await guild.channels.fetch(ch.id);
        await upsertChannel(db, updated);
        io.emit("mirror:sync", { reason: "channel_edit", at: Date.now() });
        res.redirect("/");
      } catch (err) {
        const msg = escapeHtml(String(err?.message || err));
        res.status(400).type("html").send(layout("Channel Update Failed", `
          <div class="card">
            <h1>Update failed</h1>
            <div class="alert">${msg}</div>
            <div class="actions">
              <a class="btn" href="/channel/${encodeURIComponent(req.params.id)}">Back</a>
              <a class="btn" href="/">Home</a>
            </div>
          </div>
        `));
      }
    });


// Danger Zone (mass delete)
app.get("/danger", (_req, res) => {
  res.type("html").send(layout("Danger Zone", `
    <div class="card">
      <h1>Danger Zone</h1>
      <p class="muted"><strong>These actions delete things in Discord.</strong> They cannot be undone.</p>
      <p class="muted">To enable: set <code>ALLOW_DANGER=1</code> and a strong <code>ADMIN_KEY</code> in your .env.</p>

      <div class="card" style="margin-top:14px;border-color:rgba(239,68,68,.55)">
        <h2>Delete all channels</h2>
        <p class="muted small">Deletes all non-thread channels (text/voice/stage/forums/etc), then categories last.</p>
        <form method="POST" action="/danger/delete-channels">
          <div class="grid">
            <label class="wide">
              <span>Admin key</span>
              <input name="admin_key" class="mono" placeholder="ADMIN_KEY" required />
            </label>
            <label class="wide">
              <span>Type this to confirm</span>
              <input name="confirm" class="mono" placeholder="DELETE_CHANNELS" required />
            </label>
          </div>
          <div class="actions">
            <button class="btn btn-danger" type="submit">Delete all channels</button>
            <a class="btn" href="/">Cancel</a>
          </div>
        </form>
      </div>

      <div class="card" style="margin-top:14px;border-color:rgba(239,68,68,.55)">
        <h2>Delete all roles</h2>
        <p class="muted small">Skips @everyone and roles that Discord refuses (managed / above bot).</p>
        <form method="POST" action="/danger/delete-roles">
          <div class="grid">
            <label class="wide">
              <span>Admin key</span>
              <input name="admin_key" class="mono" placeholder="ADMIN_KEY" required />
            </label>
            <label class="wide">
              <span>Type this to confirm</span>
              <input name="confirm" class="mono" placeholder="DELETE_ROLES" required />
            </label>
          </div>
          <div class="actions">
            <button class="btn btn-danger" type="submit">Delete all roles</button>
            <a class="btn" href="/">Cancel</a>
          </div>
        </form>
      </div>

      <div class="note muted">Tip: keep <code>HOST=127.0.0.1</code> so only your machine can open the panel.</div>
      <div class="actions" style="justify-content:center">
        <a class="btn" href="/">Back</a>
      </div>
    </div>
  `));
});

async function deleteAllChannels({ guild, io }) {
  await guild.channels.fetch();
  const all = [...guild.channels.cache.values()].filter((c) => !c.isThread?.());

  // Delete non-categories first, then categories last
  const categories = all.filter((c) => c.type === ChannelType.GuildCategory);
  const nonCategories = all.filter((c) => c.type !== ChannelType.GuildCategory);

  const results = { deleted: 0, failed: 0, failures: [] };

  for (const ch of nonCategories) {
    try {
      await ch.delete("Danger Zone: delete all channels");
      results.deleted++;
    } catch (e) {
      results.failed++;
      results.failures.push({ id: ch.id, name: ch.name, error: String(e?.message || e) });
    }
  }

  // categories last (some may already be gone if Discord auto-removes, but usually not)
  for (const ch of categories) {
    try {
      // refresh: category might already be deleted
      const c = await guild.channels.fetch(ch.id).catch(() => null);
      if (!c) continue;
      await c.delete("Danger Zone: delete all categories");
      results.deleted++;
    } catch (e) {
      results.failed++;
      results.failures.push({ id: ch.id, name: ch.name, error: String(e?.message || e) });
    }
  }

  io.emit("mirror:sync", { reason: "danger_delete_channels", at: Date.now() });
  return results;
}

async function deleteAllRoles({ guild, io }) {
  const roles = await guild.roles.fetch();
  const everyoneId = guild.id;

  // Delete from lowest to highest to avoid hierarchy issues, skip @everyone
  const list = [...roles.values()]
    .filter((r) => r.id !== everyoneId)
    .sort((a, b) => a.position - b.position);

  const results = { deleted: 0, failed: 0, skipped: 0, failures: [] };

  for (const role of list) {
    if (role.managed) {
      results.skipped++;
      continue;
    }
    try {
      await role.delete("Danger Zone: delete all roles");
      results.deleted++;
    } catch (e) {
      results.failed++;
      results.failures.push({ id: role.id, name: role.name, error: String(e?.message || e) });
    }
  }

  io.emit("mirror:sync", { reason: "danger_delete_roles", at: Date.now() });
  return results;
}

app.post("/danger/delete-channels", async (req, res) => {
  if (!requireDanger(req, res)) return;
  if (String(req.body.confirm || "").trim() !== "DELETE_CHANNELS") {
    return res.status(400).type("html").send(layout("Confirm", `
      <div class="card">
        <h1>Confirmation phrase mismatch</h1>
        <p class="muted">Type <code>DELETE_CHANNELS</code> exactly.</p>
        <div class="actions"><a class="btn" href="/danger">Back</a></div>
      </div>
    `));
  }

  const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);

  let out;
  try {
    out = await deleteAllChannels({ guild, io });
    await fullSync({ client, db, guildId: GUILD_ID });
  } catch (e) {
    return res.status(500).type("html").send(layout("Failed", `
      <div class="card">
        <h1>Delete failed</h1>
        <div class="alert">${escapeHtml(String(e?.message || e))}</div>
        <div class="actions"><a class="btn" href="/danger">Back</a></div>
      </div>
    `));
  }

  const failuresHtml = (out.failures || []).slice(0, 25).map(f => `
    <li class="mono">${escapeHtml(f.name || "")} (${escapeHtml(f.id)}): ${escapeHtml(f.error)}</li>
  `).join("");

  res.type("html").send(layout("Done", `
    <div class="card">
      <h1>Delete channels complete</h1>
      <p class="muted">Deleted: <code>${out.deleted}</code> • Failed: <code>${out.failed}</code></p>
      ${out.failed ? `<div class="card" style="margin-top:12px"><h2>Failures (first 25)</h2><ul>${failuresHtml}</ul></div>` : ""}
      <div class="actions"><a class="btn" href="/">Home</a><a class="btn" href="/danger">Back</a></div>
    </div>
  `));
});

app.post("/danger/delete-roles", async (req, res) => {
  if (!requireDanger(req, res)) return;
  if (String(req.body.confirm || "").trim() !== "DELETE_ROLES") {
    return res.status(400).type("html").send(layout("Confirm", `
      <div class="card">
        <h1>Confirmation phrase mismatch</h1>
        <p class="muted">Type <code>DELETE_ROLES</code> exactly.</p>
        <div class="actions"><a class="btn" href="/danger">Back</a></div>
      </div>
    `));
  }

  const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);

  let out;
  try {
    out = await deleteAllRoles({ guild, io });
    await fullSync({ client, db, guildId: GUILD_ID });
  } catch (e) {
    return res.status(500).type("html").send(layout("Failed", `
      <div class="card">
        <h1>Delete failed</h1>
        <div class="alert">${escapeHtml(String(e?.message || e))}</div>
        <div class="actions"><a class="btn" href="/danger">Back</a></div>
      </div>
    `));
  }

  const failuresHtml = (out.failures || []).slice(0, 25).map(f => `
    <li class="mono">${escapeHtml(f.name || "")} (${escapeHtml(f.id)}): ${escapeHtml(f.error)}</li>
  `).join("");

  res.type("html").send(layout("Done", `
    <div class="card">
      <h1>Delete roles complete</h1>
      <p class="muted">Deleted: <code>${out.deleted}</code> • Skipped (managed): <code>${out.skipped}</code> • Failed: <code>${out.failed}</code></p>
      ${out.failed ? `<div class="card" style="margin-top:12px"><h2>Failures (first 25)</h2><ul>${failuresHtml}</ul></div>` : ""}
      <div class="actions"><a class="btn" href="/">Home</a><a class="btn" href="/danger">Back</a></div>
    </div>
  `));
});



// JSON Import (create roles/channels with permissions + overwrites)
function exampleImportJson() {
  return {
    roles: [
      {
        name: "Admin",
        color: "#ff0000",
        hoist: true,
        mentionable: true,
        permissions: ["Administrator"]
      },
      {
        name: "Member",
        permissions: ["ViewChannel", "SendMessages", "ReadMessageHistory"]
      }
    ],
    channels: [
      { type: "GuildCategory", name: "Info" },
      {
        type: "GuildText",
        name: "rules",
        parent: "Info",
        topic: "Read the rules",
        overwrites: [
          { target: "@everyone", deny: ["SendMessages"] },
          { target: "Admin", allow: ["ViewChannel", "SendMessages", "ManageMessages"] }
        ]
      }
    ]
  };
}

app.get("/import", (_req, res) => {
  const example = JSON.stringify(exampleImportJson(), null, 2);
  res.type("html").send(layout("JSON Import", `
    <div class="card">
      <h1>JSON Import</h1>
      <p class="muted">Paste JSON to create roles and channels (including channel permission overwrites).</p>
      <p class="muted">To enable: set <code>ALLOW_IMPORT=1</code> and <code>ADMIN_KEY</code> in your .env.</p>

      <div class="card" style="margin-top:14px">
        <h2>Import JSON</h2>
        <form method="POST" action="/import/apply">
          <div class="grid">
            <label class="wide">
              <span>Admin key</span>
              <input name="admin_key" class="mono" placeholder="ADMIN_KEY" required />
            </label>
            <label class="wide">
              <span>JSON</span>
              <textarea name="json" class="mono" rows="20" style="width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(2,6,23,.55);color:var(--text)" required>${escapeHtml(example)}</textarea>
            </label>
            <label class="wide">
              <span>Type this to confirm</span>
              <input name="confirm" class="mono" placeholder="APPLY_IMPORT" required />
            </label>
          </div>

          <div class="actions" style="justify-content:center">
            <button class="btn btn-primary" type="submit">Apply import</button>
            <a class="btn" href="/">Back</a>
          </div>
        </form>

        <div class="note muted">
          Overwrite targets can be role names, role IDs, or <code>@everyone</code>.
          Channels can reference a parent category by name or ID.
        </div>
      </div>
    </div>
  `));
});

function resolveRoleTargetId(guild, createdRoleIdsByName, target) {
  if (!target) return null;
  if (target === "@everyone") return guild.id;

  const s = String(target).trim();
  if (!s) return null;

  if (/^\d{15,25}$/.test(s)) return s;

  if (createdRoleIdsByName[s]) return createdRoleIdsByName[s];

  const found = guild.roles.cache.find((r) => r.name === s);
  return found ? found.id : null;
}

function resolveCategoryId(guild, createdCategoryIdsByName, parent) {
  if (!parent) return null;
  const s = String(parent).trim();
  if (!s) return null;
  if (/^\d{15,25}$/.test(s)) return s;
  if (createdCategoryIdsByName[s]) return createdCategoryIdsByName[s];
  const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === s);
  return found ? found.id : null;
}

function buildOverwrites(guild, createdRoleIdsByName, overwrites) {
  if (!Array.isArray(overwrites) || overwrites.length === 0) return undefined;
  const out = [];
  for (const ow of overwrites) {
    if (!ow || typeof ow !== "object") continue;
    const target = ow.target ?? ow.role ?? ow.targetId ?? ow.id;
    const id = resolveRoleTargetId(guild, createdRoleIdsByName, target);
    if (!id) throw new Error(`Unknown overwrite target: ${String(target)}`);

    const allow = resolveOverwritePerms(ow.allow);
    const deny = resolveOverwritePerms(ow.deny);

    out.push({ id, allow, deny });
  }
  return out;
}

async function applyImport({ guild, payload }) {
  if (!payload || typeof payload !== "object") throw new Error("JSON must be an object");
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  const channels = Array.isArray(payload.channels) ? payload.channels : [];

  if (roles.length > 250) throw new Error("Too many roles (max 250)");
  if (channels.length > 500) throw new Error("Too many channels (max 500)");

  // One fetch up-front for name lookups against existing roles/channels.
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);

  const createdRoleIdsByName = {};
  const createdCategoryIdsByName = {};

  const report = {
    rolesCreated: [],
    rolesFailed: [],
    channelsCreated: [],
    channelsFailed: [],
  };

  // Keep concurrency conservative to avoid hammering rate limits.
  const ROLE_CONCURRENCY = 3;
  const CHANNEL_CONCURRENCY = 2;

  // Create roles first (so channel overwrites can reference them)
  const roleResults = await promisePool(ROLE_CONCURRENCY, roles, async (r) => {
    const name = String(r?.name || "").trim();
    if (!name) throw new Error("Role name required");
    const perms = resolvePermissions(r.permissions);
    const color = parseHexColor(r.color);
    const hoist = !!r.hoist;
    const mentionable = !!r.mentionable;

    const created = await guild.roles.create({
      name,
      permissions: perms,
      color: color === null ? undefined : color,
      hoist,
      mentionable,
      reason: "JSON Import",
    });

    return { id: created.id, name };
  });

  for (let i = 0; i < roleResults.length; i++) {
    const r = roles[i];
    const out = roleResults[i];
    if (out && out.__error) {
      report.rolesFailed.push({ name: r?.name, error: String(out.error?.message || out.error) });
    } else {
      createdRoleIdsByName[out.name] = out.id;
      report.rolesCreated.push(out);
    }
  }

  // Partition channels by type (categories first so parents exist)
  const categories = [];
  const nonCategories = [];
  for (const c of channels) {
    try {
      const t = resolveChannelType(c?.type);
      if (t === ChannelType.GuildCategory) categories.push(c);
      else nonCategories.push(c);
    } catch (e) {
      report.channelsFailed.push({ name: c?.name, type: c?.type, error: String(e?.message || e) });
    }
  }

  // Create categories
  const catResults = await promisePool(CHANNEL_CONCURRENCY, categories, async (c) => {
    const type = resolveChannelType(c.type);
    const name = String(c?.name || "").trim();
    if (!name) throw new Error("Channel name required");
    const created = await guild.channels.create({ name, type, reason: "JSON Import" });
    return { id: created.id, name, type: "GuildCategory" };
  });

  for (let i = 0; i < catResults.length; i++) {
    const c = categories[i];
    const out = catResults[i];
    if (out && out.__error) {
      report.channelsFailed.push({ name: c?.name, type: c?.type, error: String(out.error?.message || out.error) });
    } else {
      createdCategoryIdsByName[out.name] = out.id;
      report.channelsCreated.push(out);
    }
  }

  // Create non-category channels
  const chanResults = await promisePool(CHANNEL_CONCURRENCY, nonCategories, async (c) => {
    const type = resolveChannelType(c.type);
    const name = String(c?.name || "").trim();
    if (!name) throw new Error("Channel name required");

    const parent = resolveCategoryId(guild, createdCategoryIdsByName, c.parent);

    const opts = {
      name,
      type,
      parent: parent || null,
      reason: "JSON Import",
    };

    if (c.topic !== undefined) opts.topic = String(c.topic || "");
    if (c.nsfw !== undefined) opts.nsfw = !!c.nsfw;

    const rl = c.rateLimitPerUser ?? c.rate_limit;
    if (rl !== undefined && Number.isFinite(Number(rl))) opts.rateLimitPerUser = Math.max(0, parseInt(rl, 10));

    if (c.bitrate !== undefined && Number.isFinite(Number(c.bitrate))) opts.bitrate = Math.max(8000, parseInt(c.bitrate, 10));

    const ul = c.userLimit ?? c.user_limit;
    if (ul !== undefined && Number.isFinite(Number(ul))) opts.userLimit = Math.max(0, parseInt(ul, 10));

    const overwrites = buildOverwrites(guild, createdRoleIdsByName, c.overwrites || c.permissionOverwrites);
    if (overwrites) opts.permissionOverwrites = overwrites;

    const created = await guild.channels.create(opts);
    return { id: created.id, name, type: String(c.type) };
  });

  for (let i = 0; i < chanResults.length; i++) {
    const c = nonCategories[i];
    const out = chanResults[i];
    if (out && out.__error) {
      report.channelsFailed.push({ name: c?.name, type: c?.type, error: String(out.error?.message || out.error) });
    } else {
      report.channelsCreated.push(out);
    }
  }

  return report;
}

app.post("/import/apply", async (req, res) => {
  if (!requireImport(req, res)) return;
  if (String(req.body.confirm || "").trim() !== "APPLY_IMPORT") {
    return res.status(400).type("html").send(layout("Confirm", `
      <div class="card">
        <h1>Confirmation phrase mismatch</h1>
        <p class="muted">Type <code>APPLY_IMPORT</code> exactly.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/import">Back</a></div>
      </div>
    `));
  }

  let payload;
  try {
    payload = JSON.parse(String(req.body.json || ""));
  } catch (e) {
    return res.status(400).type("html").send(layout("Invalid JSON", `
      <div class="card">
        <h1>Invalid JSON</h1>
        <div class="alert">${escapeHtml(String(e?.message || e))}</div>
        <div class="actions" style="justify-content:center"><a class="btn" href="/import">Back</a></div>
      </div>
    `));
  }

  const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);

  let report;
  try {
    report = await applyImport({ guild, payload });
    await fullSync({ client, db, guildId: GUILD_ID });
    io.emit("mirror:sync", { reason: "import_apply", at: Date.now() });
  } catch (e) {
    return res.status(500).type("html").send(layout("Import Failed", `
      <div class="card">
        <h1>Import failed</h1>
        <div class="alert">${escapeHtml(String(e?.message || e))}</div>
        <div class="actions" style="justify-content:center"><a class="btn" href="/import">Back</a></div>
      </div>
    `));
  }

  const list = (arr, title) => {
    if (!arr || !arr.length) return `<div class="card" style="margin-top:12px"><h2>${title}</h2><p class="muted">None</p></div>`;
    const items = arr.slice(0, 50).map(x => `<li class="mono">${escapeHtml(JSON.stringify(x))}</li>`).join("");
    const note = arr.length > 50 ? `<div class="muted small">Showing first 50 of ${arr.length}</div>` : "";
    return `<div class="card" style="margin-top:12px"><h2>${title}</h2>${note}<ul>${items}</ul></div>`;
  };

  res.type("html").send(layout("Import Result", `
    <div class="card">
      <h1>Import complete</h1>
      <p class="muted">Roles created: <code>${report.rolesCreated.length}</code> • Roles failed: <code>${report.rolesFailed.length}</code></p>
      <p class="muted">Channels created: <code>${report.channelsCreated.length}</code> • Channels failed: <code>${report.channelsFailed.length}</code></p>

      ${list(report.rolesCreated, "Roles created")}
      ${list(report.rolesFailed, "Roles failed")}
      ${list(report.channelsCreated, "Channels created")}
      ${list(report.channelsFailed, "Channels failed")}

      <div class="actions" style="justify-content:center">
        <a class="btn" href="/">Home</a>
        <a class="btn" href="/import">Back to import</a>
      </div>
    </div>
  `));
});



// Role assignment (bulk)
app.get("/assign", async (_req, res) => {
  const roles = await dbAll(db, `SELECT id, name, position, managed FROM roles ORDER BY position DESC, name ASC`);
  const options = roles
    .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}${r.managed ? " (managed)" : ""} • ${escapeHtml(r.id)}</option>`)
    .join("");

  res.type("html").send(layout("Assign Roles", `
    <div class="card">
      <h1>Assign roles</h1>
      <p class="muted">Add or remove a role for one user or a bulk list of user IDs.</p>
      <p class="muted">To enable: set <code>ALLOW_ASSIGN=1</code> and <code>ADMIN_KEY</code> in your .env.</p>

      <div class="card" style="margin-top:14px">
        <h2>Bulk role change</h2>

        <form method="POST" action="/assign/apply">
          <div class="grid">
            <label class="wide">
              <span>Admin key</span>
              <input name="admin_key" class="mono" placeholder="ADMIN_KEY" required />
            </label>

            <label class="wide">
              <span>Action</span>
              <select name="action">
                <option value="add">Add role</option>
                <option value="remove">Remove role</option>
              </select>
            </label>

            <label class="wide">
              <span>Role</span>
              <select name="role_id" required>
                ${options || ""}
              </select>
            </label>

            <label class="wide">
              <span>User IDs (one per line, or separated by spaces/commas)</span>
              <textarea name="user_ids" class="mono" rows="10" style="width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(2,6,23,.55);color:var(--text)" placeholder="123...\n456...\n789..." required></textarea>
            </label>

            <label class="wide">
              <span>Type this to confirm</span>
              <input name="confirm" class="mono" placeholder="APPLY_ASSIGN" required />
            </label>
          </div>

          <div class="actions" style="justify-content:center">
            <button class="btn btn-primary" type="submit">Apply</button>
            <a class="btn" href="/">Back</a>
          </div>
        </form>

        <div class="note muted">
          Notes:
          <ul>
            <li>Bot must have <strong>Manage Roles</strong>, and the target role must be below the bot’s top role.</li>
            <li>Managed roles (integrations) usually can’t be assigned.</li>
            <li>Large batches may take time due to Discord rate limits; the bot will queue requests automatically.</li>
          </ul>
        </div>
      </div>
    </div>
  `));
});

app.post("/assign/apply", async (req, res) => {
  if (!requireAssign(req, res)) return;

  if (String(req.body.confirm || "").trim() !== "APPLY_ASSIGN") {
    return res.status(400).type("html").send(layout("Confirm", `
      <div class="card">
        <h1>Confirmation phrase mismatch</h1>
        <p class="muted">Type <code>APPLY_ASSIGN</code> exactly.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/assign">Back</a></div>
      </div>
    `));
  }

  const action = String(req.body.action || "add").trim();
  const roleId = String(req.body.role_id || "").trim();
  const userIds = parseUserIdList(req.body.user_ids);

  if (!/^\d{15,25}$/.test(roleId)) {
    return res.status(400).type("html").send(layout("Invalid role", `
      <div class="card">
        <h1>Invalid role</h1>
        <p class="muted">Select a valid role.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/assign">Back</a></div>
      </div>
    `));
  }

  if (!userIds.length) {
    return res.status(400).type("html").send(layout("No users", `
      <div class="card">
        <h1>No valid user IDs</h1>
        <p class="muted">Paste at least one valid Discord user ID (15–25 digits).</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/assign">Back</a></div>
      </div>
    `));
  }

  const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    return res.status(404).type("html").send(layout("Role not found", `
      <div class="card">
        <h1>Role not found</h1>
        <p class="muted">That role does not exist in this server.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/assign">Back</a></div>
      </div>
    `));
  }

  const report = { action, role: { id: role.id, name: role.name }, total: userIds.length, ok: [], failed: [] };

  for (const uid of userIds) {
    try {
      const member = await guild.members.fetch(uid);
      if (action === "remove") {
        await member.roles.remove(role.id, "Role assignment (panel)");
      } else {
        await member.roles.add(role.id, "Role assignment (panel)");
      }
      report.ok.push(uid);
    } catch (e) {
      report.failed.push({ id: uid, error: String(e?.message || e) });
    }
  }

  io.emit("mirror:sync", { reason: "assign_roles", at: Date.now() });

  const failuresHtml = report.failed.slice(0, 50).map(f => `<li class="mono">${escapeHtml(f.id)}: ${escapeHtml(f.error)}</li>`).join("");
  const note = report.failed.length > 50 ? `<div class="muted small">Showing first 50 of ${report.failed.length} failures</div>` : "";

  res.type("html").send(layout("Assign result", `
    <div class="card">
      <h1>Role assignment complete</h1>
      <p class="muted">Action: <code>${escapeHtml(report.action)}</code> • Role: <code>${escapeHtml(report.role.name)}</code> (${escapeHtml(report.role.id)})</p>
      <p class="muted">Users: <code>${report.total}</code> • Success: <code>${report.ok.length}</code> • Failed: <code>${report.failed.length}</code></p>

      ${report.failed.length ? `
        <div class="card" style="margin-top:12px;border-color:rgba(239,68,68,.55)">
          <h2>Failures</h2>
          ${note}
          <ul>${failuresHtml}</ul>
        </div>
      ` : ""}

      <div class="actions" style="justify-content:center">
        <a class="btn" href="/assign">Back</a>
        <a class="btn" href="/">Home</a>
      </div>
    </div>
  `));
});



// User export (dump all member IDs)
const exportStore = new Map(); // id -> { createdAt, count, includeBots, idsPath, csvPath, jsonPath }

function exportsDir() {
  return path.join(DATA_DIR, "exports");
}

async function runUserExport({ guild, includeBots }) {
  await guild.members.fetch(); // requires GuildMembers intent + portal toggle

  const rows = [];
  const ids = [];

  for (const [, member] of guild.members.cache) {
    const u = member.user;
    if (!includeBots && u.bot) continue;
    ids.push(u.id);
    rows.push({
      id: u.id,
      username: u.username || "",
      globalName: u.globalName || "",
      isBot: !!u.bot,
    });
  }

  ids.sort();

  await fs.promises.mkdir(exportsDir(), { recursive: true });

  const stamp = now();
  const baseName = `guild-${guild.id}-${stamp}${includeBots ? "-with-bots" : ""}`;

  const idsPath = path.join(exportsDir(), `${baseName}-ids.txt`);
  const csvPath = path.join(exportsDir(), `${baseName}-members.csv`);
  const jsonPath = path.join(exportsDir(), `${baseName}-members.json`);

  await fs.promises.writeFile(idsPath, ids.join("\n") + "\n", "utf8");
  await fs.promises.writeFile(csvPath, membersToCsv(rows), "utf8");
  await fs.promises.writeFile(
    jsonPath,
    JSON.stringify(
      { guildId: guild.id, dumpedAt: new Date().toISOString(), includeBots, count: rows.length, members: rows },
      null,
      2
    ),
    "utf8"
  );

  const exportId = `${stamp}-${Math.random().toString(16).slice(2)}`;
  exportStore.set(exportId, {
    createdAt: Date.now(),
    count: rows.length,
    includeBots,
    idsPath,
    csvPath,
    jsonPath,
  });

  return { exportId, count: rows.length, idsPath, csvPath, jsonPath, idsPreview: ids.slice(0, 200) };
}

app.get("/export", async (_req, res) => {
  res.type("html").send(layout("Export Users", `
    <div class="card">
      <h1>Export users</h1>
      <p class="muted">Dump all member user IDs from the guild into files and download them from the panel.</p>
      <p class="muted">To enable: set <code>ALLOW_EXPORT=1</code> and <code>ADMIN_KEY</code> in your .env.</p>

      <div class="card" style="margin-top:14px">
        <h2>Run export</h2>
        <form method="POST" action="/export/run">
          <div class="grid">
            <label class="wide">
              <span>Admin key</span>
              <input name="admin_key" class="mono" placeholder="ADMIN_KEY" required />
            </label>

            <label class="wide" style="display:flex;gap:10px;align-items:center;justify-content:center;padding-top:10px">
              <input type="checkbox" name="include_bots" />
              <span>Include bots</span>
            </label>

            <label class="wide">
              <span>Type this to confirm</span>
              <input name="confirm" class="mono" placeholder="EXPORT_USERS" required />
            </label>
          </div>

          <div class="actions" style="justify-content:center">
            <button class="btn btn-primary" type="submit">Export now</button>
            <a class="btn" href="/">Back</a>
          </div>
        </form>

        <div class="note muted">
          This requires the bot to have the <strong>Server Members Intent</strong> enabled in the Discord Developer Portal.
        </div>
      </div>
    </div>
  `));
});

app.post("/export/run", async (req, res) => {
  if (!requireExport(req, res)) return;

  if (String(req.body.confirm || "").trim() !== "EXPORT_USERS") {
    return res.status(400).type("html").send(layout("Confirm", `
      <div class="card">
        <h1>Confirmation phrase mismatch</h1>
        <p class="muted">Type <code>EXPORT_USERS</code> exactly.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/export">Back</a></div>
      </div>
    `));
  }

  const includeBots = boolFromForm(req.body.include_bots);
  const adminKey = String(req.body.admin_key || "").trim(); // reused for download forms only

  const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);

  let out;
  try {
    out = await runUserExport({ guild, includeBots });
  } catch (e) {
    return res.status(500).type("html").send(layout("Export Failed", `
      <div class="card">
        <h1>Export failed</h1>
        <div class="alert">${escapeHtml(String(e?.message || e))}</div>
        <div class="actions" style="justify-content:center"><a class="btn" href="/export">Back</a></div>
      </div>
    `));
  }

  const preview = out.idsPreview.map((id) => `<div class="mono">${escapeHtml(id)}</div>`).join("");
  const hiddenKey = escapeHtml(adminKey);

  const dlForm = (kind, label) => `
    <form method="POST" action="/export/download" style="display:inline-flex;gap:10px;align-items:center">
      <input type="hidden" name="admin_key" value="${hiddenKey}" />
      <input type="hidden" name="export_id" value="${escapeHtml(out.exportId)}" />
      <input type="hidden" name="kind" value="${escapeHtml(kind)}" />
      <button class="btn" type="submit">${label}</button>
    </form>
  `;

  res.type("html").send(layout("Export Result", `
    <div class="card">
      <h1>Export complete ✅</h1>
      <p class="muted">Members exported: <code>${out.count}</code> • Include bots: <code>${includeBots ? "true" : "false"}</code></p>

      <div class="card" style="margin-top:12px">
        <h2>Download</h2>
        <div class="actions" style="justify-content:center;flex-wrap:wrap">
          ${dlForm("ids", "Download IDs (.txt)")}
          ${dlForm("csv", "Download Members (.csv)")}
          ${dlForm("json", "Download Members (.json)")}
        </div>
        <div class="note muted">Files are also saved on disk under <code>data/wsd/exports/</code>.</div>
      </div>

      <div class="card" style="margin-top:12px">
        <h2>Preview (first 200 IDs)</h2>
        <div style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:12px;padding:10px;background:rgba(2,6,23,.45);text-align:left">
          ${preview || "<div class='muted'>No IDs</div>"}
        </div>
      </div>

      <div class="actions" style="justify-content:center;margin-top:12px">
        <a class="btn" href="/export">Run another export</a>
        <a class="btn" href="/">Home</a>
      </div>
    </div>
  `));
});

app.post("/export/download", async (req, res) => {
  if (!requireExport(req, res)) return;

  const exportId = String(req.body.export_id || "").trim();
  const kind = String(req.body.kind || "").trim();

  const entry = exportStore.get(exportId);
  if (!entry) {
    return res.status(404).type("html").send(layout("Not found", `
      <div class="card">
        <h1>Export not found</h1>
        <p class="muted">Run the export again and download right after.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/export">Back</a></div>
      </div>
    `));
  }

  const map = { ids: entry.idsPath, csv: entry.csvPath, json: entry.jsonPath };
  const filePath = map[kind];
  if (!filePath) return res.status(400).send("Invalid kind");

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    return res.status(404).type("html").send(layout("Missing", `
      <div class="card">
        <h1>File missing</h1>
        <p class="muted">The export file was not found on disk.</p>
        <div class="actions" style="justify-content:center"><a class="btn" href="/export">Back</a></div>
      </div>
    `));
  }

  res.download(filePath, path.basename(filePath));
});


    // JSON APIs
    app.get("/api/roles", async (_req, res) => {
      const roles = await dbAll(db, `SELECT * FROM roles ORDER BY position DESC, name ASC`);
      res.json({ roles });
    });

    app.get("/api/channels", async (_req, res) => {
      const channels = await dbAll(db, `SELECT * FROM channels ORDER BY parent_id IS NULL DESC, parent_id ASC, position ASC, name ASC`);
      res.json({ channels });
    });

    // Discord mirror events
    let syncing = false;
    async function syncWithLock(reason) {
      if (syncing) return;
      syncing = true;
      try {
        const res = await fullSync({ client, db, guildId: GUILD_ID });
        io.emit("mirror:sync", { reason, ...res, at: Date.now() });
      } catch (err) {
        console.error("[mirror] sync error:", err);
        io.emit("mirror:error", { reason, message: String(err?.message || err) });
      } finally {
        syncing = false;
      }
    }

    client.once("ready", async () => {
      console.log(`[discord] Logged in as ${client.user.tag}`);
      await syncWithLock("startup");
      setInterval(() => syncWithLock("interval"), 60_000);
    });

    client.on("roleCreate", async (role) => {
      if (role.guild?.id !== GUILD_ID) return;
      try { await upsertRole(db, role); io.emit("mirror:role", { action: "create", id: role.id }); } catch (e) { console.error(e); }
    });

    client.on("roleUpdate", async (_oldRole, newRole) => {
      if (newRole.guild?.id !== GUILD_ID) return;
      try { await upsertRole(db, newRole); io.emit("mirror:role", { action: "update", id: newRole.id }); } catch (e) { console.error(e); }
    });

    client.on("roleDelete", async (role) => {
      if (role.guild?.id !== GUILD_ID) return;
      try { await dbRun(db, `DELETE FROM roles WHERE id=?`, [role.id]); io.emit("mirror:role", { action: "delete", id: role.id }); } catch (e) { console.error(e); }
    });

    client.on("channelCreate", async (ch) => {
      if (ch.guild?.id !== GUILD_ID) return;
      if (ch.isThread?.()) return;
      try { await upsertChannel(db, ch); io.emit("mirror:channel", { action: "create", id: ch.id }); } catch (e) { console.error(e); }
    });

    client.on("channelUpdate", async (_oldCh, newCh) => {
      if (newCh.guild?.id !== GUILD_ID) return;
      if (newCh.isThread?.()) return;
      try { await upsertChannel(db, newCh); io.emit("mirror:channel", { action: "update", id: newCh.id }); } catch (e) { console.error(e); }
    });

    client.on("channelDelete", async (ch) => {
      if (ch.guild?.id !== GUILD_ID) return;
      if (ch.isThread?.()) return;
      try { await dbRun(db, `DELETE FROM channels WHERE id=?`, [ch.id]); io.emit("mirror:channel", { action: "delete", id: ch.id }); } catch (e) { console.error(e); }
    });

    server.listen(PORT_NUM, HOST, () => {
      console.log(`[web] ${BASE_URL} (listening on ${HOST}:${PORT_NUM})`);
      console.log(`[web] WARNING: no auth enabled`);
      if (ALLOW_DANGER) console.log(`[web] Danger Zone enabled (/danger)`);
      if (ALLOW_IMPORT) console.log(`[web] JSON Import enabled (/import)`);
      if (ALLOW_ASSIGN) console.log(`[web] Role assignment enabled (/assign)`);
      if (ALLOW_EXPORT) console.log(`[web] User export enabled (/export)`);
    });

    await client.login(BOT_TOKEN);

    process.on("SIGINT", async () => {
      console.log("Shutting down...");
      try { await client.destroy(); } catch {}
      try { server.close(); } catch {}
      try { db.close(); } catch {}
      process.exit(0);
    });
  }

  main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
