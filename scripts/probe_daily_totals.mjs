// scripts/probe_daily_totals.mjs
// Usage:
//   node scripts/probe_daily_totals.mjs prohibition --from=2025-10-27 --to=2025-11-02 --debug
//   node scripts/probe_daily_totals.mjs cesoir       --week=2025-10-27 --debug

const loc = (process.argv[2] || "").toLowerCase();
if (!["beacon","tulia","prohibition","cesoir"].includes(loc)) {
  console.error("First arg must be beacon|tulia|prohibition|cesoir");
  process.exit(1);
}

const BASE = process.env[`SILVERWARE_BASE_${loc.toUpperCase()}`];
const TOKEN = process.env[`SILVERWARE_TOKEN_${loc.toUpperCase()}`];
if (!BASE || !TOKEN) {
  console.error(`Missing envs: SILVERWARE_BASE_${loc.toUpperCase()} and SILVERWARE_TOKEN_${loc.toUpperCase()}`);
  process.exit(1);
}

const dbg = process.argv.includes("--debug");
const arg = (k) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : null;
};

function mondayOf(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0,10);
}

let from = arg("from");
let to   = arg("to");
const week = arg("week");
if (week) { from = mondayOf(week); const d = new Date(from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate()+6); to = d.toISOString().slice(0,10); }
if (!from || !to) { console.error("Provide --from=YYYY-MM-DD --to=YYYY-MM-DD or --week=YYYY-MM-DD"); process.exit(1); }

const endpoint = `${BASE}/api/ThirdParty/DailyTotals`;

async function postDailyTotals(bizFrom, bizTo) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ BusinessDateFrom: bizFrom, BusinessDateTo: bizTo })
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0,200)}`);
  }
  try { return JSON.parse(txt); } catch { return txt; }
}

const isNum = v => typeof v === "number" && isFinite(v);
const flat = (obj, pref="", out={}) => {
  if (obj && typeof obj === "object") {
    for (const [k,v] of Object.entries(obj)) {
      const key = pref ? `${pref}.${k}` : k;
      if (v && typeof v === "object") flat(v, key, out);
      else out[key] = v;
    }
  }
  return out;
};

function normalizeCurrency(n){
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  // if Silverware ever returns cents as big integers, convert to dollars
  return v >= 100000 ? (v * 0.01) : v;
}

function pickFood(obj) {
  // Keep keys list for debug visibility
  const f = flat(obj);

  // TOTAL SALES: use Sales.TotalNetAmount (this matches what you see in the payload)
  const total = normalizeCurrency(
    obj?.Sales?.TotalNetAmount ??
    obj?.Sales?.TotalGrossAmount ??
    0
  );

  // FOOD SALES: explicitly pull FOOD row from Sales.Items (InterfaceID 5000)
  let food = 0;
  const items = Array.isArray(obj?.Sales?.Items) ? obj.Sales.Items : [];
  for (const it of items){
    const name = String(it?.Name ?? it?.name ?? "").toUpperCase();
    const id   = String(it?.InterfaceID ?? it?.interfaceID ?? it?.interfaceId ?? "");
    const isFood = (name === "FOOD") || (id === "5000");
    if (!isFood) continue;

    const net = Number(it?.NetAmount ?? it?.netAmount ?? it?.Net ?? it?.net ?? 0) || 0;
    food += net;
  }
  food = normalizeCurrency(food);

  // PROMOS/DISCOUNTS: use Discounts.TotalAmount (matches payload Discounts section)
  const promos = normalizeCurrency(
    obj?.Discounts?.TotalAmount ??
    obj?.Sales?.TotalDiscountAmount ??
    0
  );

  // VOIDS: ONLY use Voids.TotalAmount (DO NOT include cancellations)
  const voids = normalizeCurrency(
    obj?.Voids?.TotalAmount ?? 0
  );

  return { total, food, promos, voids, keys: Object.keys(f).slice(0,60) };
}


(async () => {
  console.log(`[${loc}] probe ${from}..${to}`);
  const data = await postDailyTotals(from, to);
  if (dbg) {
    console.log("RAW (truncated preview):");
    console.dir(data, { depth: 6 });
  }
  // The API may return an object with days, or a single rollup. Try both.
  const days = Array.isArray(data) ? data : (Array.isArray(data?.Days) ? data.Days : [data]);

  let roll = { total:0, food:0, promos:0, voids:0 };
  for (const d of days) {
    const m = pickFood(d);
    roll.total  += m.total;
    roll.food   += m.food;
    roll.promos += m.promos;
    roll.voids  += m.voids;
  }

console.log(`[${loc}] Totals for ${from}..${to}`);

const r2 = n => Math.round(n * 100) / 100;

console.table({
  total_sales: r2(roll.total),
  food_sales:  r2(roll.food),
  promos:      r2(roll.promos),
  voids:       r2(roll.voids),
});


  // Show key names we saw to fine-tune mapping
  if (dbg) console.log("Sample keys seen:", pickFood(days[0]||{}).keys);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
