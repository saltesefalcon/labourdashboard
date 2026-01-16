#!/usr/bin/env node
"use strict";

/**
 * Writes 7shifts Hours & Wages report snapshots into Firestore (payroll-only path).
 *
 * Firestore:
 *  companies/aidan/locations/{loc}/payrollHoursWages/{weekStartISO}
 *
 * Usage:
 *  node scripts/write_payroll_hours_wages_snapshot.cjs --week_of 2026-01-05 --weeks 2 --locations beacon,tulia
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
  if (s === "ceso i r") return "cesoar";
  if (s === "ceso i r") return "cesoar";
  if (s === "cesoir") return "cesoar";
  return s;
}

function locEnvPrefix(locKey) {
  // Map your location key -> env prefix
  // NOTE: your payroll app uses keys like: beacon, tulia, prohibition, cesoar
  // If you prefer "cesoir", we can change it later—this matches your workflow inputs.
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
  // 7shifts report users typically have u.user containing identity fields
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

  // Keep docs small by default: detailed=false (no shift rows)
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

      // 7shifts Hours & Wages endpoint (report)
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

      // Some 7shifts endpoints wrap in { data: ... }
      const report = raw?.data ?? raw ?? {};
      const total = pickTotals(report.total || {});
      const settings = report.settings || report.filters || null;

      const users = Array.isArray(report.users) ? report.users : [];
      const slimUsers = users.map(u => {
        const ui = safeUserInfo(u);
        const userTotal = pickTotals(u.total || {});
        const userWeeks = Array.isArray(u.weeks)
          ? u.weeks.map(x => ({
              week: x.week || null,
              salaried: !!x.salaried,
              total: pickTotals(x.total || {}),
              // DO NOT STORE x.shifts here unless detailed=true and you REALLY want it later.
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
        fetched_at: new Date().toISOString(),
        source: "7shifts:reports/hours_and_wages",
      };

      await payrollHoursWagesRef(db, locKey, w).set(doc, { merge: true });
      console.log(`[WRITE] companies/aidan/locations/${locKey}/payrollHoursWages/${w} users=${slimUsers.length}`);
    }
  }

  console.log("\n✅ Done.");
}

main().catch(err => {
  console.error("❌ FAIL:", err?.message || err);
  process.exit(1);
});
