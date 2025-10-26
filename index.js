import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cors from "cors";
import cron from "node-cron";
import axios from "axios";
import _ from "lodash";

// ---- Config (env comes from Render) ----
const PORT = parseInt(process.env.PORT || "3000", 10);
const WINDY_KEY = process.env.WINDY_WEBCAMS_KEY || "";
const YT_KEY = process.env.YOUTUBE_API_KEY || ""; // optional
const RADIUS_KM = parseInt(process.env.RADIUS_KM_FOR_CAMS || "100", 10);
const TOP_N = parseInt(process.env.TOP_PLACES_PER_CATEGORY || "8", 10);
const MAX_CAMS = parseInt(process.env.MAX_CAMS_PER_PLACE || "10", 10);

// ---- In-memory state ----
let STATE = { updatedAt: null, categories: {}, places: [] };

// ---- Helpers ----
function mapThemesToCategory(themes) {
  const RULES = [
    { cat: "war", inc: ["WAR", "MILITARY", "ARMS", "CONFLICT", "TERROR"] },
    { cat: "crime", inc: ["CRIME", "KIDNAP", "MURDER", "ARREST", "CORRUPTION"] },
    { cat: "politics", inc: ["ELECTION", "POLITICS", "GOVERNMENT", "PROTEST"] },
    { cat: "entertainment", inc: ["ENTERTAINMENT", "CELEBRITY", "FILM", "MUSIC"] },
    { cat: "disaster", inc: ["NATURAL_DISASTER", "EARTHQUAKE", "FLOOD", "HURRICANE", "WILDFIRE"] },
    { cat: "sports", inc: ["SPORTS", "SOCCER", "BASKETBALL", "OLYMPICS"] },
    { cat: "tech", inc: ["TECH", "AI", "CYBERSECURITY"] },
    { cat: "economy", inc: ["ECONOMY", "MARKETS", "INFLATION", "JOBS"] }
  ];
  const up = themes.map(t => t.toUpperCase());
  for (const r of RULES) if (r.inc.some(k => up.some(t => t.includes(k)))) return r.cat;
  return null;
}

async function fetchGKGLastHour() {
  const url = "http://data.gdeltproject.org/gdeltv2/lasthour-gkg.csv";
  const { data } = await axios.get(url, { responseType: "text", timeout: 20000 });
  const rows = data.trim().split("\n").map(line => line.split("\t"));
  const out = [];
  for (const cols of rows) {
    const themes = (cols[4] || "").split(";").filter(Boolean);
    const v2locs = (cols[8] || "").split(";").filter(Boolean);
    const locations = v2locs.map(tok => {
      const p = tok.split("#");
      const name = p[0] || "";
      const lat = parseFloat(p[4] || "0");
      const lon = parseFloat(p[5] || "0");
      const country = p[2] || "";
      if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return null;
      return { name, lat, lon, country };
    }).filter(Boolean);
    out.push({ themes, locations });
  }
  return out;
}

function rankPlaces(places) {
  const cats = {};
  for (const p of places) for (const [cat, count] of Object.entries(p.counts)) {
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ ...p, score: count });
  }
  for (const cat of Object.keys(cats)) {
    cats[cat] = _.orderBy(cats[cat], ["score"], ["desc"]).slice(0, TOP_N);
  }
  return cats;
}

async function windyNearby({ lat, lon }) {
  if (!WINDY_KEY) return [];
  const url = `https://api.windy.com/webcams/api/v3/list/nearby=${lat},${lon},${RADIUS_KM}?show=webcams:location,image,player`;
  const { data } = await axios.get(url, { headers: { "x-windy-key": WINDY_KEY }, timeout: 15000 });
  const cams = (data?.result?.webcams || [])
    .filter(c => (c?.status || "").toLowerCase() === "active" && c?.player?.live?.available)
    .map(c => ({
      id: c.id,
      title: c.title,
      image: c.image?.current?.preview,
      player: c.player?.live?.embed,
      url: c.player?.live?.link || c.url?.current?.desktop || "",
      source: "windy",
      verified: true
    }));
  return cams.slice(0, MAX_CAMS);
}

async function ytSearch(q) {
  if (!YT_KEY) return [];
  const url = "https://www.googleapis.com/youtube/v3/search";
  const { data } = await axios.get(url, {
    params: {
      key: YT_KEY,
      part: "snippet",
      q,
      type: "video",
      eventType: "live",
      maxResults: 10
    }, timeout: 15000
  });
  return (data?.items || []).map(v => ({
    id: v.id.videoId,
    title: v.snippet.title,
    image: v.snippet.thumbnails?.medium?.url,
    player: `https://www.youtube.com/embed/${v.id.videoId}`,
    url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
    source: "youtube",
    verified: true
  }));
}

async function findCamsForPlace(p) {
  let cams = [];
  try { cams = cams.concat(await windyNearby(p)); } catch {}
  if (cams.length < MAX_CAMS) {
    try {
      const kws = ['live cam','traffic cam','weather cam','city cam','library cam','airport cam','public cam','webcam live'];
      for (const kw of kws) {
        if (cams.length >= MAX_CAMS) break;
        const more = await ytSearch(`${p.name} ${kw}`);
        for (const c of more) {
          if (!cams.find(x => x.url === c.url)) cams.push(c);
          if (cams.length >= MAX_CAMS) break;
        }
      }
    } catch {}
  }
  return _.uniqBy(cams, c => c.url || c.player || c.id).slice(0, MAX_CAMS);
}

// ---- Ingest job (hourly) ----
async function ingestOnce() {
  const gkg = await fetchGKGLastHour();
  const buckets = new Map();
  for (const row of gkg) {
    const cat = mapThemesToCategory(row.themes || []);
    if (!cat) continue;
    for (const loc of row.locations || []) {
      const id = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}:${loc.name}`;
      const curr = buckets.get(id) || { name: loc.name, lat: loc.lat, lon: loc.lon, country: loc.country || "", counts: {} };
      curr.counts[cat] = (curr.counts[cat] || 0) + 1;
      buckets.set(id, curr);
    }
  }
  const ranked = rankPlaces([...buckets.values()]);

  const categories = {};
  const places = [];
  for (const [cat, placeList] of Object.entries(ranked)) {
    categories[cat] = [];
    for (const p of placeList) {
      const cams = await findCamsForPlace(p);
      if (!cams.length) continue;
      categories[cat].push({ place: { name: p.name, country: p.country, lat: p.lat, lon: p.lon, score: p.score },
                             cams: cams.map(c => ({ title: c.title, url: c.url, image: c.image, source: c.source, player: c.player })) });
      places.push({ category: cat, ...p, cams });
    }
  }

  STATE = { updatedAt: new Date().toISOString(), categories, places };
  console.log("[ingest] updated", STATE.updatedAt);
}

// ---- Web server (serves API + simple map UI) ----
const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "frame-src": ["'self'","https://www.youtube.com","https://webcams.windy.com","https://*.windy.com","https://player.vimeo.com","https://www.twitch.tv"],
      "img-src": ["'self'","data:","https:","blob:"],
      "media-src": ["'self'","https:","blob:"]
    }
  }
}));
app.use(cors());
app.use(morgan("tiny"));

app.get("/api/state", (_req, res) => res.json(STATE));

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Hotspots → Live Webcams</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
body{font-family:system-ui,Segoe UI,Roboto;-webkit-font-smoothing:antialiased;margin:0;background:#0b1020;color:#e6ecff}
header{padding:16px;background:#0f172a;border-bottom:1px solid #1e293b}
main{padding:16px;display:grid;gap:16px}
#map{height:60vh;border:1px solid #1f2937;border-radius:12px}
.cat{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:16px}
.place{display:grid;gap:8px;margin:12px 0;padding:12px;background:#0b1220;border:1px solid #1e293b;border-radius:12px}
.cams{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{background:#0f172a;border:1px solid #1f2937;border-radius:12px;overflow:hidden}
.card img{width:100%;display:block}
.player{aspect-ratio:16/9;width:100%;border:0}
.meta{padding:8px 10px;font-size:14px}
.updated{opacity:.75;font-size:12px}
.badge{font-size:11px;opacity:.8}
</style>
</head>
<body>
<header><h1>Hotspots → Live Webcams</h1><div style="opacity:.75">Auto-updated hourly from GDELT + public webcams.</div></header>
<main><div id="map"></div><div id="app"></div></main>
<script>
let map, layer;
function ensureMap(){
  if(map) return map;
  map = L.map('map'); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; OpenStreetMap'}).addTo(map);
  layer = L.layerGroup().addTo(map); map.setView([20,0],2); return map;
}
function render(state){
  ensureMap(); layer.clearLayers();
  const app = document.getElementById('app'); app.innerHTML='';
  const upd = document.createElement('div'); upd.className='updated';
  upd.textContent = state.updatedAt ? 'Last updated: '+new Date(state.updatedAt).toLocaleString() : 'Not updated yet';
  app.appendChild(upd);
  const cats = state.categories || {}; const bounds=[];
  const order=['war','politics','crime','disaster','entertainment','sports','tech','economy'];
  for(const cat of order){
    const entries = cats[cat]; if(!entries||!entries.length) continue;
    const box=document.createElement('section'); box.className='cat'; box.innerHTML='<h2>'+cat.toUpperCase()+'</h2>';
    for(const entry of entries){
      const p=entry.place; const m=L.marker([p.lat,p.lon]).addTo(layer); bounds.push([p.lat,p.lon]);
      const list=(entry.cams||[]).slice(0,5).map(c=>'<div>'+(c.title||'Live cam')+' — <span class="badge">'+c.source+'</span> • <a target="_blank" rel="noopener" href="'+c.url+'">Open</a></div>').join('');
      m.bindPopup('<strong>'+p.name+'</strong>'+(p.country?' • '+p.country:'')+'<br/><em>'+cat.toUpperCase()+'</em><div style="margin-top:6px">'+list+'</div>');
      const place=document.createElement('div'); place.className='place';
      place.innerHTML='<div><strong>'+p.name+'</strong>'+(p.country?' • '+p.country:'')+'</div>';
      const grid=document.createElement('div'); grid.className='cams';
      for(const cam of entry.cams||[]){
        const card=document.createElement('div'); card.className='card';
        if(cam.player){ const ifr=document.createElement('iframe'); ifr.className='player'; ifr.src=cam.player; ifr.allow='autoplay; encrypted-media; picture-in-picture'; ifr.allowFullscreen=true; card.appendChild(ifr); }
        else if(cam.image){ const img=document.createElement('img'); img.src=cam.image; card.appendChild(img); }
        const meta=document.createElement('div'); meta.className='meta';
        meta.innerHTML='<div>'+(cam.title||'Live cam')+'</div><div><a target="_blank" rel="noopener" href="'+cam.url+'">Open</a> • '+cam.source+'</div>';
        card.appendChild(meta); grid.appendChild(card);
      }
      place.appendChild(grid); box.appendChild(place);
    }
    app.appendChild(box);
  }
  if(bounds.length) map.fitBounds(bounds,{padding:[30,30]});
}
async function load(){ const r=await fetch('/api/state'); const s=await r.json(); render(s); }
load(); setInterval(load, 300000);
</script>
</body></html>`);
});

// ---- Boot: start server + run ingest now + schedule hourly ----
app.listen(PORT, () => console.log(`[http] listening on :${PORT}`));
(async () => { try { await ingestOnce(); } catch(e){ console.error("[ingest] boot error", e.message) }})();
cron.schedule("0 * * * *", async () => { try { await ingestOnce(); } catch(e){ console.error("[ingest] hourly error", e.message) } });
