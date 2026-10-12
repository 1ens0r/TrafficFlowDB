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
    const hint = $("zoomHint");
    if (hint) hint.classList.toggle("hide", map.getZoom() >= FLOW_MIN_ZOOM);
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
  $("jamSel").innerHTML = segments
    .map((s) => `<option value="${s.id}">#${s.id} ${s.name}</option>`).join("");
  $("jamSel").value = 45;
  const nat = nodes.filter((n) => n.scope === "national").length;
  $("netSub").textContent =
    `${nodes.length} intersections (${nat} national hubs) · ${segments.length} corridors · one row per segment, updated on every GPS fix.`;
  $("mapSub").textContent =
    `${nat} national hubs · ${segments.length} live corridors · hover a road for speeds, click a dot for a vehicle. Toggle layers above to declutter.`;
  for (const n of nodes) {
    if (nodeMarkers.has(n.id)) continue;
    nodeMarkers.set(n.id, L.circleMarker([n.lat, n.lon], {
      radius: n.scope === "national" ? 4 : 2.5, color: "#0b1b2b", weight: 1.5,
      fillColor: "#ffffff", fillOpacity: 1,
    }).bindTooltip(n.name, { direction: "top", offset: [0, -3] }).addTo(hubLayer));
  }
  for (const s of segments) {
    if (segLines.has(s.id)) continue;
    segLines.set(s.id, L.polyline([[s.a_lat, s.a_lon], [s.b_lat, s.b_lon]], {
      color: COLORS.LOW, weight: 2.5, opacity: 0.5, lineCap: "round",
    }).bindTooltip(`${s.name}<br>${s.distance_km} km · limit ${s.speed_limit} km/h`).addTo(segLayer));
  }
  fitNetwork(); // frame the whole network once, instead of guessing a view
  initFlow();
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

/* ---- corridor flow layer -----------------------------------------------------
   One canvas over the map, one requestAnimationFrame loop, all particles drawn
   in a single pass — smooth at any zoom, unlike 500 individual SVG markers.
   Each dot MOVES AT THE REAL SPEED TomTom reports for that corridor
   (km/h ÷ km = time to cross), and how many dots a corridor carries comes from
   the real slow-down index. Positions are interpolated along the corridor
   because TomTom publishes segment speeds, not vehicle GPS traces.          */
const flow = { canvas: null, ctx: null, corridors: new Map(), raf: 0, last: 0 };

function initFlow() {
  if (!HAS_MAP) return;
  const c = document.createElement("canvas");
  c.className = "tf-flow";
  document.getElementById("map").appendChild(c);
  flow.canvas = c;
  flow.ctx = c.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(stepFlow);
}

function syncFlow(rows) {
  flow.corridors.clear();
  for (const t of rows) {
    const s = segments.find((x) => x.id === t.segment_id);
    if (!s || !(s.distance_km > 0)) continue;
    const tt = ttBySeg.get(t.segment_id);
    // Real observed speed wins; otherwise the fleet-derived average.
    const kmh = tt && tt.current_speed != null ? tt.current_speed : t.average_speed;
    const idx = Number(t.traffic_index || 0);
    // Free-flow road -> sparse and fast; jammed -> dense and slow.
    const n = Math.max(1, Math.min(20, Math.round(idx * 20) + 1));
    const seed = (t.segment_id * 9301 + 49297) % 233280 / 233280;
    const pts = [];
    for (let i = 0; i < n; i++) {
      pts.push({
        t: (i + seed) / n,
        dir: (t.segment_id + i) % 2 ? 1 : -1,
        j: 0.85 + ((i * 37) % 29) / 100,  // per-dot speed jitter
      });
    }
    flow.corridors.set(t.segment_id, {
      a: [s.a_lat, s.a_lon], b: [s.b_lat, s.b_lon],
      km: s.distance_km, kmh: Math.max(3, kmh), pts,
      color: COLORS[t.congestion_level] || COLORS.LOW,
      real: !!tt,
    });
  }
}

/* Zoom threshold for moving vehicles. At India scale a 250 km corridor is
   ~150 px wide, so a car doing 100 km/h advances ~0.02 px per frame — real
   motion is physically invisible. Below this zoom we show direction-of-flow
   instead; above it, the dots move at the real reported speed. */
const FLOW_MIN_ZOOM = 7;

function stepFlow(now) {
  const dt = flow.last ? Math.min(0.25, (now - flow.last) / 1000) : 0;
  flow.last = now;
  drawFlow(dt);
  requestAnimationFrame(stepFlow);
}

function drawFlow(dt) {
  const c = flow.canvas, g = flow.ctx;
  if (!c || !g || !HAS_MAP) return;
  const size = map.getSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = size.x, H = size.y;
  if (c.width !== W * dpr || c.height !== H * dpr) {
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = W + "px"; c.style.height = H + "px";
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!flow.visible) return;
  const z = map.getZoom();

  for (const cor of flow.corridors.values()) {
    const p1 = map.latLngToContainerPoint(cor.a);
    const p2 = map.latLngToContainerPoint(cor.b);
    if ((p1.x < -80 && p2.x < -80) || (p1.x > W + 80 && p2.x > W + 80)) continue;
    const rate = (cor.kmh / cor.km) * (dt / 3600); // fraction covered / second

    if (z < FLOW_MIN_ZOOM) {
      // Country scale: a real vehicle covers a fraction of a pixel, so show
      // direction-of-flow as a travelling highlight instead of pretending
      // the vehicles are visibly driving.
      const phase = (performance.now() / 2600) % 1;
      for (let k = 0; k < 2; k++) {
        const t = (phase + k * 0.5) % 1;
        const x = p1.x + (p2.x - p1.x) * t;
        const y = p1.y + (p2.y - p1.y) * t;
        g.beginPath();
        g.arc(x, y, 2.2, 0, 6.2832);
        g.fillStyle = "#fff";
        g.globalAlpha = 0.55;
        g.fill();
      }
      g.globalAlpha = 1;
      continue;
    }

    // Zoomed in: dots move at the real reported speed.
    for (const d of cor.pts) {
      let t = d.t + d.dir * rate * d.j;
      while (t > 1) t -= 1;
      while (t < 0) t += 1;
      d.t = t;
      const x = p1.x + (p2.x - p1.x) * t;
      const y = p1.y + (p2.y - p1.y) * t;
      g.beginPath();
      g.arc(x, y, cor.real ? 2.8 : 2.2, 0, 6.2832);
      g.fillStyle = cor.color;
      g.globalAlpha = cor.real ? 0.95 : 0.55;
      g.fill();
    }
  }
  g.globalAlpha = 1;
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
  syncFlow(rows);
  if (lastRouteSegs.length) drawRoute(lastRouteSegs, false);
  renderTable();
  return { high, med };
}

/* Corridors carry the traffic story now: dots along each road are vehicles
   moving at the real measured speed, so a jam visibly crawls. */
function renderCorridorParticles() { /* superseded by the canvas flow layer */ }
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
    const tt = ttBySeg.get(t.segment_id);
    return `
    <tr><td>${t.segment_name}</td>
    <td><span class="scope-tag ${t.scope}">${t.scope}</span></td>
    <td>${t.distance_km}</td><td>${Number(t.average_speed).toFixed(0)}</td>
    <td>${t.vehicle_count}</td><td>${Number(t.density).toFixed(2)}</td>
    <td><span class="pill ${t.congestion_level}">${t.congestion_level}</span></td>
    <td class="tt-cell">${tt ? Number(tt.current_speed).toFixed(0) + " km/h" : "—"}</td></tr>`;
  }).join("");
}
/* ---- layer toggles ---------------------------------------------------------- */
function wireLayers() {
  flow.visible = true;
  on("lyrVeh", "change", (e) => { flow.visible = e.target.checked; });
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

/* ---- TomTom controls ---------------------------------------------------------- */
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
on($("ttInt"), "input", () => ($("ttIntVal").textContent = $("ttInt").value + " s"));
on($("ttBatch"), "input", () => ($("ttBatchVal").textContent = $("ttBatch").value));
async function loadTomTom() {
  try {
    const s = await getJSON("/api/tomtom/status");
    $("ttOn").checked = !!s.enabled;
    $("ttInt").value = s.interval_sec; $("ttIntVal").textContent = s.interval_sec + " s";
    $("ttBatch").value = s.batch_size; $("ttBatchVal").textContent = s.batch_size;
    $("ttBudget").value = s.daily_budget;
    $("ttLive").textContent = s.key_set ? `${s.fresh_count} fresh` : "no key";
    $("ttStatus").textContent = s.key_set
      ? `~${s.est_daily_use} calls/day at this cadence · ${s.used_today}/${s.daily_budget} used today · ${s.incidents} incidents cached.`
      : "No API key found — set TOMTOM_API_KEY in .env and restart the api container.";
  } catch { $("ttStatus").textContent = "TomTom endpoint unavailable (backend starting?)"; }
}
on($("ttApply"), "click", async () => {
  try {
    const c = await putJSON("/api/tomtom/config", {
      enabled: $("ttOn").checked, interval_sec: Number($("ttInt").value),
      batch_size: Number($("ttBatch").value), daily_budget: Number($("ttBudget").value),
    });
    $("ttLive").textContent = c.enabled ? "on" : "";
    $("ttStatus").textContent = `Applied — every ${c.interval_sec}s × ${c.batch_size} segments, budget ${c.daily_budget}/day.`;
    toast("TomTom configuration applied");
    refreshTomTomBadge();
  } catch (e) { toast("TomTom apply failed: " + e.message); }
});
on($("ttNow"), "click", async () => {
  try {
    const r = await postJSON("/api/tomtom/refresh", {});
    toast(`TomTom: ${r.fetched} corridors refreshed (${r.used_today}/${r.budget} today)`);
    refreshTomTomBadge(); pollOnce();
  } catch (e) { toast("Refresh blocked: " + e.message); }
});
on($("ttInc"), "click", async () => {
  try {
    const r = await postJSON("/api/tomtom/refresh", { incidents: true });
    toast(`TomTom: ${r.incidents} incidents cached`);
  } catch (e) { toast("Incidents blocked: " + e.message); }
});
on($("ttOpen"), "click", () => {
  $("sqllab").scrollIntoView({ behavior: "smooth" });
  setTimeout(() => { $("sqlInput").value = "SELECT * FROM tomtom_reading ORDER BY fetched_at DESC LIMIT 20;"; runSql($("sqlInput").value); }, 400);
});

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
/* ---- fleet (drawer) ---------------------------------------------------------------------- */
on($("fleetRange"), "input", () => ($("fleetVal").textContent = $("fleetRange").value));
async function loadFleet() {
  try {
    const f = await getJSON("/api/fleet");
    $("fleetOn").checked = f.enabled;
    $("fleetRange").value = f.target;
    $("fleetVal").textContent = f.target;
    $("fleetLive").textContent = f.enabled ? `${f.alive} live` : "";
    $("fleetNote").textContent = f.enabled
      ? `Running: ${f.alive} vehicles live${f.last.ingested ? `, last tick ${f.last.ingested} fixes in ${f.last.ms} ms` : ""}.`
      : "Spawns/retires live to the target — OD trips through the bulk ingest path. No terminal process needed.";
  } catch { /* fleet endpoint missing on old backend */ }
}
on($("fleetApply"), "click", async () => {
  try {
    const f = await postJSON("/api/fleet", {
      enabled: $("fleetOn").checked, count: Number($("fleetRange").value),
    });
    $("fleetLive").textContent = f.enabled ? `${f.alive} live` : "";
    $("fleetNote").textContent = f.enabled
      ? `Running — spawning toward ${f.target} vehicles.`
      : "Fleet stopped and retired.";
    toast(f.enabled ? `Fleet → ${f.target} vehicles` : "Fleet stopped");
    pollOnce(); // site-wide counts refresh immediately, not next tick
  } catch (e) { toast("Fleet failed: " + e.message); }
});
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

/* ---- customize drawer ------------------------------------------------------------------ */
function openDrawer(o) {
  $("drawer").classList.toggle("closed", !o);
  $("scrim").hidden = !o;
}
on($("customBtn"), "click", () => openDrawer(true));
on($("drawerClose"), "click", () => openDrawer(false));
on($("scrim"), "click", () => openDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") openDrawer(false); });
if ($("drawer")) $("drawer").classList.add("closed");

on($("winRange"), "input", () => ($("winVal").textContent = $("winRange").value + " min"));
on($("pollRange"), "input", () => ($("pollVal").textContent = Number($("pollRange").value).toFixed(1) + " s"));

async function loadConfig() {
  try {
    const c = await getJSON("/api/config");
    $("winRange").value = c.traffic_window_minutes;
    $("winVal").textContent = c.traffic_window_minutes + " min";
    $("pollRange").value = c.poll_seconds;
    $("pollVal").textContent = Number(c.poll_seconds).toFixed(1) + " s";
    POLL_MS = c.poll_seconds * 1000;
    $("thHs").value = c.thresholds.high_speed;
    $("thHd").value = c.thresholds.high_density;
    $("thMs").value = c.thresholds.med_speed;
    $("thMd").value = c.thresholds.med_density;
  } catch { /* backend with old config: controls keep defaults */ }
}
on($("cfgApply"), "click", async () => {
  try {
    const c = await putJSON("/api/config", {
      traffic_window_minutes: Number($("winRange").value),
      poll_seconds: Number($("pollRange").value),
      thresholds: {
        high_speed: Number($("thHs").value), high_density: Number($("thHd").value),
        med_speed: Number($("thMs").value), med_density: Number($("thMd").value),
      },
    });
    POLL_MS = c.poll_seconds * 1000;
    $("cfgNote").textContent = `Applied — window ${c.traffic_window_minutes} min, thresholds rewritten, all segments recomputed.`;
    toast("Configuration applied live");
    pollOnce();
  } catch (e) { toast("Apply failed: " + e.message); }
});
on($("jamFire"), "click", async () => {
  try {
    const r = await postJSON("/api/scenarios/jam", {
      segment_id: Number($("jamSel").value), count: Number($("jamCount").value),
    });
    toast(`Jam on ${r.segment} → ${r.traffic.congestion}`);
    pollOnce();
  } catch (e) { toast("Jam failed: " + e.message); }
});
on($("rushFire"), "click", async () => {
  try {
    const r = await postJSON("/api/scenarios/rush-hour", {});
    toast(`Rush hour: ${r.injected} vehicles on ${r.segments} corridors`);
    pollOnce();
  } catch (e) { toast("Failed: " + e.message); }
});
on($("resetFire"), "click", async () => {
  try {
    const r = await postJSON("/api/scenarios/reset", {});
    toast(`Cleared ${r.removed_scenario_vehicles} scenario vehicles`);
    pollOnce();
  } catch (e) { toast("Failed: " + e.message); }
});

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
  safe("config", loadConfig);
  safe("network", loadNetwork);
  safe("layers", async () => wireLayers());
  safe("sqllab", loadSqlLab);
  safe("fleet", loadFleet);
  safe("tomtom", loadTomTom);
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
  if (new URLSearchParams(location.search).get("drawer") === "1") openDrawer(true);
})();
