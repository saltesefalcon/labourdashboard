// scripts/fetch_7shifts_fohboh_week.mjs
// Pull weekly FOH/BOH wages + total sales from 7shifts and
// write companies/aidan/locations/{APP_KEY}/fohBoh/{WEEK_OF} in Firestore.
//
// ENV REQUIRED (for this run):
//   FIREBASE_PROJECT_ID     = "labour-dashboard"
//   FIREBASE_SA_JSON        = (stringified service account JSON)  OR
//   FIREBASE_SA_FILE        = path to JSON file on disk
//
//   SEVENSHIFTS_TOKEN       = Bearer token for this 7shifts company
//   COMPANY_ID              = 7shifts company id (integer)
//   LOCATION_ID             = 7shifts location id (integer for this store)
//   APP_KEY                 = beacon | tulia | prohibition | cesoir
//
//   WEEK_OF                 = Monday YYYY-MM-DD (optional; defaults to current week)
//
//   FOH_ROLE_LABELS         = comma-separated role names treated as FOH (e.g. "Server,Bartender,Host")
//   BOH_ROLE_LABELS         = comma-separated role names treated as BOH (e.g. "Cook,Dish,Prep")
//
// WRITES:
//   companies/aidan/locations/{APP_KEY}/fohBoh/{WEEK_OF}
//     {
//       week_of,
//       total_sales,     // number, dollars
//       foh_wages,       // number, dollars
//       boh_wages,       // number, dollars
//       foh_hours,       // number, hours
//       boh_hours,       // number, hours
//       updated_at: serverTimestamp(),
//       // (we DO NOT touch foh_target_pct / boh_target_pct)
//     }

import fs from "fs";
import axios from "axios";
import admin from "firebase-admin";

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
      throw new Error(
        `Failed to read FIREBASE_SA_FILE "${file}": ${e.message || e}`
      );
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
function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function round2(n) {
  return Math.round((n ?? 0) * 100) / 100;
}

function parseRoleSet(envName) {
  const raw = process.env[envName];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
function classifyRole(label, fohSet, bohSet) {
  const v = (label || "").toLowerCase();
  if (fohSet.has(v)) return "foh";
  if (bohSet.has(v)) return "boh";
  return null;
}

async function fetchWeeklySales({ token, companyId, locationId, weekOf }) {
  const start = weekOf;
  const end = addDays(weekOf, 6);

  const url = "https://api.7shifts.com/v2/reports/daily_sales_and_labor";
  const headers = { Authorization: `Bearer ${token}` };
  const params = {
    company_id: companyId,
    location_id: locationId,
    start_date: start,
    end_date: end,
  };

  const { data } = await axios.get(url, { headers, params });
  const rows = data?.data || [];

  // 7shifts returns cents in this report. Convert to dollars.
  const totalCents = rows.reduce(
    (sum, r) => sum + (r.actual_sales ?? 0),
    0
  );
  return round2(totalCents / 100);
}

async function fetchWeeklyFohBoh({ token, companyId, locationId, weekOf }) {
  const start = weekOf;
  const end = addDays(weekOf, 6);

  const url = "https://api.7shifts.com/v2/reports/hours_and_wages";
  const headers = { Authorization: `Bearer ${token}` };
  // Hours & Wages uses start/end (not start_date/end_date).
  const params = {
    company_id: companyId,
    location_id: locationId,
    start,
    end,
    punches: true,
  };

  const { data } = await axios.get(url, { headers, params });
  const users = data?.users || [];

  const fohRoles = parseRoleSet("FOH_ROLE_LABELS");
  const bohRoles = parseRoleSet("BOH_ROLE_LABELS");

  if (!fohRoles.size && !bohRoles.size) {
    console.warn(
      "WARNING: FOH_ROLE_LABELS and BOH_ROLE_LABELS are empty. " +
        "All roles will be treated as 'unclassified' and ignored."
    );
  }

  let fohHours = 0;
  let fohWages = 0;
  let bohHours = 0;
  let bohWages = 0;

  for (const u of users) {
    const roles = u.roles || [];
    for (const role of roles) {
      const kind = classifyRole(role.role_label, fohRoles, bohRoles);
      if (!kind) continue;
      const t = role.total || {};
      const hours = Number(t.total_hours || 0);
      const pay = Number(t.total_pay || 0); // already in dollars

      if (kind === "foh") {
        fohHours += hours;
        fohWages += pay;
      } else {
        bohHours += hours;
        bohWages += pay;
      }
    }
  }

  return {
    fohHours: round2(fohHours),
    fohWages: round2(fohWages),
    bohHours: round2(bohHours),
    bohWages: round2(bohWages),
  };
}

async function main() {
  const svc = parseServiceAccount();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");

  admin.initializeApp({
    credential: admin.credential.cert(svc),
    projectId,
  });
  const db = admin.firestore();

  const token = process.env.SEVENSHIFTS_TOKEN;
  const companyId = Number(process.env.COMPANY_ID);
  const locationId = Number(process.env.LOCATION_ID);
  const appKey = process.env.APP_KEY;

  if (!token || !companyId || !locationId || !appKey) {
    throw new Error(
      "Missing one of: SEVENSHIFTS_TOKEN, COMPANY_ID, LOCATION_ID, APP_KEY"
    );
  }

  const weekOf = process.env.WEEK_OF || mondayISO(new Date());
  console.log(
    `Running FOH/BOH fetch for appKey=${appKey}, locationId=${locationId}, weekOf=${weekOf}`
  );

  const [totalSales, fohBoh] = await Promise.all([
    fetchWeeklySales({ token, companyId, locationId, weekOf }),
    fetchWeeklyFohBoh({ token, companyId, locationId, weekOf }),
  ]);

  const ref = db.doc(
    `companies/aidan/locations/${appKey}/fohBoh/${weekOf}`
  );

  await ref.set(
    {
      week_of: weekOf,
      total_sales: totalSales,
      foh_wages: fohBoh.fohWages,
      boh_wages: fohBoh.bohWages,
      foh_hours: fohBoh.fohHours,
      boh_hours: fohBoh.bohHours,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      // We purposely do NOT touch foh_target_pct / boh_target_pct so your
      // adjustments from the UI stay in place.
    },
    { merge: true }
  );

  const totalLabour = fohBoh.fohWages + fohBoh.bohWages;
  const pct = totalSales > 0 ? (totalLabour / totalSales) * 100 : 0;

  console.log(
    `Saved fohBoh/${weekOf} for ${appKey}: sales=$${totalSales.toFixed(
      2
    )}, FOH=$${fohBoh.fohWages.toFixed(2)}, BOH=$${fohBoh.bohWages.toFixed(
      2
    )}, total labour=${pct.toFixed(1)}%`
  );
}

main().catch((err) => {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});

