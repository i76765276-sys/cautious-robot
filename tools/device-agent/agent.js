"use strict";

/**
 * WRLD Device Agent
 * Usage:
 *   node agent.js --base http://localhost:3000 --key YOUR_API_KEY --device "My PC"
 */

const fs = require("fs");
const path = require("path");

function arg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return String(process.argv[idx + 1] || fallback);
}

async function main() {
  const base = arg("base", "http://localhost:3000").replace(/\/$/, "");
  const key = arg("key", "");
  const device = arg("device", "Device Agent");

  if (!key) {
    console.error("Missing --key YOUR_API_KEY");
    process.exit(1);
  }

  const appsPath = path.join(__dirname, "apps.json");
  if (!fs.existsSync(appsPath)) {
    console.error("Missing apps.json. Create tools/device-agent/apps.json");
    process.exit(1);
  }

  let apps = [];
  try {
    apps = JSON.parse(fs.readFileSync(appsPath, "utf8"));
  } catch (e) {
    console.error("apps.json is not valid JSON");
    process.exit(1);
  }

  if (!Array.isArray(apps)) {
    console.error("apps.json must be an array");
    process.exit(1);
  }

  const res = await fetch(`${base}/api/device/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ device_tag: device, apps }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("Report failed:", res.status, data || {});
    process.exit(1);
  }

  console.log("✅ Report sent:", data);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
