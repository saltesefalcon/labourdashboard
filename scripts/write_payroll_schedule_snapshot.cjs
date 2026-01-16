/**
 * scripts/write_payroll_schedule_snapshot.cjs
 *
 * Writes weekly payrollSchedule snapshots from 7shifts:
 *   companies/aidan/locations/{locKey}/payrollSchedule/{weekStartMonday}
 *
 * It pulls:
 *  - Shifts: /v2/company/{companyId}/shifts (for user_id, department_id, hourly_wage)
 *  - Users : /v2/company/{companyId}/users  (for first/last, employee_id, punch_id)
 *
 * Then it joins shifts -> users by user_id and writes an add-only roster source snapshot.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// -------------------------
// CLI args
// -------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv);
const weekOf = String(args.week_of || "").trim(); // YYYY-MM-DD (Monday)
const locationsArg = String(args.locations || "").trim(); // "beacon" or "beacon,tulia"
const weeksToWrite = Math.max(1, Number(args.weeks || 1)); // write week_of plus N weeks (1 or 2)

if (!weekOf || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
  console.error("Missing/invalid --week_of YYYY-MM-DD");
  process.exit(1);
}
if (!locationsArg) {
  console.error("Missing --locations (e.g. beacon or beacon,tulia)");
  process.exit(1);
}

const locationKeys = locationsArg.split(",").map(s => s.trim()).filter(Boolean);

// -------------------------
// Dept mapping (Beacon confirmed)
// -------------------------
const DEPT_MAP = {
  beacon: {
    BOH: new Set([363814]),
    FOH: new Set([356927, 463621]), // 463621 managers (keep FOH for now)
  },
  // add other locations later once you confirm their dept IDs
};

function deptFor(locKey, departmentId) {
  const n = Number(departmentId);
  const m = DEPT_MAP[locKey];
  if (!m) return "FOH";
  if (m.BOH.has(n)) return "BOH";
  return "FOH";
}

// -------------------------
// Firebase Admin init
// -------------------------
function tryReadJsonFile(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return null;
}

function initAdmin() {
  if (admin.apps.length) return;

  // Preferred in GitHub Actions: FIREBASE_SA_JSON secret
  if (process.env.FIREBASE_SA_JSON) {
    const sa = JSON.parse(process.env.FIREBASE_SA_JSON);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    return;
  }

  // If you've set GOOGLE_APPLICATION_CREDENTIALS locally:
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    return;
  }

  // Fallback: try common local file paths
  const candidates = [
    path.resolve(process.cwd(), "secrets", "labour-dashboard-sa.json"),
    path.resolve(process.cwd(), "service-account.labour-dashboard.json"),
  ];
  for (const c of candidates) {
    const sa = tryReadJsonFile(c);
    if (sa) {
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      return;
    }
  }

  console.error("❌ Could not init Firebase Admin. Set FIREBASE_SA_JSON or GOOGLE_APPLICATION_CREDENTIALS.");
  process.exit(1);
}

initAdmin();
const db = admin.firestore();

// -------------------------
// Helpers
// -------------------------
const MS_DAY = 86400000;

function utcDateFromISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function isoFromUTC(d) {
  return d.toISOString().slice(0, 10);
}
function addDaysUTC(d, days) {
  return new Date(d.getTime() + days * MS_DAY);
}

function cleanStr(v) {
  const s = (v == null ? "" : String(v)).trim();
  return s;
}

function centsToDollarsMaybe(cents) {
  const n = Number(cents);
  if (!isFinite(n)) return null;
  // 2300 => 23.00
  return Math.round(n) / 100;
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${body}`);
  }
  return await res.json();
}

function locConfig(locKey) {
  const prefix = locKey.toUpperCase(); // BEACON_...
  const token = process.env[`${prefix}_TOKEN`];
  const companyId = process.env[`${prefix}_COMPANY_ID`];
  const locationId = process.env[`${prefix}_LOCATION_ID`];

  if (!token || !companyId || !locationId) {
    throw new Error(
      `Missing env vars for ${locKey}. Need: ${prefix}_TOKEN, ${prefix}_COMPANY_ID, ${prefix}_LOCATION_ID`
    );
  }

  return {
    locKey,
    token: String(token),
    companyId: Number(companyId),
    locationId: Number(locationId),
  };
}

function scheduleDocRef(locKey, weekStartISO) {
  return db
    .collection("companies").doc("aidan")
    .collection("locations").doc(locKey)
    .collection("payrollSchedule").doc(weekStartISO);
}

// -------------------------
// 7shifts pulls
// -------------------------
async function pullUsers({ companyId, token }) {
  // NOTE: 7shifts may paginate; for now limit=250 is usually enough.
  // If you ever exceed 250 users, we’ll add pagination.
  const base = `https://api.7shifts.com/v2/company/${companyId}/users`;
  const qs = new URLSearchParams({ limit: "250" });
  const url = `${base}?${qs.toString()}`;
  const j = await fetchJson(url, token);

  const arr =
    Array.isArray(j?.data) ? j.data :
    Array.isArray(j?.users) ? j.users :
    Array.isArray(j) ? j :
    [];

  // Map by user id (matches shift.user_id)
  const map = new Map();
  for (const u of arr) {
    const id = u?.id ?? u?.user_id ?? u?.userId;
    if (!id) continue;

    const first = cleanStr(u.first_name ?? u.firstName ?? u.first ?? "");
    const last = cleanStr(u.last_name ?? u.lastName ?? u.last ?? "");

    // Employee number: you said employee_id is what you want.
    // BUT: if employee_id is blank (it often is), fall back to punch_id.
    const empNo =
      cleanStr(u.employee_id ?? u.employeeId ?? "") ||
      cleanStr(u.employee_number ?? u.employeeNumber ?? "") ||
      cleanStr(u.punch_id ?? u.punchId ?? "");

    const punchId = cleanStr(u.punch_id ?? u.punchId ?? "");

    map.set(String(id), {
      userId: String(id),
      first,
      last,
      empNo,
      punchId,
    });
  }
  return map;
}

async function pullShifts({ companyId, locationId, token }, weekStartISO) {
  const weekStart = utcDateFromISO(weekStartISO);
  const weekEndISO = isoFromUTC(addDaysUTC(weekStart, 7));

  // Use same date logic you used in PowerShell:
  const startGte = `${weekStartISO}T00:00:00Z`;
  const startLte = `${weekEndISO}T00:00:00Z`;

  const base = `https://api.7shifts.com/v2/company/${companyId}/shifts`;
  const qs = new URLSearchParams({
    location_id: String(locationId),
    limit: "250",
    "start[gte]": startGte,
    "start[lte]": startLte,
  });

  const url = `${base}?${qs.toString()}`;
  const j = await fetchJson(url, token);

  const arr =
    Array.isArray(j?.data) ? j.data :
    Array.isArray(j?.shifts) ? j.shifts :
    Array.isArray(j) ? j :
    [];

  return arr;
}

// -------------------------
// Build snapshot
// -------------------------
function upsertEmployee(map, emp) {
  const k = String(emp.empId);
  if (!map.has(k)) {
    map.set(k, emp);
    return;
  }
  const cur = map.get(k);

  // Dept: if any shift is BOH, keep BOH. Otherwise FOH.
  if (cur.dept !== "BOH" && emp.dept === "BOH") cur.dept = "BOH";

  // Wage: keep the highest non-null wage we see
  if (emp.wage != null) {
    const cw = Number(cur.wage);
    const ew = Number(emp.wage);
    if (!isFinite(cw) || ew > cw) cur.wage = ew;
  }

  // Backfill empNo
  if (!cur.empNo && emp.empNo) cur.empNo = emp.empNo;
}

async function writeOneWeek(locKey, cfg, weekStartISO) {
  const usersById = await pullUsers(cfg);
  const shifts = await pullShifts(cfg, weekStartISO);

  const employeesById = new Map();

  for (const s of shifts) {
    if (!s) continue;

    // Skip deleted/unassigned
    if (s.deleted === true) continue;
    if (s.unassigned === true) continue;
    if (!s.user_id) continue;

    const userId = String(s.user_id);
    const u = usersById.get(userId);

    const first = u?.first || "";
    const last = u?.last || "";

    // If we can't resolve a name, we still include the person by user_id,
    // but usually /users resolves it.
    const dept = deptFor(locKey, s.department_id);

    const wage = centsToDollarsMaybe(s.hourly_wage);
    const empNo = cleanStr(u?.empNo || "");

    upsertEmployee(employeesById, {
      dept,
      empId: userId,   // stable key for merging in the app
      empNo,           // employee_id or punch_id fallback
      first,
      last,
      wage: wage == null ? null : Number(wage),
      active: true,
    });
  }

  const employees = Array.from(employeesById.values())
    .filter(e => e.first || e.last || e.empId)
    .sort((a, b) => String(a.first || "").localeCompare(String(b.first || ""), undefined, { sensitivity: "base" }));

  const weekEndISO = isoFromUTC(addDaysUTC(utcDateFromISO(weekStartISO), 7));

  const payload = {
    weekStart: weekStartISO,
    weekEnd: weekEndISO,
    source: "7shifts",
    companyId: cfg.companyId,
    locationId: cfg.locationId,
    fetched_at: new Date().toISOString(),
    employees,
    counts: {
      employees: employees.length,
      shifts: shifts.length,
    },
  };

  await scheduleDocRef(locKey, weekStartISO).set(payload, { merge: true });
  console.log(`✅ Wrote payrollSchedule/${weekStartISO} for ${locKey} (${employees.length} employees, ${shifts.length} shifts)`);
}

(async () => {
  console.log(`Writing payrollSchedule snapshots. week_of=${weekOf} weeks=${weeksToWrite} locations=${locationKeys.join(",")}`);

  for (const locKey of locationKeys) {
    const cfg = locConfig(locKey);

    let d = utcDateFromISO(weekOf);
    for (let i = 0; i < weeksToWrite; i++) {
      const wk = isoFromUTC(d);
      await writeOneWeek(locKey, cfg, wk);
      d = addDaysUTC(d, 7);
    }
  }

  console.log("✅ Done");
  process.exit(0);
})().catch(err => {
  console.error("❌ Snapshot writer failed:");
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
