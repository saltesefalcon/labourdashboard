// scripts/fetch_7shifts_fohboh_week.mjs
// Pull weekly projected + actual FOH/BOH wages/hours from 7shifts and
// write companies/aidan/locations/{APP_KEY}/fohBoh/{WEEK_OF} in Firestore.
//
// Actual = Hours & Wages with punches=true (worked hours)
// Projected = Hours & Wages with punches=false (scheduled hours)
//
// Role classification reuses the same FOH/BOH rules proven in Cash-out Tip Tracker.

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
  return Math.round((Number(n) || 0) * 100) / 100;
}

function safeLower(s) {
  return String(s ?? "").toLowerCase();
}

// Same role rules used by the working Cash-out Tip Tracker 7shifts route.
function isFOHRole(roleName) {
  const r = safeLower(roleName);
  return /(server|bartender|host|runner|expo|bus|buss|barback|sa|server assistant|floor|manager)/i.test(r);
}

function isBOHRole(roleName) {
  const r = safeLower(roleName);
  return /(cook|dish|dishwasher|prep|chef|kitchen|line|pastry|baker|steward|porter|boh|back of house)/i.test(r);
}

// Optional exact-label env lists remain supported for backwards compatibility.
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
  const v = safeLower(label).trim();
  if (!v) return null;

  // BOH wins first, matching the Cash-out rule: exclude BOH before accepting FOH.
  if (bohSet.has(v)) return "boh";
  if (fohSet.has(v)) return "foh";
  if (isBOHRole(v)) return "boh";
  if (isFOHRole(v)) return "foh";
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
  const rows = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.data?.data)
      ? data.data.data
      : [];

  // Daily Sales & Labor returns cents in the current dashboard feed.
  const totalCents = rows.reduce((sum, r) => sum + Number(r.actual_sales ?? 0), 0);
  return round2(totalCents / 100);
}

async function fetchWeeklyFohBoh({ token, companyId, locationId, weekOf, punches }) {
  const start = weekOf;
  const end = addDays(weekOf, 6);

  const url = "https://api.7shifts.com/v2/reports/hours_and_wages";
  const headers = { Authorization: `Bearer ${token}` };
  const params = {
    company_id: companyId,
    location_id: locationId,
    from: start,
    to: end,
    punches,
  };

  const { data } = await axios.get(url, { headers, params });
  const payload = data?.data ?? data ?? {};
  const users = Array.isArray(payload?.users) ? payload.users : [];

  const fohRoles = parseRoleSet("FOH_ROLE_LABELS");
  const bohRoles = parseRoleSet("BOH_ROLE_LABELS");

  let fohHours = 0;
  let fohWages = 0;
  let bohHours = 0;
  let bohWages = 0;
  const unclassifiedRoles = new Set();

  for (const u of users) {
    const roles = Array.isArray(u?.roles) ? u.roles : [];
    for (const role of roles) {
      const label = role?.role_label ?? role?.role_name ?? role?.name ?? "";
      const kind = classifyRole(label, fohRoles, bohRoles);
      if (!kind) {
        if (String(label || "").trim()) unclassifiedRoles.add(String(label).trim());
        continue;
      }

      const t = role?.total || {};
      const hours = Number(t.total_hours || 0);
      const pay = Number(t.total_pay || 0);

      if (kind === "foh") {
        fohHours += hours;
        fohWages += pay;
      } else {
        bohHours += hours;
        bohWages += pay;
      }
    }
  }

  if (unclassifiedRoles.size) {
    console.log(
      `[${punches ? "actual" : "projected"}] Unclassified role labels ignored: ` +
      Array.from(unclassifiedRoles).sort().join(", ")
    );
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
    throw new Error(
      "Missing one of: SEVENSHIFTS_TOKEN, COMPANY_ID, LOCATION_ID, APP_KEY"
    );
  }

  const weekOf = process.env.WEEK_OF || mondayISO(new Date());
  console.log(
    `Running FOH/BOH fetch for appKey=${appKey}, locationId=${locationId}, weekOf=${weekOf}`
  );

  const [totalSales, actual, projected] = await Promise.all([
    fetchWeeklySales({ token, companyId, locationId, weekOf }),
    fetchWeeklyFohBoh({ token, companyId, locationId, weekOf, punches: true }),
    fetchWeeklyFohBoh({ token, companyId, locationId, weekOf, punches: false }),
  ]);

  const ref = db.doc(`companies/aidan/locations/${appKey}/fohBoh/${weekOf}`);

  await ref.set(
    {
      week_of: weekOf,
      total_sales: totalSales,

      // Backwards-compatible actual fields from the original script.
      foh_wages: actual.fohWages,
      boh_wages: actual.bohWages,
      foh_hours: actual.fohHours,
      boh_hours: actual.bohHours,

      // Explicit actual fields.
      actual_foh_wages: actual.fohWages,
      actual_boh_wages: actual.bohWages,
      actual_foh_hours: actual.fohHours,
      actual_boh_hours: actual.bohHours,

      // Scheduled/projected fields.
      projected_foh_wages: projected.fohWages,
      projected_boh_wages: projected.bohWages,
      projected_foh_hours: projected.fohHours,
      projected_boh_hours: projected.bohHours,

      classification: "cashout-role-rules-v1",
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const actualLabour = actual.fohWages + actual.bohWages;
  const actualPct = totalSales > 0 ? (actualLabour / totalSales) * 100 : 0;

  console.log(
    `Saved fohBoh/${weekOf} for ${appKey}: ` +
    `actual FOH=$${actual.fohWages.toFixed(2)}, actual BOH=$${actual.bohWages.toFixed(2)}, ` +
    `projected FOH=$${projected.fohWages.toFixed(2)}, projected BOH=$${projected.bohWages.toFixed(2)}, ` +
    `actual split labour=${actualPct.toFixed(1)}% of 7shifts sales`
  );
}

main().catch((err) => {
  const detail = err?.response?.data || err?.message || err;
  console.error("ERROR:", detail);
  process.exit(1);
});
