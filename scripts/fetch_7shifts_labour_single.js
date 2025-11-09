// scripts/fetch_7shifts_labour_single.js
// Fetch Daily Sales & Labor for ONE location & week from 7shifts,
// write the per-day doc you already use, AND publish weekly KPIs to:
//   masterDashboard/{WEEK_OF}/stores/{APP_KEY}
//
// REQUIRED ENV (GitHub Actions / local):
//   FIREBASE_SA_JSON      (stringified service account JSON)
//   FIREBASE_PROJECT_ID   (your Firebase/GCP project id)
//   SEVENSHIFTS_TOKEN     (Bearer token FOR THIS LOCATION'S COMPANY)
//   COMPANY_ID            (7shifts company id, integer, FOR THIS LOCATION)
//   LOCATION_ID           (7shifts location id, integer)
//   APP_KEY               (store id: prohibition | tulia | beacon | cesoir)
//   WEEK_OF               (optional Monday YYYY-MM-DD; defaults to current week's Monday)
//   TARGET_LABOUR_PCT     (optional e.g. "0.26")

const axios = require('axios');
const admin = require('firebase-admin');

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SA_JSON;
  if (!raw) throw new Error('FIREBASE_SA_JSON missing');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SA_JSON not valid JSON');
  }
}

function mondayISO(d = new Date()) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7; // 1=Mon..7
  if (day !== 1) dt.setUTCDate(dt.getUTCDate() - (day - 1));
  return dt.toISOString().slice(0, 10);
}
function isoAddDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// rounding helpers
function round2(n) {
  return Math.round((n ?? 0) * 100) / 100;
}
function round1pct(n) {
  return Math.round((n ?? 0) * 10) / 10;
}

async function main() {
  // ---- Firebase Admin ----
  const svc = parseServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(svc),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  const db = admin.firestore();

  // ---- Env ----
  const token = process.env.SEVENSHIFTS_TOKEN;
  const companyId = Number(process.env.COMPANY_ID);
  const locationId = Number(process.env.LOCATION_ID);
  const appKey = process.env.APP_KEY; // 'prohibition' | 'tulia' | 'beacon' | 'cesoir'
  if (!token || !companyId || !locationId || !appKey) {
    throw new Error(
      'Missing one of: SEVENSHIFTS_TOKEN, COMPANY_ID, LOCATION_ID, APP_KEY'
    );
  }

  const weekISO = process.env.WEEK_OF || mondayISO(new Date());
  const start = weekISO;
  const end = isoAddDays(weekISO, 6);

  // ---- 7shifts call ----
  const url = 'https://api.7shifts.com/v2/reports/daily_sales_and_labor';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const params = {
    company_id: companyId,
    location_id: locationId,
    start_date: start,
    end_date: end,
  };

  const { data } = await axios.get(url, { headers, params });
  const rows = data?.data || [];

  // ---- aggregate by date ----
  const byDate = {};
  for (const r of rows) {
    const d = r.date;
    if (!byDate[d])
      byDate[d] = {
        date: d,
        projected_sales: 0,
        actual_sales: 0,
        projected_labor_cost: 0,
        actual_labor_cost: 0,
        projected_labor_minutes: 0,
        actual_labor_minutes: 0,
      };
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

  // ---- write your existing week doc ----
  const target =
    process.env.TARGET_LABOUR_PCT != null
      ? Number(process.env.TARGET_LABOUR_PCT)
      : null;
  const ref = db.doc(`companies/aidan/locations/${appKey}/labour/${weekISO}`);
  await ref.set(
    { ...(target != null ? { target_labour_pct: target } : {}), days },
    { merge: true }
  );
  console.log(
    `[${appKey}] Wrote week ${weekISO} to Firestore (companies/.../labour).`
  );

  // ---- compute weekly KPIs ----
  const weekly = days.reduce(
    (acc, d) => {
      acc.projSales += d.projected_sales || 0;
      acc.actSales += d.actual_sales || 0;
      acc.projLab += d.projected_labor_cost || 0;
      acc.actLab += d.actual_labor_cost || 0;
      return acc;
    },
    { projSales: 0, actSales: 0, projLab: 0, actLab: 0 }
  );

  const projectedSales = round2(weekly.projSales);
  const actualSales7shifts = round2(weekly.actSales);
  const projectedLabourPct =
    projectedSales > 0 ? round1pct((weekly.projLab / projectedSales) * 100) : 0;
  const actualLabourPct =
    actualSales7shifts > 0
      ? round1pct((weekly.actLab / actualSales7shifts) * 100)
      : 0;

  // ---- publish to masterDashboard ----
  const masterRef = db.doc(`masterDashboard/${weekISO}/stores/${appKey}`);
  await masterRef.set(
    {
      storeId: appKey,
      weekISO,
      labour: {
        projectedSales,
        actualSales: actualSales7shifts, // will be overwritten by Silverware script later
        projectedLabourPct,
        actualLabourPct,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      _lastPublisher: 'labour_7shifts',
      _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(
    `[${appKey}] Published Labour KPIs to masterDashboard/${weekISO}/stores/${appKey}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
