"use strict";

function $(id){ return document.getElementById(id); }

function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function renderApps(apps){
  const body = $("appsBody");
  const meta = $("appsMeta");
  const updated = $("appsUpdated");
  if (!body) return;

  meta.textContent = `${apps.length} app${apps.length===1?"":"s"}`;

  if (!apps.length){
    body.innerHTML = `<tr><td colspan="3" class="muted">No WRLD ENT apps reported yet for this device.</td></tr>`;
    if (updated && window.__dash?.reportUpdatedAt){
      updated.textContent = `Updated: ${new Date(window.__dash.reportUpdatedAt).toLocaleString()}`;
    }
    return;
  }

  body.innerHTML = apps.map(a => `
    <tr>
      <td>${esc(a.name)}</td>
      <td class="mono">${esc(a.version || "-")}</td>
      <td class="mono">${esc(a.source || "agent")}</td>
    </tr>
  `).join("");

  if (updated){
    updated.textContent = window.__dash?.reportUpdatedAt
      ? `Updated: ${new Date(window.__dash.reportUpdatedAt).toLocaleString()}`
      : "Updated: just now";
  }
}

async function fetchDevices(){
  const r = await fetch("/api/device/devices", { credentials: "same-origin" });
  const j = await r.json().catch(()=>null);
  if (!j?.ok) return [];
  return j.devices || [];
}

async function fetchApps(deviceTag){
  const u = new URL("/api/device/apps", window.location.origin);
  if (deviceTag) u.searchParams.set("device_tag", deviceTag);
  const r = await fetch(u.toString(), { credentials: "same-origin" });
  const j = await r.json().catch(()=>null);
  if (!j?.ok) return { apps: [], updated_at: null, device_tag: deviceTag || "" };
  return j;
}

function setNeedsAgentUI(hasAnyReports){
  const gate = $("agentGate");
  const appsCard = $("appsCard");
  if (!gate || !appsCard) return;

  if (hasAnyReports){
    gate.style.display = "none";
    appsCard.style.opacity = "1";
    appsCard.style.pointerEvents = "auto";
  } else {
    gate.style.display = "block";
    appsCard.style.opacity = "0.6";
    appsCard.style.pointerEvents = "none";
  }
}

async function refreshAll(){
  const devices = await fetchDevices();
  setNeedsAgentUI(devices.length > 0);

  const sel = $("deviceSelect");
  if (sel){
    const current = sel.value || "";
    sel.innerHTML = devices.length
      ? devices.map(d => `<option value="${esc(d.device_tag)}">${esc(d.device_tag)} • ${new Date(d.updated_at).toLocaleString()}</option>`).join("")
      : `<option value="">No devices yet</option>`;

    if (current && devices.some(d => d.device_tag === current)) sel.value = current;
    else if (window.__dash?.selectedDevice) sel.value = window.__dash.selectedDevice;
  }

  const chosen = (sel && sel.value) ? sel.value : (devices[0]?.device_tag || "");
  if (chosen){
    const data = await fetchApps(chosen);
    window.__dash = window.__dash || {};
    window.__dash.selectedDevice = data.device_tag;
    window.__dash.reportUpdatedAt = data.updated_at || null;
    renderApps(Array.isArray(data.apps) ? data.apps : []);
    const raw = $("rawLink");
    if (raw) raw.href = `/api/device/apps?device_tag=${encodeURIComponent(data.device_tag)}`;
  }
}

function wireSelect(){
  const sel = $("deviceSelect");
  if (!sel) return;

  sel.addEventListener("change", async () => {
    const tag = sel.value || "";
    const data = await fetchApps(tag);
    window.__dash = window.__dash || {};
    window.__dash.selectedDevice = data.device_tag;
    window.__dash.reportUpdatedAt = data.updated_at || null;
    renderApps(Array.isArray(data.apps) ? data.apps : []);
    const raw = $("rawLink");
    if (raw) raw.href = `/api/device/apps?device_tag=${encodeURIComponent(data.device_tag)}`;
  });
}

function wireSocket(){
  if (!window.io) return;

  const socket = window.io({
    transports: ["websocket", "polling"],
    withCredentials: true
  });

  socket.on("device:report", async (evt) => {
    await refreshAll();
    const sel = $("deviceSelect");
    const selected = sel?.value || window.__dash?.selectedDevice || "";
    if (evt?.device_tag && (evt.device_tag === selected || !selected)){
      const data = await fetchApps(evt.device_tag);
      window.__dash = window.__dash || {};
      window.__dash.selectedDevice = data.device_tag;
      window.__dash.reportUpdatedAt = data.updated_at || null;
      renderApps(Array.isArray(data.apps) ? data.apps : []);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  if (!window.__dash) window.__dash = {};
  wireSelect();
  await refreshAll();
  wireSocket();
});
