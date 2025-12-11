// scripts/probe_daily_totals.mjs
// Usage:
//   node scripts/probe_daily_totals.mjs prohibition --from=2025-10-27 --to=2025-11-02 --debug
//   node scripts/probe_daily_totals.mjs cesoir       --week=2025-10-27 --debug

const loc = (process.argv[2] || "").toLowerCase();
if (!["prohibition","cesoir"].includes(loc)) {
  console.error("First arg must be prohibition|cesoir"); process.exit(1);
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

function pickFood(obj) {
  // Try common places: Department/Category/Revenue center buckets containing "Food" or "Kitchen"
  const f = flat(obj);
  const hints = (process.env.FOOD_CATEGORY_HINTS || "Food,Kitchen")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  // best single numeric for total sales
  let total = 0;
  for (const [k,v] of Object.entries(f)) {
    const lk = k.toLowerCase();
    if (isNum(v) && /\bsales\b|\bamount\b|\brevenue\b/.test(lk) && !/tax|gratuity|tip|deposit/.test(lk))
      total += v;
  }

  // sum any “foodish” buckets
  let food = 0;
  for (const [k,v] of Object.entries(f)) {
    const lk = k.toLowerCase();
    if (isNum(v) && hints.some(h => lk.includes(h)) && /sales|amount|revenue/.test(lk))
      food += v;
  }

  // promos/discounts & voids by keyword sweep
  let promos = 0, voids = 0;
  for (const [k,v] of Object.entries(f)) {
    const lk = k.toLowerCase();
    if (isNum(v) && /(discount|promo|promotion|comp|coupon)s?(\.|$)/.test(lk)) promos += v;
    if (isNum(v) && /(void|cancel|cancell?ed)s?(\.|$)/.test(lk))           voids  += v;
  }

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
  console.table({
    total_sales:   Math.round(roll.total),
    food_sales:    Math.round(roll.food),
    promos:        Math.round(roll.promos),
    voids:         Math.round(roll.voids),
  });

  // Show key names we saw to fine-tune mapping
  if (dbg) console.log("Sample keys seen:", pickFood(days[0]||{}).keys);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
