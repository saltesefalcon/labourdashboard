// scripts/fetch_silverware_daily_totals.mjs
// Usage examples:
//   # single location (same as before):
//   WEEK_OF=2025-11-24 node scripts/fetch_silverware_daily_totals.mjs prohibition
//   node scripts/fetch_silverware_daily_totals.mjs cesoir --week=2025-11-24 --debug
//   node scripts/fetch_silverware_daily_totals.mjs tulia  --from=2025-11-24 --to=2025-11-30
//
//   # multiple locations:
//   LOCATIONS="beacon,tulia,cesoir,prohibition" WEEK_OF=2025-11-24 node scripts/fetch_silverware_daily_totals.mjs
//   node scripts/fetch_silverware_daily_totals.mjs all --week=2025-11-24

import admin from "firebase-admin";

// ---------- helpers for args ----------
const VALID_LOCS = ["beacon", "tulia", "cesoir", "prohibition"];
const DEBUG = process.argv.includes("--debug");
const arg = (k) => (process.argv.find(x => x.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=") || null;

function mondayOf(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0,10);
}
let from = arg("from"), to = arg("to");
const week = arg("week") || process.env.WEEK_OF;
if (week && (!from || !to)) {
  from = mondayOf(week);
  const d = new Date(from + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  to = d.toISOString().slice(0,10);
}
if (!from || !to) {
  console.error("Provide --week=YYYY-MM-DD OR both --from=YYYY-MM-DD --to=YYYY-MM-DD");
  process.exit(1);
}

// Which locations to run?
function parseLocs() {
  // 1) explicit first arg, can be single loc or "all"
  const first = (process.argv[2] || "").toLowerCase().trim();
  if (first && first !== "--debug" && !first.startsWith("--")) {
    if (first === "all") return VALID_LOCS.slice();
    if (first.includes(",")) {
      const list = first.split(",").map(s => s.trim()).filter(Boolean);
      const bad = list.filter(l => !VALID_LOCS.includes(l));
      if (bad.length) {
        console.error("Invalid loc(s):", bad.join(", "), "Valid:", VALID_LOCS.join(", "));
        process.exit(1);
      }
      return list;
    }
    if (!VALID_LOCS.includes(first)) {
      console.error("First arg must be one of:", VALID_LOCS.join(" | "), "or 'all'");
      process.exit(1);
    }
    return [first];
  }

  // 2) LOCATIONS env, comma-separated
  const envList = (process.env.LOCATIONS || "").trim();
  if (envList) {
    const list = envList.split(",").map(s => s.trim()).filter(Boolean);
    const bad = list.filter(l => !VALID_LOCS.includes(l));
    if (bad.length) {
      console.error("Invalid LOCATIONS value(s):", bad.join(", "), "Valid:", VALID_LOCS.join(", "));
      process.exit(1);
    }
    return list;
  }

  // 3) default: all
  return VALID_LOCS.slice();
}
const LOCS = parseLocs();

// ---------- Firestore (admin) ----------
const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();

// ---------- env mapping per location ----------
function envFor(loc) {
  const key = loc.toUpperCase(); // BEACON / TULIA / CESOIR / PROHIBITION
  let base = process.env[`SILVERWARE_BASE_${key}`];
  let token = process.env[`SILVERWARE_TOKEN_${key}`];

  if (loc === "cesoir") {
    base  = base  ?? process.env.SILVERWARE_BASE_CESOIR ?? process.env.SILVERWARE_BASE_CESOR;
    token = token ?? process.env.SILVERWARE_TOKEN_CESOIR ?? process.env.SILVERWARE_TOKEN_CESOR;
  }
  return { base, token };
}

function* eachDayISO(fromISO, toISO){
  const d = new Date(fromISO + "T00:00:00Z");
  const end = new Date(toISO + "T00:00:00Z");
  while (d <= end){
    yield d.toISOString().slice(0,10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function firstDayPayload(data){
  // Your API might return {Days:[...]} or [...] or a single object.
  const arr = toArrayDays(data);
  return arr && arr.length ? arr[0] : null;
}

function getTotalSalesAmount(day){
  // Prefer the same “Amount” total you see on the Silverware report.
  // Many payloads have Sales.TotalAmount; some have Sales.TotalNetAmount.
  if (isNum(day?.Sales?.TotalAmount)) return day.Sales.TotalAmount;
  if (isNum(day?.Sales?.TotalNetAmount)) return day.Sales.TotalNetAmount;
  return 0;
}


// ---------- Silverware fetch ----------
async function postDailyTotals(base, token, bizFrom, bizTo) {
  const endpoint = `${base}/api/ThirdParty/DailyTotals`;
  const body = { BusinessDateFrom: bizFrom, BusinessDateTo: bizTo };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const txt = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText} @ ${endpoint} body=${JSON.stringify(body)}: ${txt.slice(0,200)}`
    );
  }
  try { return JSON.parse(txt); } catch { return txt; }
}


function toArrayDays(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.Days)) return payload.Days;
  return [payload];
}
const isNum = v => typeof v === "number" && isFinite(v);

function deriveFromOne(day) {
  // FOOD (net, no tax): Sales.Items where Name === "FOOD" or InterfaceID === "5000"
  let food = 0;
  for (const it of (day?.Sales?.Items || [])) {
    const name = (it?.Name || "").toString().toUpperCase();
    const id   = (it?.InterfaceID || "").toString();
    if (name === "FOOD" || id === "5000") {
      if (isNum(it?.NetAmount)) food += it.NetAmount;
    }
  }

  const promos = isNum(day?.Discounts?.TotalAmount) ? day.Discounts.TotalAmount : 0;

  // ✅ VOIDS ONLY (no cancellations)
const voids = isNum(day?.Voids?.TotalAmount) ? day.Voids.TotalAmount : 0;
const cancellations = isNum(day?.Cancellations?.TotalAmount) ? day.Cancellations.TotalAmount : 0;


  const totalNet = isNum(day?.Sales?.TotalNetAmount) ? day.Sales.TotalNetAmount : 0;

  return { food, promos, voids, cancellations, totalNet };

}

function rollup(days) {
  return days.reduce((a,d)=> {
    const x = deriveFromOne(d);
    a.food += x.food;
    a.promos += x.promos;
    a.voids += x.voids;
    a.cancellations += (x.cancellations || 0);
    a.totalNet += x.totalNet;
    return a;
  }, { food:0, promos:0, voids:0, cancellations:0, totalNet:0 });
}



function integDocPath(locKey, weekISO) {
  return `companies/aidan/locations/${locKey}/integrations/${weekISO}`;
}

(async () => {
  const weekISO = mondayOf(from);

  for (const loc of LOCS) {
    const { base, token } = envFor(loc);
    if (!base || !token) {
      console.error(`[${loc}] Missing envs: SILVERWARE_BASE_${loc.toUpperCase()} and/or SILVERWARE_TOKEN_${loc.toUpperCase()}. Skipping.`);
      continue;
    }

    console.log(`[${loc}] DailyTotals ${from}..${to}`);
    try {
const totalsByDate = {};

for (const dayISO of eachDayISO(from, to)){
  const data = await postDailyTotals(base, token, dayISO, dayISO);
  if (DEBUG) {
    console.log(`[${loc}] debug day=${dayISO}`);
    console.dir(data, { depth: 6 });
  }

  const day = firstDayPayload(data);
  if (!day){
    totalsByDate[dayISO] = { total_sales: 0, food: 0, promos: 0, voids: 0, cancellations: 0 };
    continue;
  }

  const x = deriveFromOne(day);

  totalsByDate[dayISO] = {
    total_sales: getTotalSalesAmount(day),
    food: x.food,
    promos: x.promos,
    voids: x.voids,
    cancellations: x.cancellations,
  };
}

// weekly rollup from per-day totals
const sums = Object.values(totalsByDate).reduce((a,d)=> {
  a.totalSales += (Number(d.total_sales) || 0);
  a.food += (Number(d.food) || 0);
  a.promos += (Number(d.promos) || 0);
  a.voids += (Number(d.voids) || 0);
  a.cancellations += (Number(d.cancellations) || 0);
  return a;
}, { totalSales:0, food:0, promos:0, voids:0, cancellations:0 });


// round helper
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// round the per-day map too
const totals_by_date = {};
for (const [dayISO, v] of Object.entries(totalsByDate)){
  totals_by_date[dayISO] = {
    total_sales: round2(v.total_sales),
    food: round2(v.food),
    promos: round2(v.promos),
    voids: round2(v.voids),
    cancellations: round2(v.cancellations),
  };
}

const payload = {
  writer_tag: "daily_totals",

  // Weekly totals (authoritative)
  total_sales_silverware: round2(sums.totalSales),
  food_sales_total:       round2(sums.food),
  promos_silverware:      round2(sums.promos),
  voids_silverware:       round2(sums.voids),
  cancellations_silverware: round2(sums.cancellations),

  // ✅ NEW: per-day totals
  totals_by_date,

  source_sales:  "Silverware DailyTotals (Total)",
  source_extras: "Silverware DailyTotals",
  synced_at: admin.firestore.FieldValue.serverTimestamp(),
};


      await db.doc(integDocPath(loc, weekISO)).set(payload, { merge: true });
      console.log(`[${loc}] wrote → ${integDocPath(loc, weekISO)}`);
      console.table(payload);
    } catch (e) {
      console.error(`[${loc}] ERROR:`, e.message);
    }
  }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
