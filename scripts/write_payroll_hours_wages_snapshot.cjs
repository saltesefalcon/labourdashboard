#!/usr/bin/env node
"use strict";

/**
 * Writes 7shifts Hours & Wages report snapshots into Firestore (payroll-only path).
 *
 * Firestore:
 *  companies/aidan/locations/{loc}/payrollHoursWages/{weekStartISO}
 *
 * Usage:
 *  node scripts/write_payroll_hours_wages_snapshot.cjs --week_of 2026-01-05 --weeks 2 --locations beacon,tulia --punches true --detailed true
 *
 * Env (GitHub Secrets):
 *  FIREBASE_SA_JSON
 *  <LOC>_TOKEN
 *  <LOC>_COMPANY_ID
 *  <LOC>_LOCATION_ID
 */

const admin = require("firebase-admin");

// ---------- args ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      out[k] = v;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function splitCsv(s) {
  return String(s || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function isISODate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
}

const MS_DAY = 86400000;
function utcDateFromISO(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function isoFromUTC(d) {
  return d.toISOString().slice(0, 10);
}
function addDaysUTC(d, days) {
  return new Date(d.getTime() + days * MS_DAY);
}

function normalizeLocKey(k) {
  const s = String(k || "").trim().toLowerCase();
  if (s === "cesoar") return "cesoar"; // keep if you used this typo anywhere
  if (s === "ceso ir" || s === "ce soir") return "cesoar";
  if (s === "ceso i r") return "cesoar";
  if (s === "cesoir") return "cesoar";
  return s;
}

function locEnvPrefix(locKey) {
  switch (normalizeLocKey(locKey)) {
    case "beacon": return "BEACON";
    case "tulia": return "TULIA";
    case "prohibition": return "PROHIBITION";
    case "cesoar": return "CESOIR";
    default: return null;
  }
}

// ---------- firebase-admin init ----------
function initFirebaseAdminFromEnv() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SA_JSON;
  if (!raw) throw new Error("Missing FIREBASE_SA_JSON secret/env.");

  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_SA_JSON is not valid JSON.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}

// ---------- 7shifts fetch ----------
async function fetchJson(url, token) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}

  if (!res.ok) {
    const msg = (json && (json.message || json.error)) ? (json.message || json.error) : text;
    throw new Error(`7shifts HTTP ${res.status} ${res.statusText}: ${msg}`);
  }
  return json;
}

function pickTotals(t) {
  const src = t || {};
  const keys = [
    "regular_hours",
    "regular_pay",
    "overtime_hours",
    "overtime_pay",
    "holiday_hours",
    "holiday_pay",
    "compliance_exceptions_pay",
    "total_hours",
    "total_pay",
    "total_tips",
    "cash_tips",
    "credit_card_tips",
    "total_payment_tips",
    "pos_declared_tips",
    "auto_gratuity",
    "withheld_cc_amount",
    "tip_in",
    "tip_out",
    "earned_tips",
    "seven_punches_declared_tips",
  ];
  const out = {};
  for (const k of keys) {
    if (src[k] == null) continue;
    const n = Number(src[k]);
    out[k] = Number.isFinite(n) ? n : src[k];
  }
  return out;
}

function safeUserInfo(u) {
  const ui = u?.user || u?.user_information || u?.userInfo || {};
  const id =
    ui.id ??
    u.user_id ??
    u.id ??
    null;

  return {
    user_id: id == null ? null : Number(id),
    punch_id: ui.punch_id ?? u.punch_id ?? null,
    employee_id: ui.employee_id ?? u.employee_id ?? null,
    first_name: ui.first_name ?? ui.first ?? u.first_name ?? u.first ?? "",
    last_name: ui.last_name ?? ui.last ?? u.last_name ?? u.last ?? "",
  };
}

// ---- NEW: shift row normalizer (keeps docs small but UI-friendly) ----
function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function totalPayFromRow(r) {
  const explicit = num(r.total_pay);
  if (explicit != null) return explicit;
  const sum =
    (num(r.regular_pay) ?? 0) +
    (num(r.overtime_pay) ?? 0) +
    (num(r.double_overtime_pay) ?? 0) +
    (num(r.holiday_pay) ?? 0);
  return sum;
}

function normalizeShiftRow(shift, ui, locKey, weekStartISO) {
  const s = shift || {};
  return {
    locKey,
    weekStart: weekStartISO,

    // identity
    user_id: ui.user_id ?? null,
    employee_id: ui.employee_id ?? null,
    first_name: String(ui.first_name || "").trim(),
    last_name: String(ui.last_name || "").trim(),

    // time/label (7shifts shapes vary; keep what we can)
    date: s.date ?? s.day ?? s.shift_date ?? s.work_date ?? null,
    label: s.label ?? s.shift_label ?? null,
    in_time: s.in_time ?? s.inTime ?? s.clock_in ?? null,
    out_time: s.out_time ?? s.outTime ?? s.clock_out ?? null,

    // role + wage
    role_id: s.role_id ?? s.roleId ?? s.role ?? null,
    wage: num(s.wage ?? s.hourly_wage ?? s.rate ?? s.hourly_rate),

    // hours
    regular_hours: num(s.regular_hours),
    overtime_hours: num(s.overtime_hours),
    double_overtime_hours: num(s.double_overtime_hours),
    holiday_hours: num(s.holiday_hours),

    // pay
    regular_pay: num(s.regular_pay),
    overtime_pay: num(s.overtime_pay),
    double_overtime_pay: num(s.double_overtime_pay),
    holiday_pay: num(s.holiday_pay),
    total_pay: totalPayFromRow(s),
  };
}

function extractShiftRows(report, users, locKey, weekStartISO) {
  // Some variants return a top-level array
  if (Array.isArray(report?.shift_rows)) {
    return report.shift_rows.map(r => ({ ...r, locKey, weekStart: weekStartISO }));
  }

  // Common variant: per-user per-week shifts
  const out = [];
  const uArr = Array.isArray(users) ? users : [];
  for (const u of uArr) {
    const ui = safeUserInfo(u);
    const weeks = Array.isArray(u?.weeks) ? u.weeks : [];
    for (const w of weeks) {
      const shifts = Array.isArray(w?.shifts) ? w.shifts : [];
      for (const sh of shifts) {
        out.push(normalizeShiftRow(sh, ui, locKey, weekStartISO));
      }
    }

    // Sometimes "shifts" is directly on the user object
    if (!weeks.length && Array.isArray(u?.shifts)) {
      for (const sh of u.shifts) {
        out.push(normalizeShiftRow(sh, ui, locKey, weekStartISO));
      }
    }
  }
  return out;
}

// ---------- firestore refs ----------
const COMPANY_ID = "aidan";
function locRoot(db, locKey) {
  return db
    .collection("companies").doc(COMPANY_ID)
    .collection("locations").doc(locKey);
}
function payrollHoursWagesRef(db, locKey, weekStartISO) {
  return locRoot(db, locKey).collection("payrollHoursWages").doc(weekStartISO);
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);

  const weekOf = args.week_of || args.weekOf || "";
  const weeks = Number(args.weeks || 2);
  const locations = splitCsv(args.locations || "beacon").map(normalizeLocKey);

  // punches=true => worked hours/wages; punches=false => scheduled hours/wages
  const punches = String(args.punches ?? "true").toLowerCase() !== "false";

  // detailed=true => include shift-level rows (shift_rows)
  const detailed = String(args.detailed ?? "false").toLowerCase() === "true";

  if (!isISODate(weekOf)) {
    throw new Error(`--week_of must be YYYY-MM-DD (got: ${weekOf})`);
  }
  if (!Number.isFinite(weeks) || weeks < 1 || weeks > 6) {
    throw new Error(`--weeks must be 1..6 (got: ${args.weeks})`);
  }
  if (!locations.length) {
    throw new Error(`--locations is empty`);
  }

  initFirebaseAdminFromEnv();
  const db = admin.firestore();

  const weekStarts = [];
  {
    const start = utcDateFromISO(weekOf);
    for (let i = 0; i < weeks; i++) {
      weekStarts.push(isoFromUTC(addDaysUTC(start, i * 7)));
    }
  }

  console.log(`[hours&wages] week_of=${weekOf} weeks=${weeks} punches=${punches} detailed=${detailed}`);
  console.log(`[hours&wages] locations=${locations.join(", ")}`);
  console.log(`[hours&wages] weekStarts=${weekStarts.join(", ")}`);

  for (const locKey of locations) {
    const prefix = locEnvPrefix(locKey);
    if (!prefix) {
      console.warn(`[SKIP] Unknown locKey="${locKey}" (no env prefix mapping).`);
      continue;
    }

    const token = process.env[`${prefix}_TOKEN`];
    const companyId = process.env[`${prefix}_COMPANY_ID`];
    const locationId = process.env[`${prefix}_LOCATION_ID`];

    if (!token || !companyId || !locationId) {
      console.warn(`[SKIP] Missing env for ${locKey}: need ${prefix}_TOKEN, ${prefix}_COMPANY_ID, ${prefix}_LOCATION_ID`);
      continue;
    }

    for (const w of weekStarts) {
      const wStart = utcDateFromISO(w);
      const wEndISO = isoFromUTC(addDaysUTC(wStart, 6)); // Monday->Sunday

      const base = "https://api.7shifts.com/v2/reports/hours_and_wages";
      const qs = new URLSearchParams();
      qs.set("company_id", String(companyId));
      qs.set("location_id", String(locationId));
      qs.set("from", w);
      qs.set("to", wEndISO);
      qs.set("punches", punches ? "true" : "false");
      qs.set("detailed", detailed ? "true" : "false");
      qs.set("format", "json");

      const url = `${base}?${qs.toString()}`;

      console.log(`\n[FETCH] ${locKey} ${w}..${wEndISO} -> ${url}`);

      const raw = await fetchJson(url, token);

      const report = raw?.data ?? raw ?? {};
      const total = pickTotals(report.total || {});
      const settings = report.settings || report.filters || null;

      const users = Array.isArray(report.users) ? report.users : [];

      // ✅ NEW: extract shift rows when detailed=true
      const shift_rows = detailed ? extractShiftRows(report, users, locKey, w) : [];

      const slimUsers = users.map(u => {
        const ui = safeUserInfo(u);
        const userTotal = pickTotals(u.total || {});
        const userWeeks = Array.isArray(u.weeks)
          ? u.weeks.map(x => ({
              week: x.week || null,
              salaried: !!x.salaried,
              total: pickTotals(x.total || {}),
              // shifts are intentionally NOT stored here (we store shift_rows at top-level)
            }))
          : [];

        return {
          ...ui,
          salaried: !!u.salaried,
          total: userTotal,
          weeks: userWeeks,
        };
      });

      const doc = {
        location: locKey,
        weekStart: w,
        weekEnd: wEndISO,
        punches,
        detailed,
        total,
        settings,
        user_count: slimUsers.length,
        users: slimUsers,

        // ✅ what the UI table reads:
        shift_row_count: shift_rows.length,
        shift_rows,

        fetched_at: new Date().toISOString(),
        source: "7shifts:reports/hours_and_wages",
      };

      await payrollHoursWagesRef(db, locKey, w).set(doc, { merge: true });
      console.log(`[WRITE] companies/aidan/locations/${locKey}/payrollHoursWages/${w} users=${slimUsers.length} shift_rows=${shift_rows.length}`);
    }
  }

  console.log("\n✅ Done.");
}

main().catch(err => {
  console.error("❌ FAIL:", err?.message || err);
  process.exit(1);
});
