/* TrafficFlowDB v3 dashboard — vanilla JS, no build step.
   WS (/ws/live) streams traffic + positions + query log; HTTP polling backs it up. */
"use strict";

const API = "";
const COLORS = { LOW: "#30d158", MEDIUM: "#ffd60a", HIGH: "#ff453a" };
const VEH_COLORS = { car: "#0071e3", bus: "#ff9f0a", emergency: "#ff453a" };

const $ = (id) => document.getElementById(id);
// Null-safe binding. Every listener in this file goes through `on`, so a
// stale/mismatched document can never throw at module scope and kill the
// whole script (which previously left the page stuck on "connecting…").
function on(id, evt, fn) {
  const el = typeof id === "string" ? $(id) : id;
  if (el && el.addEventListener) el.addEventListener(evt, fn);
  return el;
}
let POLL_MS = 2000;

/* ---- theme -------------------------------------------------------------- */
function setTheme(t, animate = true) {
  const apply = () => document.documentElement.dataset.theme = t;
  try { localStorage.setItem("tfdb-theme", t); } catch { /* private mode */ }
  if (animate && document.startViewTransition) {
    const w = $("wipe");
    document.startViewTransition(apply);
    w.classList.remove("go"); void w.offsetWidth; w.classList.add("go");
  } else apply();
}
(function initTheme() {
  let t = "light";
  try { t = localStorage.getItem("tfdb-theme") || "light"; } catch { /* ignore */ }
  const qp = new URLSearchParams(location.search).get("theme");
  if (qp === "light" || qp === "dark") t = qp; // ?theme=dark deep-link
  document.documentElement.dataset.theme = t;
})();
on($("themeBtn"), "click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const w = $("wipe");
  w.style.setProperty("--wx", (r.left + r.width / 2) + "px");
  w.style.setProperty("--wy", (r.top + r.height / 2) + "px");
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  refreshTiles();
});

/* ---- map (decluttered): keyless OSM tiles + dark filter, auto-fit to the
   network, canvas renderer for smooth 200+ marker updates. ------------------- */
const TILES = {
  light: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  dark: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
};
const MAP_VIEW = { c: [22.8, 79.5], z: 5 };
/* The map element is optional: if markup drifts, the rest of the dashboard
   (analytics, SQL Lab, monitor) still runs instead of the script dying. */
const HAS_MAP = !!$("map");
const map = HAS_MAP
  ? L.map("map", { zoomControl: false, worldCopyJump: false, minZoom: 4,
                   preferCanvas: true, zoomAnimation: true,
                   fadeAnimation: true, markerZoomAnimation: false })
      .setView(MAP_VIEW.c, MAP_VIEW.z)
  : { addTo() { return this; }, removeLayer() {}, flyToBounds() {},
      fitBounds() {}, getZoom() { return 5; }, on() {}, eachLayer() {},
      whenReady(f) { f(); } };
const tileLayer = HAS_MAP ? L.tileLayer(TILES[document.documentElement.dataset.theme] || TILES.light, {
  maxZoom: 19, crossOrigin: true,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map) : { setUrl() {} };
if (HAS_MAP) L.control.zoom({ position: "bottomright" }).addTo(map);
if (HAS_MAP) {
  map.on("zoomend", () => {
    // vehicle dots appear/disappear by zoom — re-render from the last snapshot
    if (lastPositions.length) renderPositions(lastPositions);
  });
  setTimeout(() => { if (!didFit) { didFit = true; fitNetwork(); } }, 120);
}
function refreshTiles() {
  // OSM serves one style; dark mode is a CSS filter (see styles.css), so the
  // tile URL is identical and no reload is needed.
}

const segLines = new Map();
const nodeMarkers = new Map();
const segLayer = L.layerGroup().addTo(map);
const hubLayer = L.layerGroup().addTo(map);
const vehicleLayer = L.layerGroup().addTo(map);
const tomtomLayer = L.layerGroup().addTo(map);
const incidentLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
/* Speed-ratio colour ramp: 1.0 = free-flow (green) → 0 = stopped (red).
   Reads as a real traffic visualisation, not three flat buckets. */
function speedColor(ratio) {
  if (ratio >= 0.75) return "#34d058";
  if (ratio >= 0.5) return "#a3e635";
  if (ratio >= 0.3) return "#fbbf24";
  if (ratio >= 0.15) return "#fb923c";
  return "#f5455c";
}
const SEG_STYLE = {
  LOW: { weight: 2.5, opacity: 0.5 },
  MEDIUM: { weight: 4, opacity: 0.85 },
  HIGH: { weight: 6, opacity: 1 },
};
let segments = [], nodes = [], lastRouteSegs = [], lastTraffic = [], lastPositions = [];
let ttBySeg = new Map(); // segment_id -> TomTom reading (fresh only)
let didFit = false;

/* ---- helpers -------------------------------------------------------------- */
async function getJSON(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}
async function postJSON(path, body) {
  const r = await fetch(API + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || r.status);
  return data;
}
async function putJSON(path, body) {
  const r = await fetch(API + path, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
function setStatus(online, text) {
  $("statusDot").classList.toggle("on", online);
  $("livePill").textContent = text;
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function tweenNum(el, to, suffix = "") {
  const from = parseFloat(el.dataset.v || "0");
  el.dataset.v = to;
  const t0 = performance.now();
  (function step(t) {
    const k = Math.max(0, Math.min((t - t0) / 600, 1));
    const v = from + (to - from) * (1 - Math.pow(1 - k, 3));
    el.textContent = (Number.isInteger(to) ? Math.round(v) : v.toFixed(2)) + suffix;
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

/* ---- network --------------------------------------------------------------- */
function optGroups(list) {
  const nat = list.filter((n) => n.scope === "national");
  const met = list.filter((n) => n.scope !== "national");
  const g = (t, arr) => arr.length
    ? `<optgroup label="${t}">${arr.map((n) => `<option value="${n.id}">${n.name}</option>`).join("")}</optgroup>` : "";
  return g("National hubs", nat) + g("Other places", met);
}
async function loadNetwork() {
  [nodes, segments] = await Promise.all([
    getJSON("/api/network/intersections"),
    getJSON("/api/network/segments"),
  ]);
  const src = $("srcSel"), dst = $("dstSel");
  src.innerHTML = optGroups(nodes); dst.innerHTML = optGroups(nodes);
  src.value = 101; dst.value = 124; // Delhi -> Mumbai showcase
  const nat = nodes.filter((n) => n.scope === "national").length;
  $("netSub").textContent =
    `${nodes.length} intersections (${nat} national hubs) · ${segments.length} corridors · one row per segment, refreshed on every vendor poll.`;
  $("mapSub").textContent =
    `${nat} national hubs · ${segments.length} live corridors · hover a road for its measured speed, click an incident for detail.`;
  for (const n of nodes) {
    if (nodeMarkers.has(n.id)) continue;
    nodeMarkers.set(n.id, L.circleMarker([n.lat, n.lon], {
      radius: n.scope === "national" ? 4 : 2.5, color: "#0b1b2b", weight: 1.5,
      fillColor: "#ffffff", fillOpacity: 1,
    }).bindTooltip(n.name, { direction: "top", offset: [0, -3] }).addTo(hubLayer));
  }
  for (const s of segments) {
    if (segLines.has(s.id)) continue;
    // Prefer TomTom's own road alignment; fall back to the straight chord only
    // until this corridor has been probed at least once.
    const pts = (s.road_polyline && s.road_polyline.length >= 2)
      ? s.road_polyline.map((p) => [p[0], p[1]])
      : [[s.a_lat, s.a_lon], [s.b_lat, s.b_lon]];
    segLines.set(s.id, L.polyline(pts, {
      color: COLORS.LOW, weight: 2.5, opacity: 0.5, lineCap: "round",
    }).bindTooltip(
      `${s.name}<br>${s.distance_km} km · limit ${s.speed_limit} km/h` +
      (s.road_points ? `<br><span style="color:#a855f7">${s.road_points}-point TomTom road · ${s.frc}</span>` : "")
    ).addTo(segLayer));
  }
  fitNetwork(); // frame the whole network once, instead of guessing a view
}

/* Frame every corridor in view. Runs once (and on resize) so the graph fills
   the frame instead of sitting tiny in the middle of a default view. */
function networkBounds() {
  if (!segments.length) return null;
  const pts = [];
  for (const s of segments) pts.push([s.a_lat, s.a_lon], [s.b_lat, s.b_lon]);
  return pts;
}
function fitNetwork(animate = false) {
  if (!HAS_MAP || !segments.length) return;
  const b = networkBounds();
  try { map.fitBounds(b, { padding: [28, 28], animate, maxZoom: 7 }); }
  catch { /* container not laid out yet */ }
}

/* ---- live rendering ---------------------------------------------------------- */
function renderTraffic(rows) {
  lastTraffic = rows;
  let high = 0, med = 0;
  for (const t of rows) {
    const line = segLines.get(t.segment_id);
    if (line) {
      const st = SEG_STYLE[t.congestion_level] || SEG_STYLE.LOW;
      const tt = ttBySeg.get(t.segment_id);
      const obs = tt && tt.current_speed != null ? tt.current_speed : t.average_speed;
      const ratio = t.speed_limit_kmh ? Math.max(0, obs / t.speed_limit_kmh) : 1;
      line.setStyle({
        color: speedColor(ratio), ...st,
        ...(tt ? { shadowColor: "#a855f7", shadowBlur: 8 } : {}),
      });
      // NB: no setClassName here — the canvas renderer (preferCanvas) has no
      // CSS class support on paths and calling it throws, which used to abort
      // the whole render. Direction-of-flow is drawn on the overlay canvas.
      line.setTooltipContent(
        `<b>${t.segment_name}</b><br>${Number(t.average_speed).toFixed(0)} km/h · ` +
        `${t.vehicle_count} vehicles · ${t.congestion_level}` +
        (tt ? `<br><span style="color:#a855f7">TomTom ${Number(tt.current_speed).toFixed(0)} / free ${Number(tt.freeflow_speed).toFixed(0)} km/h</span>` : ""));
    }
    if (t.congestion_level === "HIGH") high++;
    else if (t.congestion_level === "MEDIUM") med++;
  }
  if (lastRouteSegs.length) drawRoute(lastRouteSegs, false);
  renderTable();
  return { high, med };
}

function renderPositions(rows) {
  lastPositions = rows || [];
  vehicleLayer.clearLayers();
  if (!lastPositions.length) return;
  const z = HAS_MAP ? map.getZoom() : 5;
  // Below z6 a national-scale map turns 200 dots into noise — corridors carry
  // the story there; individual vehicles only earn space when zoomed in.
  if (z < 6) return;
  const cap = 260, step = Math.max(1, Math.ceil(lastPositions.length / cap));
  for (let i = 0; i < lastPositions.length; i += step) {
    const p = lastPositions[i];
    L.circleMarker([p.latitude, p.longitude], {
      radius: 3.5, color: "#0b1b2b", weight: 1,
      fillColor: VEH_COLORS[p.vehicle_type] || VEH_COLORS.car,
      fillOpacity: 0.9,
    }).bindPopup(`${p.vehicle_number} · ${p.vehicle_type}<br>${Math.round(p.speed_kmh)} km/h`).addTo(vehicleLayer);
  }
}
function renderTomTom(readings) {
  tomtomLayer.clearLayers();
  ttBySeg = new Map();
  for (const r of readings || []) {
    if (r.current_speed == null) continue;
    ttBySeg.set(r.segment_id, r);
    if (r.mid_lat == null) continue;
    L.circleMarker([r.mid_lat, r.mid_lon], {
      radius: 3.5, color: "rgba(255,255,255,.85)", weight: 1,
      fillColor: "#a855f7", fillOpacity: 0.9,
    }).bindTooltip(`<b>${r.segment_name}</b><br>TomTom ${Number(r.current_speed).toFixed(0)} / ${Number(r.freeflow_speed).toFixed(0)} km/h` +
      `<br><span style="opacity:.7">${r.fetched_at ? new Date(r.fetched_at).toLocaleTimeString() : ""}</span>`).addTo(tomtomLayer);
  }
}
function renderStats(s, cong) {
  // Hero mirrors the live source of truth: real vendor coverage, not fleet counts.
  tweenNum($("hsVehicles"), lastTraffic.filter((t) => t.traffic_source === "tomtom").length);
  tweenNum($("hsCongested"), cong.high + cong.med);
  tweenNum($("hsRoutes"), s.routes_computed);
  $("hsQuery").textContent = s.query_ms + " ms";
  getJSON("/api/tomtom/status").then((tt) => {
    tweenNum($("hsFixes"), tt.est_daily_use);
    $("hsFixes").nextElementSibling.textContent = `vendor calls / day (${tt.used_today} used)`;
  }).catch(() => {});
}
function renderTable() {
  $("netBody").innerHTML = lastTraffic.map((t) => {
    const s = segments.find((x) => x.id === t.segment_id);
    const idx = Number(t.traffic_index || 0);
    const tt = ttBySeg.get(t.segment_id);
    return `
    <tr><td>${t.segment_name}</td>
    <td><span class="scope-tag ${t.scope}">${t.scope}</span></td>
    <td>${t.distance_km}</td>
    <td><b>${Number(t.average_speed).toFixed(0)}</b></td>
    <td>${tt ? Number(tt.freeflow_speed).toFixed(0) : "—"}</td>
    <td>${(idx * 100).toFixed(0)}%</td>
    <td><span class="pill ${t.congestion_level}">${t.congestion_level}</span></td>
    <td class="tt-cell">${s && s.road_points ? s.road_points + " pts · " + s.frc : "—"}</td></tr>`;
  }).join("");
}
/* ---- layer toggles ---------------------------------------------------------- */
function wireLayers() {
  const mapOf = { lyrSeg: segLayer, lyrHub: hubLayer, lyrTT: tomtomLayer, lyrInc: incidentLayer };
  for (const [id, layer] of Object.entries(mapOf)) {
    $(id).addEventListener("change", (e) => {
      if (e.target.checked) layer.addTo(map);
      else map.removeLayer(layer);
    });
  }
}
/* ---- analytics (graphs lead the page) ---------------------------------------- */
function ctx2d(id) {
  const c = $(id);
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || c.parentElement.clientWidth || 300;
  const h = 220;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return [g, w, h];
}
function cssVar(name, fb) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}
function drawLine(id, pts, color, unit) {
  if (!$(id)) return;
  const [g, w, h] = ctx2d(id);
  const pad = { l: 38, r: 10, t: 12, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  if (pts.length < 2) {
    // Honest empty state instead of a blank canvas.
    g.fillStyle = "#8e8e93"; g.font = "12px sans-serif"; g.textAlign = "center";
    g.fillText(pts.length ? "collecting… 1 point so far" : "no data yet", w / 2, h / 2 - 6);
    g.font = "11px sans-serif";
    g.fillText("trends appear after a few minutes of live traffic", w / 2, h / 2 + 12);
    g.textAlign = "left";
    return;
  }
  const vals = pts.map((p) => p.v);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const padv = Math.max((mx - mn) * 0.18, mx * 0.04, 1);
  const lo = Math.max(0, mn - padv), hi = mx + padv;
  const X = (i) => pad.l + (i / (pts.length - 1)) * iw;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
  g.strokeStyle = "rgba(128,128,128,.22)"; g.lineWidth = 1;
  g.beginPath();
  for (let k = 0; k <= 3; k++) {
    const y = Math.round(pad.t + (k / 3) * ih) + 0.5;
    g.moveTo(pad.l, y); g.lineTo(w - pad.r, y);
  }
  g.stroke();
  // gradient fill under the line
  const grad = g.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, color + "40"); grad.addColorStop(1, color + "02");
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(X(i), Y(p.v)) : g.moveTo(X(i), Y(p.v))));
  g.lineTo(X(pts.length - 1), h - pad.b); g.lineTo(X(0), h - pad.b); g.closePath();
  g.fillStyle = grad; g.fill();
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(X(i), Y(p.v)) : g.moveTo(X(i), Y(p.v))));
  g.strokeStyle = color; g.lineWidth = 2.4; g.lineJoin = "round";
  g.lineCap = "round"; g.stroke();
  // last-point marker
  const lx = X(pts.length - 1), ly = Y(vals[vals.length - 1]);
  g.beginPath(); g.arc(lx, ly, 3.5, 0, 6.2832);
  g.fillStyle = color; g.fill();
  g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke();
  g.fillStyle = "#8e8e93"; g.font = "10px sans-serif";
  g.fillText(hi.toFixed(0) + (unit || ""), 4, pad.t + 8);
  g.fillText(lo.toFixed(0) + (unit || ""), 4, h - pad.b);
  g.fillText(String(pts[0].l).slice(11, 16), pad.l, h - 7);
  const lastLbl = String(pts[pts.length - 1].l).slice(11, 16);
  g.fillText(lastLbl, w - pad.r - g.measureText(lastLbl).width, h - 7);
}
function ellipsize(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 4 && g.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}
function drawBarsH(id, rows, color) {
  if (!$(id)) return;
  const [g, w, h] = ctx2d(id);
  if (!rows.length) {
    g.fillStyle = "#8e8e93"; g.font = "12px sans-serif"; g.textAlign = "center";
    g.fillText("no data yet", w / 2, h / 2); g.textAlign = "left"; return;
  }
  const labelW = Math.min(150, Math.round(w * 0.34));
  const valueW = 44, top = 6;
  // Domain from min→max (not 0→max): these values sit in a narrow band, so a
  // zero baseline would flatten every bar to the same length and hide the
  // very differences the chart exists to show.
  const vals = rows.map((r) => r.v);
  const mx = Math.max(...vals), mn = Math.min(...vals);
  const span = Math.max(mx - mn, mx * 0.08, 1);
  const lo = Math.max(0, mn - span * 0.35), hi = mx + span * 0.15;
  const rh = (h - top * 2) / rows.length;
  const barH = Math.max(6, rh - 9);
  const barMax = Math.max(20, w - labelW - valueW - 18);
  rows.forEach((r, i) => {
    const y = top + i * rh;
    const mid = y + rh / 2;
    g.fillStyle = cssVar("--muted", "#888");
    g.font = "11.5px sans-serif";
    g.fillText(ellipsize(g, String(r.l), labelW - 8), 2, mid + 4);
    const frac = Math.max(0.02, Math.min(1, (r.v - lo) / (hi - lo)));
    const bw = Math.max(frac * barMax, 3);
    const bx = labelW;
    const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, color + "4d"); grad.addColorStop(1, color);
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(bx, mid - barH / 2, bw, barH, barH / 2);
    g.fill();
    g.fillStyle = cssVar("--ink", "#fff");
    g.font = "600 11.5px sans-serif";
    g.fillText(Number(r.v).toFixed(0), bx + bw + 6, mid + 4);
  });
  // axis caption so the truncated baseline is explicit
  g.fillStyle = "#8e8e93"; g.font = "9.5px sans-serif";
  g.fillText(`scale ${lo.toFixed(0)}–${hi.toFixed(0)} km/h`, labelW, h - 1);
}
function drawDonut(id, parts) {
  if (!$(id)) return;
  const [g, w, h] = ctx2d(id);
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 24, r = R * 0.62;
  let a = -Math.PI / 2;
  for (const p of parts) {
    const a2 = a + (p.v / total) * Math.PI * 2;
    g.beginPath(); g.arc(cx, cy, R, a, a2); g.arc(cx, cy, r, a2, a, true); g.closePath();
    g.fillStyle = p.c; g.fill();
    a = a2;
  }
  g.fillStyle = cssVar("--ink", "#fff"); g.font = "700 22px sans-serif"; g.textAlign = "center";
  g.fillText(String(total), cx, cy + 2);
  g.font = "11px sans-serif"; g.fillStyle = "#888";
  g.fillText("segments", cx, cy + 18);
  g.textAlign = "left";
  parts.forEach((p, i) => {
    g.fillStyle = p.c; g.fillRect(8, 8 + i * 18, 10, 10);
    g.fillStyle = "#888"; g.font = "11px sans-serif";
    g.fillText(`${p.l}: ${p.v}`, 24, 17 + i * 18);
  });
}
async function refreshAnalytics() {
  try {
    const [ov, tr, cor] = await Promise.all([
      getJSON("/api/analytics/overview"), getJSON("/api/analytics/trends?hours=12"),
      getJSON("/api/analytics/corridors?limit=6"),
    ]);
    tweenNum($("anSpeed"), ov.network_avg_speed);
    tweenNum($("anCong"), ov.by_level.MEDIUM.segments + ov.by_level.HIGH.segments);
    tweenNum($("anJammed"), ov.by_level.HIGH.segments);
    tweenNum($("anIndex"), ov.avg_index);
    tweenNum($("anKm"), Math.round(ov.total_km));
    const ttN = ov.tomtom_fresh_coverage || 0;
    $("anTT").textContent = `${ttN}/${ov.segments}`;
    $("srcTT").textContent = ttN;
    $("srcFleet").textContent = Math.max(0, ov.segments - ttN);
    $("srcFixes").textContent = ov.fixes_5min.toLocaleString();
    $("anSub").textContent =
      `${ov.segments} corridors · ${ov.total_km.toLocaleString()} km tracked · overview query ${ov.ms} ms.`;
    // Prefer the vendor trend (fills at the poll cadence); fall back to the
    // snapshot history, then to GPS ingest if neither has data yet.
    const ttPts = (tr.tomtom_trend || []).filter((p) => p.samples > 0)
      .map((p) => ({ l: p.bucket, v: p.avg_speed }));
    const flPts = (tr.speed_trend || []).filter((p) => p.samples > 0)
      .map((p) => ({ l: p.bucket, v: p.avg_speed }));
    drawLine("chSpeed", ttPts.length > 1 ? ttPts : flPts, "#a855f7", "");
    const cov = (tr.tomtom_per_min || []).map((p) => ({ l: p.minute, v: p.tomtom }));
    drawLine("chIngest", cov.length > 1 ? cov
      : (tr.ingest_per_min || []).map((p) => ({ l: p.minute, v: p.fixes })),
      "#30d158", "");
    drawDonut("chSplit", [
      { l: "Free", v: ov.by_level.LOW.segments, c: "#30d158" },
      { l: "Busy", v: ov.by_level.MEDIUM.segments, c: "#ffd60a" },
      { l: "Jammed", v: ov.by_level.HIGH.segments, c: "#ff453a" },
    ]);
    drawBarsH("chSlow", cor.slowest.map((s) => ({ l: s.segment_name, v: s.average_speed })), "#ff9f0a");
    $("anDense").innerHTML = cor.densest.map((t) => `
      <tr><td>${t.segment_name}</td><td>${t.average_speed}</td>
      <td>${t.vehicle_count}</td><td>${t.density.toFixed(2)}</td>
      <td><span class="pill ${t.congestion_level}">${t.congestion_level}</span></td>
      <td class="tt-cell">${t.tomtom_fresh && t.tomtom_speed != null ? t.tomtom_speed + " km/h" : "—"}</td></tr>`).join("");
  } catch { /* analytics catch up next tick */ }
}

/* Live TomTom incidents — real, positioned traffic events (jams, closures,
   accidents). This is the only real per-location traffic data the API gives
   us; unlike corridor speeds, it has genuine coordinates. */
const INC_ICON = {
  1: ["Unclassified", "#8e8e93"], 2: ["Roadworks", "#fbbf24"],
  3: ["Road closure", "#f5455c"], 4: ["Traffic jam", "#fb923c"],
  5: ["Accident", "#ff2d55"], 6: ["Weather", "#38bdf8"],
  7: ["Lane closed", "#a855f7"], 8: ["Congestion", "#fb7185"],
};
function renderIncidents(rows) {
  incidentLayer.clearLayers();
  const shown = (rows || []).slice(0, 250);
  for (const i of shown) {
    if (i.lat == null || i.lon == null) continue;
    const key = Number(i.category);
    const meta = INC_ICON[key] || ["Traffic event", "#f97316"];
    L.circleMarker([i.lat, i.lon], {
      radius: 6, color: "#fff", weight: 2,
      fillColor: meta[1], fillOpacity: 0.95,
    }).bindPopup(`<b>${meta[0]}</b>` +
      (i.from_road ? `<br>${i.from_road}${i.to_road ? " → " + i.to_road : ""}` : "") +
      (i.delay_s ? `<br>delay ~${Math.round(i.delay_s / 60)} min` : "") +
      (i.description ? `<br><span style="opacity:.75">${i.description.slice(0, 160)}</span>` : "")
    ).addTo(incidentLayer);
  }
  return shown.length;
}

/* ---- API monitor (performance + vendor usage) --------------------------------- */
function fmtUptime(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
async function refreshMonitor() {
  const box = $("monitorBox");
  if (!box) return;
  try {
    const m = await getJSON("/api/monitor?window_sec=300");
    const p = m.performance, t = m.tomtom;
    $("mP50").textContent = p.p50_ms + " ms";
    $("mP95").textContent = p.p95_ms + " ms";
    $("mP99").textContent = p.p99_ms + " ms";
    $("mMax").textContent = p.max_ms + " ms";
    $("mAvg").textContent = p.avg_ms + " ms";
    $("mReq").textContent = p.requests_total.toLocaleString();
    $("mErr").textContent = p.error_rate_pct + " %";
    $("mUp").textContent = fmtUptime(p.uptime_sec);
    $("mUsed").textContent = `${t.used_today} / ${t.daily_budget}`;
    $("mEst").textContent = `~${t.est_daily_use} / day`;
    $("mFresh").textContent = `${t.fresh_count} / ${t.total_segments}`;
    $("mInc").textContent = t.incidents;
    $("mLast").textContent = t.last_fetch
      ? new Date(t.last_fetch).toLocaleTimeString() : "never";
    $("mCad").textContent = `${t.interval_sec}s × ${t.batch_size}`;
    const pct = t.daily_budget ? Math.min(100, (t.used_today / t.daily_budget) * 100) : 0;
    $("monBudgetFill").style.width = pct.toFixed(1) + "%";
    $("monSub").textContent =
      `p95 ${p.p95_ms} ms · ${p.requests_in_window} req/5min · ${p.throughput_rps} rps · ` +
      `TomTom ${t.used_today}/${t.daily_budget}`;
    $("monBody").innerHTML = (p.endpoints || []).map((e) =>
      `<tr><td><code>${escapeHtml(e.endpoint)}</code></td><td>${e.calls}</td>` +
      `<td>${e.avg_ms}</td><td>${e.errors}</td></tr>`).join("")
      || '<tr><td colspan="4">No requests recorded yet.</td></tr>';
  } catch {
    $("monSub").textContent = "monitor unavailable — API not responding";
  }
}

/* ---- vendor status + map overlays --------------------------------------------- */
let ttBadgeLive = true;
async function refreshTomTomBadge() {
  try {
    const s = await getJSON("/api/tomtom/status");
    const b = $("ttBadge");
    if (!s.key_set) { b.textContent = "TomTom: no key"; b.className = "tt-badge off"; }
    else if (!s.enabled) { b.textContent = "TomTom: paused"; b.className = "tt-badge off"; }
    else if (s.budget_exhausted) { b.textContent = `TomTom: budget used (${s.used_today}/${s.daily_budget})`; b.className = "tt-badge warn"; }
    else { b.textContent = `TomTom live · ${s.fresh_count} fresh · ${s.used_today}/${s.daily_budget} today`; b.className = "tt-badge ok"; }
    const rd = await getJSON("/api/tomtom/readings?fresh_only=true").catch(() => []);
    renderTomTom(rd);
    if (ttBadgeLive) {
      const inc = await getJSON("/api/tomtom/incidents?limit=250").catch(() => []);
      const n = renderIncidents(inc);
      const el = $("incCount");
      if (el) el.textContent = n;
    }
  } catch { /* vendor status is a nicety */ }
}
/* ---- boot + live loops ----------------------------------------------------------------------- */

let pollCount = 0;
async function pollOnce() {
  try {
    const [traffic, positions, stats] = await Promise.all([
      getJSON("/api/traffic/summary"), getJSON("/api/network/positions"), getJSON("/api/stats"),
    ]);
    const cong = renderTraffic(traffic);
    renderPositions(positions);
    renderStats(stats, cong);
    const realN = lastTraffic.filter((t) => t.traffic_source === "tomtom").length;
    setStatus(true, `live · ${realN}/${lastTraffic.length} corridors on real TomTom data · ${new Date().toLocaleTimeString()}`);
    if (pollCount % 5 === 0) { // analytics + TomTom ride a slower cadence (cheap)
      refreshAnalytics();
      refreshTomTomBadge();
    }
    pollCount++;
  } catch { setStatus(false, "reconnecting…"); }
}
function connectWS() {
  let ws;
  try {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/live");
  } catch { return; }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      const cong = renderTraffic(msg.traffic || []);
      renderPositions(msg.positions || []);
      appendLogs(msg.logs || []);
      getJSON("/api/stats").then((s) => renderStats(s, cong)).catch(() => {});
      const r2 = (msg.traffic || []).filter((t) => t.traffic_source === "tomtom").length;
      setStatus(true, `live · ${r2}/${(msg.traffic || []).length} corridors on real TomTom data · ${new Date().toLocaleTimeString()}`);
    } catch { /* ignore malformed frames */ }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

/* ---- live query log ------------------------------------------------------------ */
const seenLogIds = new Set();
let logPaused = false, logFilter = "ALL", logTotal = 0, logSqlMs = 0, logSqlN = 0;
function appendLogs(entries) {
  const term = $("terminal");
  let added = false;
  for (const e of entries) {
    if (seenLogIds.has(e.id)) continue;
    seenLogIds.add(e.id);
    logTotal++;
    if (e.cat === "SQL") { logSqlMs += e.ms; logSqlN++; }
    if (e.cat === "ROUTE") $("lgRoute").textContent = e.ms + " ms";
    if (logPaused || (logFilter !== "ALL" && e.cat !== logFilter)) continue;
    const div = document.createElement("div");
    div.className = "log-line " + e.cat;
    div.innerHTML = `<span class="lt">+${e.t}s</span> <span class="lid">#${e.id}</span> ` +
      `<b>${e.cat}</b> ${escapeHtml(e.sql)} <span class="ms">${e.ms} ms</span>` +
      (e.detail ? ` <span class="det">— ${escapeHtml(e.detail)}</span>` : "");
    term.appendChild(div);
    while (term.children.length > 150) term.removeChild(term.firstChild);
    added = true;
  }
  if (added) term.scrollTop = term.scrollHeight;
  $("lgCount").textContent = logTotal;
  $("lgAvg").textContent = (logSqlN ? (logSqlMs / logSqlN).toFixed(1) : "0") + " ms";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
}
document.querySelectorAll("#logFilters button").forEach((b) =>
  on(b, "click", () => {
    document.querySelectorAll("#logFilters button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); logFilter = b.dataset.f;
  }));
on($("logPause"), "click", () => {
  logPaused = !logPaused;
  $("logPause").textContent = logPaused ? "Resume" : "Pause";
});
on($("logClear"), "click", () => { $("terminal").innerHTML = ""; });

/* ---- routing --------------------------------------------------------------------- */
function drawRoute(segIds, fly = true) {
  routeLayer.clearLayers();
  const bounds = [];
  const lines = [];
  for (const id of segIds) {
    const s = segments.find((x) => x.id === id);
    if (!s) continue;
    bounds.push([s.a_lat, s.a_lon], [s.b_lat, s.b_lon]);
    lines.push([[s.a_lat, s.a_lon], [s.b_lat, s.b_lon]]);
  }
  for (const ll of lines) { // white casing under a glowing blue core
    L.polyline(ll, { color: "#ffffff", weight: 9, opacity: 0.9, lineCap: "round" }).addTo(routeLayer);
  }
  for (const ll of lines) {
    L.polyline(ll, { color: "#0071e3", weight: 5, opacity: 0.95, lineCap: "round", className: "route-anim" }).addTo(routeLayer);
  }
  // Zoom close enough that vehicles moving at the real speed are visible.
  if (fly && bounds.length) map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 9, duration: 1.2 });
}
function routeHTML(r) {
  const c = r.comparison;
  let cmp = "";
  if (c) {
    cmp = c.same_route
      ? `<p class="verdict">The fastest route <b>is</b> the shortest one right now — nothing to beat.</p>`
      : `<div class="versus">
          <div class="vs-card"><span>Shortest</span><strong>${c.shortest.total_distance_km} km</strong><em>${c.shortest.estimated_time_min} min</em></div>
          <div class="vs-mid">vs</div>
          <div class="vs-card fast"><span>Fastest ★</span><strong>${r.total_distance_km} km</strong><em>${r.estimated_time_min} min</em></div>
        </div>
        <p class="verdict">Fastest saves <b>${c.saved_min} min</b> for <b>+${c.extra_km} km</b> extra road.</p>`;
  }
  return `
    <div class="route-meta">
      <div><strong>${r.estimated_time_min} min</strong><span>estimated travel time</span></div>
      <div><strong>${r.total_distance_km} km</strong><span>total distance</span></div>
      <div><strong>${r.traffic_score}×</strong><span>traffic penalty</span></div>
      <div><strong>${escapeHtml(r.source)} → ${escapeHtml(r.destination)}</strong><span>recommended route</span></div>
    </div>
    ${cmp}
    <ol class="legs">
      ${r.legs.map((l, i) => `<li><span class="pill ${l.congestion}">${l.congestion}</span>
        <span><b>${i + 1}.</b> ${escapeHtml(l.segment_name)} — ${l.distance_km} km, ~${l.estimated_min} min` +
        (l.speed_source ? `<span class="src-tag">${escapeHtml(l.speed_source)}</span>` : "") +
        `</span></li>`).join("")}
    </ol>`;
}
on($("routeBtn"), "click", async () => {
  const btn = $("routeBtn");
  btn.disabled = true; btn.textContent = "Routing…";
  try {
    const r = await postJSON("/api/routes/request", {
      source_id: Number($("srcSel").value), destination_id: Number($("dstSel").value),
      priority: $("prioBox").checked,
    });
    lastRouteSegs = r.segment_path; drawRoute(r.segment_path);
    const box = $("routeOut");
    box.hidden = false; box.innerHTML = routeHTML(r);
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) { toast("Routing failed: " + e.message); }
  finally { btn.disabled = false; btn.textContent = "Find best route"; }
});

/* ---- SQL Lab ------------------------------------------------------------------------ */
async function runSql(text) {
  const q = (text !== undefined ? text : $("sqlInput").value).trim();
  if (!q) return;
  const box = $("sqlOut");
  box.hidden = false; box.innerHTML = "<p>Running as read-only role…</p>";
  try {
    const r = await postJSON("/api/sql/run", { sql: q });
    const head = r.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const body = r.rows.map((row) =>
      `<tr>${row.map((v) => `<td>${escapeHtml(v === null ? "NULL" : String(v))}</td>`).join("")}</tr>`).join("");
    box.innerHTML = `
      <div class="sql-meta"><b>${r.rowcount}</b> rows in ${r.ms} ms${r.truncated ? " (first 200 shown)" : ""}</div>
      <div class="sql-scroll table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td>No rows.</td></tr>'}</tbody></table></div>`;
  } catch (e) { box.innerHTML = `<p class="cmd-error">Blocked: ${escapeHtml(e.message)}</p>`; }
}
async function loadSqlLab() {
  try {
    const { tables } = await getJSON("/api/sql/schema");
    $("schemaCount").textContent = `${tables.length} tables & views`;
    $("schemaGrid").innerHTML = tables.map((t) => `
      <div class="schema-table"><b>${escapeHtml(t.name)}</b>
      ${t.columns.map((c) => `<span><i>${escapeHtml(c.name)}</i> · ${escapeHtml(c.type)}</span>`).join("")}</div>`).join("");
  } catch { $("schemaCount").textContent = "unavailable (backend starting?)"; }
  try {
    const { samples } = await getJSON("/api/sql/samples");
    $("sqlChips").innerHTML = samples.map((s) =>
      `<button class="chip" data-sql="${escapeHtml(s.sql)}">${escapeHtml(s.title)}</button>`).join("");
    document.querySelectorAll("#sqlChips .chip").forEach((c) =>
      c.addEventListener("click", () => { $("sqlInput").value = c.dataset.sql; runSql(c.dataset.sql); }));
  } catch { /* samples are a nicety */ }
}
/* (NL console rendering retired in favor of SQL Lab — /api/command stays available.) */
/* (option-chip wiring retired with the NL console.) */
on($("sqlRun"), "click", () => runSql());
on($("sqlInput"), "keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runSql();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("sqllab").scrollIntoView({ behavior: "smooth" });
    setTimeout(() => $("sqlInput").focus(), 350);
  }
});

/* ---- runtime settings ---------------------------------------------------------
   The Customize drawer is gone, so the dashboard only needs the cadence the
   server is actually running at. Congestion thresholds remain editable via
   PUT /api/config or the SQL Lab. */
async function loadRuntime() {
  try {
    const c = await getJSON("/api/config");
    if (Number.isFinite(Number(c.poll_seconds))) POLL_MS = Number(c.poll_seconds) * 1000;
  } catch { /* backend at default cadence */ }
}

/* ---- reveal on scroll ----------------------------------------------------------------------- */
const io = new IntersectionObserver((es) =>
  es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.08 });
let resizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(refreshAnalytics, 250);
});
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

/* ---- boot ---------------------------------------------------------------------------------------- */
/* Each loader is isolated: one broken section can never stop the live loop.
   (An all-or-nothing boot used to blank the entire page on any single throw.) */
async function safe(label, fn) {
  try { await fn(); }
  catch (e) { console.warn("[" + label + "]", e && e.message ? e.message : e); }
}

(async function boot() {
  setStatus(false, "connecting…");
  // Loaders are independent — a failure in any one cannot stop the others
  // or the live loop (the old all-or-nothing boot blanked the whole page).
  safe("runtime", loadRuntime);
  safe("network", loadNetwork);
  safe("layers", async () => wireLayers());
  safe("sqllab", loadSqlLab);
  safe("analytics", refreshAnalytics);
  safe("ttbadge", refreshTomTomBadge);
  safe("monitor", refreshMonitor);

  // Prove the API is reachable independently of any optional panel.
  let apiOk = false;
  try { await getJSON("/api/health"); apiOk = true; }
  catch { setStatus(false, "API unreachable — start the backend first"); }

  if (apiOk) {
    await safe("poll", pollOnce);
    (function schedulePoll() {
      setTimeout(async () => { await safe("poll", pollOnce); schedulePoll(); }, POLL_MS);
    })();
    setInterval(() => safe("logs", async () => {
      appendLogs((await getJSON("/api/logs?limit=25")).logs);
    }), 5000);
    setInterval(() => safe("monitor", refreshMonitor), 4000);
    connectWS();
  }
  await safe("logs", async () => {
    appendLogs((await getJSON("/api/logs?limit=25")).logs);
  });
})();
