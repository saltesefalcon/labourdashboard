#!/usr/bin/env node
"use strict";

/**
 * Writes 7shifts Hours & Wages report snapshots into Firestore (payroll-only path).
 *
 * Firestore:
 *  companies/aidan/locations/{loc}/payrollHoursWages/{weekStartISO}
 *
 * Usage:
 *  node scripts/write_payroll_hours_wages_snapshot.cjs --week_of 2026-01-05 --weeks 2 --locations beacon,tulia --detailed true
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
  if (s === "cesoar") return "cesoar";
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

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function pickTotals(t) {
  const src = t || {};
  const keys = [
    "regular_hours","regular_pay","overtime_hours","overtime_pay",
    "holiday_hours","holiday_pay","compliance_exceptions_pay",
    "total_hours","total_pay","total_tips","cash_tips","credit_card_tips",
    "total_payment_tips","pos_declared_tips","auto_gratuity","withheld_cc_amount",
    "tip_in","tip_out","earned_tips","seven_punches_declared_tips",
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
  const id = ui.id ?? u.user_id ?? u.id ?? null;

  return {
    user_id: id == null ? null : Number(id),
    punch_id: ui.punch_id ?? u.punch_id ?? null,
    employee_id: ui.employee_id ?? u.employee_id ?? null,
    first_name: ui.first_name ?? ui.first ?? u.first_name ?? u.first ?? "",
    last_name: ui.last_name ?? ui.last ?? u.last_name ?? u.last ?? "",
  };
}

function pickWageFromAnything(obj) {
  const o = obj || {};
  const candidates = [
    o.wage, o.hourly_wage, o.hourly_rate, o.rate, o.pay_rate, o.wage_rate,
    o.hourlyRate, o.payRate
  ];
  for (const c of candidates) {
    const n = numOrNull(c);
    if (n != null && n > 0) return n;
  }
  return null;
}

// --- time parsing helpers (fallback compute) ---
function parseTime12ToMinutes(t) {
  const s = String(t || "").trim().toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/);
  if (!m) return null;
  let hh = Number(m[1]);
  let mm = Number(m[2] || "0");
  const ap = m[3];
  if (hh === 12) hh = 0;
  if (ap === "PM") hh += 12;
  return hh * 60 + mm;
}

function parseTime24ToMinutes(hms) {
  const s = String(hms || "").trim();
  const m = s.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh * 60 + mm;
}

function splitLabelTimes(label) {
  const s = String(label || "").trim();
  const parts = s.split("-").map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return { inLabel: "", outLabel: "" };
  return { inLabel: parts[0].replace(/\s+/g, ""), outLabel: parts[1].replace(/\s+/g, "") };
}

function sumUnpaidBreakMins(breaksArr) {
  const arr = Array.isArray(breaksArr) ? breaksArr : [];
  let mins = 0;
  for (const b of arr) {
    const s = String(b || "");
    if (!/unpaid/i.test(s)) continue;
    const m = s.match(/-\s*(\d+)\s*min/i);
    if (m) mins += Number(m[1]);
  }
  return mins;
}

function computeHours(startMin, endMin, crossesMidnight, unpaidBreakMins) {
  if (startMin == null || endMin == null) return null;
  let dur = endMin - startMin;
  if (crossesMidnight) dur += 1440;
  dur -= (unpaidBreakMins || 0);
  if (dur < 0) dur = 0;
  return round2(dur / 60);
}

// ---------- firestore refs ----------
const COMPANY_ID = "aidan";
function locRoot(db, locKey) {
  return db.collection("companies").doc(COMPANY_ID).collection("locations").doc(locKey);
}
function payrollHoursWagesRef(db, locKey, weekStartISO) {
  return locRoot(db, locKey).collection("payrollHoursWages").doc(weekStartISO);
}

// ---------- shift row extraction ----------
function pickShiftNumbers(shift) {
  const s = shift || {};
  const t = s.total || s.totals || s.shift_total || s.shiftTotals || null;
  const src = t || s;

  return {
    wage: pickWageFromAnything(src),
    regular_hours: numOrNull(src.regular_hours ?? src.regularHours),
    ot_hours: numOrNull(src.overtime_hours ?? src.overtimeHours ?? src.ot_hours ?? src.otHours),
    double_ot_hours: numOrNull(src.double_overtime_hours ?? src.doubleOvertimeHours ?? src.double_ot_hours ?? src.doubleOtHours),
    holiday_hours: numOrNull(src.holiday_hours ?? src.holidayHours),

    regular_pay: numOrNull(src.regular_pay ?? src.regularPay),
    ot_pay: numOrNull(src.overtime_pay ?? src.overtimePay ?? src.ot_pay ?? src.otPay),
    double_ot_pay: numOrNull(src.double_overtime_pay ?? src.doubleOvertimePay ?? src.double_ot_pay ?? src.doubleOtPay),
    holiday_pay: numOrNull(src.holiday_pay ?? src.holidayPay),
    total_pay: numOrNull(src.total_pay ?? src.totalPay),
  };
}

function extractShiftRowsForUser(u, locKey) {
  const ui = safeUserInfo(u);
  const userWage = pickWageFromAnything(u) || pickWageFromAnything(u.total) || null;

  const weeks = Array.isArray(u.weeks) ? u.weeks : [];
  const rows = [];

  for (const wk of weeks) {
    const shifts = Array.isArray(wk?.shifts) ? wk.shifts : [];
    for (const sh of shifts) {
      const startRaw = sh.date || sh.start || sh.start_at || sh.start_time || sh.startTime || "";
      const startISODate = String(startRaw).slice(0, 10);

      const label = sh.label || sh.time_label || sh.shift_label || "";
      const { inLabel, outLabel } = splitLabelTimes(label);

      // Try multiple sources for start/end minutes
      const startMin =
        parseTime24ToMinutes(sh.start_time || sh.startTime) ??
        parseTime24ToMinutes(String(startRaw).slice(11, 19)) ??
        parseTime12ToMinutes(inLabel);

      const endMin =
        parseTime24ToMinutes(sh.end_time || sh.endTime) ??
        parseTime12ToMinutes(outLabel);

      const crossesMidnight = (startMin != null && endMin != null) ? (endMin < startMin) : false;
      const unpaidBreakMins = sumUnpaidBreakMins(sh.breaks);

      const nums = pickShiftNumbers(sh);
      const wage = nums.wage || userWage || null;

      // Prefer payload if present, else compute
      let regular_hours = nums.regular_hours;
      let ot_hours = nums.ot_hours ?? 0;
      let double_ot_hours = nums.double_ot_hours ?? 0;
      let holiday_hours = nums.holiday_hours ?? 0;

      if (regular_hours == null || regular_hours <= 0) {
        const computed = computeHours(startMin, endMin, crossesMidnight, unpaidBreakMins);
        if (computed != null) regular_hours = computed;
      }
      if (regular_hours == null) regular_hours = 0;

      let regular_pay = nums.regular_pay;
      let ot_pay = nums.ot_pay ?? 0;
      let double_ot_pay = nums.double_ot_pay ?? 0;
      let holiday_pay = nums.holiday_pay ?? 0;
      let total_pay = nums.total_pay;

      if ((regular_pay == null || regular_pay <= 0) && wage != null && regular_hours > 0) {
        regular_pay = round2(regular_hours * wage);
      }
      if (regular_pay == null) regular_pay = 0;

      if (total_pay == null || total_pay <= 0) {
        total_pay = round2((regular_pay || 0) + (ot_pay || 0) + (double_ot_pay || 0) + (holiday_pay || 0));
      }

      const roleName = sh.role_name || sh.role || sh.position_name || sh.position || "";
      const roleId = sh.role_id ?? sh.position_id ?? sh.roleId ?? sh.positionId ?? null;

      rows.push({
        employee_id: ui.employee_id ?? null,
        user_id: ui.user_id ?? null,
        first_name: ui.first_name || "",
        last_name: ui.last_name || "",
        location: locKey,

        date: startISODate || "",
        in_time: inLabel || "",
        out_time: outLabel || "",
        label: label || "",
        breaks: Array.isArray(sh.breaks) ? sh.breaks : [],

        start_min: startMin,
        end_min: endMin,
        crosses_midnight: !!crossesMidnight,
        unpaid_break_mins: unpaidBreakMins,

        role: roleName || (roleId != null ? String(roleId) : ""),
        role_id: roleId,

        wage: wage,

        regular_hours,
        ot_hours,
        double_ot_hours,
        holiday_hours,

        regular_pay,
        ot_pay,
        double_ot_pay,
        holiday_pay,
        total_pay,

        computed: {
          used_compute_hours: (nums.regular_hours == null || nums.regular_hours <= 0),
          used_compute_pay: (nums.regular_pay == null || nums.regular_pay <= 0),
        },
      });
    }
  }

  return rows;
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);

  const weekOf = args.week_of || args.weekOf || "";
  const weeks = Number(args.weeks || 2);
  const locations = splitCsv(args.locations || "beacon").map(normalizeLocKey);

  const punches = String(args.punches ?? "true").toLowerCase() !== "false";
  const detailed = String(args.detailed ?? "false").toLowerCase() === "true";

  if (!isISODate(weekOf)) throw new Error(`--week_of must be YYYY-MM-DD (got: ${weekOf})`);
  if (!Number.isFinite(weeks) || weeks < 1 || weeks > 6) throw new Error(`--weeks must be 1..6 (got: ${args.weeks})`);
  if (!locations.length) throw new Error(`--locations is empty`);

  initFirebaseAdminFromEnv();
  const db = admin.firestore();

  const weekStarts = [];
  {
    const start = utcDateFromISO(weekOf);
    for (let i = 0; i < weeks; i++) weekStarts.push(isoFromUTC(addDaysUTC(start, i * 7)));
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

      // Slim users (keep existing behavior)
      const slimUsers = users.map(u => {
        const ui = safeUserInfo(u);
        const userTotal = pickTotals(u.total || {});
        const userWeeks = Array.isArray(u.weeks)
          ? u.weeks.map(x => ({
              week: x.week || null,
              salaried: !!x.salaried,
              total: pickTotals(x.total || {}),
            }))
          : [];

        return {
          ...ui,
          salaried: !!u.salaried,
          total: userTotal,
          weeks: userWeeks,
        };
      });

      // Detailed shift rows (new)
      let shift_rows = [];
      if (detailed) {
        for (const u of users) shift_rows.push(...extractShiftRowsForUser(u, locKey));
      }

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

        shift_row_count: detailed ? shift_rows.length : 0,
        shift_rows: detailed ? shift_rows : [],

        fetched_at: new Date().toISOString(),
        source: "7shifts:reports/hours_and_wages",
      };

      await payrollHoursWagesRef(db, locKey, w).set(doc, { merge: true });
      console.log(`[WRITE] companies/aidan/locations/${locKey}/payrollHoursWages/${w} users=${slimUsers.length} shift_rows=${doc.shift_row_count}`);
    }
  }

  console.log("\n✅ Done.");
}

main().catch(err => {
  console.error("❌ FAIL:", err?.message || err);
  process.exit(1);
});
