// scripts/fetch_7shifts_labour_single.js
// Fetch Daily Sales & Labor for ONE location & week, then write a week doc to Firestore.
//
// REQUIRED ENV (GitHub Actions usually sets these):
//   FIREBASE_PROJECT_ID   (your Firebase/GCP project id)
//   FIREBASE_SA_JSON      (stringified service account JSON) OR
//   FIREBASE_SA_FILE      (path to service account json on disk, handy for local runs)
//
//   SEVENSHIFTS_TOKEN     (Bearer token FOR THIS LOCATION'S COMPANY)
//   COMPANY_ID            (7shifts company id, integer, FOR THIS LOCATION)
//   LOCATION_ID           (7shifts location id, integer)
//   APP_KEY               (frontend key: beacon | tulia | prohibition | cesoir)
//   WEEK_OF               (optional Monday YYYY-MM-DD; defaults to current week's Monday)
//   TARGET_LABOUR_PCT     (optional e.g. "0.26")
//
// WRITES to Firestore:
//   companies/aidan/locations/{APP_KEY}/labour/{WEEK_OF}
//   (days[] array with projected_* and actual_* fields)

const fs = require("fs");
const axios = require("axios");
const admin = require("firebase-admin");

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SA_JSON;
  const file = process.env.FIREBASE_SA_FILE;

  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("FIREBASE_SA_JSON is set but is not valid JSON");
    }
  }

  if (file) {
    try {
      const txt = fs.readFileSync(file, "utf8");
      return JSON.parse(txt);
    } catch (e) {
      throw new Error(`Failed to read FIREBASE_SA_FILE "${file}": ${e.message || e}`);
    }
  }

  throw new Error("You must set FIREBASE_SA_JSON or FIREBASE_SA_FILE");
}

function mondayISO(d = new Date()) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  if (day !== 1) dt.setUTCDate(dt.getUTCDate() - (day - 1));
  return dt.toISOString().slice(0, 10);
}

function isoAddDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeRows(payload) {
  // We’ve seen both:
  // 1) { data: [ ...rows ] }
  // 2) { data: { data: [ ...rows ] } }
  const a = payload?.data;
  if (Array.isArray(a)) return a;
  if (a && Array.isArray(a.data)) return a.data;
  return [];
}

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");

  const svc = parseServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(svc),
      projectId,
    });
  }
  const db = admin.firestore();

  const token = process.env.SEVENSHIFTS_TOKEN;
  const companyId = Number(process.env.COMPANY_ID);
  const locationId = Number(process.env.LOCATION_ID);
  const appKey = process.env.APP_KEY;

  if (!token || !companyId || !locationId || !appKey) {
    throw new Error("Missing one of: SEVENSHIFTS_TOKEN, COMPANY_ID, LOCATION_ID, APP_KEY");
  }

  const weekISO = process.env.WEEK_OF || mondayISO(new Date());
  const start = weekISO;
  const end = isoAddDays(weekISO, 6);

  const url = "https://api.7shifts.com/v2/reports/daily_sales_and_labor";
  const headers = { Authorization: `Bearer ${token}` };

  // ✅ CRITICAL: 7shifts requires end_date (NOT to_date)
  const params = {
    company_id: companyId,
    location_id: locationId,
    start_date: start,
    end_date: end,
  };

  let rows = [];
  try {
    const resp = await axios.get(url, { headers, params });
    rows = normalizeRows(resp.data);
  } catch (err) {
    const detail = err?.response?.data || err?.message || err;
    console.error("7shifts daily_sales_and_labor failed:", detail);
    throw err;
  }

  const byDate = {};
  for (const r of rows) {
    const d = String(r.date || "").slice(0, 10);
    if (!d) continue;

    if (!byDate[d]) {
      byDate[d] = {
        date: d,
        projected_sales: 0,
        actual_sales: 0,
        projected_labor_cost: 0,
        actual_labor_cost: 0,
        projected_labor_minutes: 0,
        actual_labor_minutes: 0,
      };
    }

    const row = byDate[d];
    row.projected_sales += r.projected_sales ?? 0;
    row.actual_sales += r.actual_sales ?? 0;
    row.projected_labor_cost += r.projected_labor_cost ?? 0;
    row.actual_labor_cost += r.actual_labor_cost ?? 0;
    row.projected_labor_minutes += r.projected_labor_minutes ?? 0;
    row.actual_labor_minutes += r.actual_labor_minutes ?? 0;
  }

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = isoAddDays(start, i);
    days.push(
      byDate[d] || {
        date: d,
        projected_sales: 0,
        actual_sales: 0,
        projected_labor_cost: 0,
        actual_labor_cost: 0,
        projected_labor_minutes: 0,
        actual_labor_minutes: 0,
      }
    );
  }

  const target =
    process.env.TARGET_LABOUR_PCT != null ? Number(process.env.TARGET_LABOUR_PCT) : null;

  const ref = db.doc(`companies/aidan/locations/${appKey}/labour/${weekISO}`);

  await ref.set(
    { ...(target != null ? { target_labour_pct: target } : {}), days },
    { merge: true }
  );

  console.log(`[${appKey}] Wrote 7shifts week ${weekISO} to Firestore (${start}..${end}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
