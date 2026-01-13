// functions/index.js
"use strict";

const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");

const BUILD_TAG = "dispatchSilverwareDailyTotals-parseLocationsArg-2026-01-08";

admin.initializeApp();
const db = admin.firestore();

// ----- Secrets (already set via CLI/Console) -----
const SW_BASE_BEACON        = defineSecret("SILVERWARE_BASE_BEACON");
const SW_TOKEN_BEACON       = defineSecret("SILVERWARE_TOKEN_BEACON");
const SW_BASE_TULIA         = defineSecret("SILVERWARE_BASE_TULIA");
const SW_TOKEN_TULIA        = defineSecret("SILVERWARE_TOKEN_TULIA");
const SW_BASE_CESOIR        = defineSecret("SILVERWARE_BASE_CESOIR");
const SW_TOKEN_CESOIR       = defineSecret("SILVERWARE_TOKEN_CESOIR");
const SW_BASE_PROHIBITION   = defineSecret("SILVERWARE_BASE_PROHIBITION");
const SW_TOKEN_PROHIBITION  = defineSecret("SILVERWARE_TOKEN_PROHIBITION");

// ✅ ADD: GitHub PAT stored as a Firebase Functions secret
const GITHUB_TOKEN          = defineSecret("GITHUB_TOKEN");

// Your existing map (kept)
const MAP = {
  beacon:       { base: SW_BASE_BEACON,      token: SW_TOKEN_BEACON },
  tulia:        { base: SW_BASE_TULIA,       token: SW_TOKEN_TULIA },
  cesoir:       { base: SW_BASE_CESOIR,      token: SW_TOKEN_CESOIR },
  prohibition:  { base: SW_BASE_PROHIBITION, token: SW_TOKEN_PROHIBITION },
};

function mondayOf(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}
function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function postDailyTotals(base, token, bizFrom, bizTo) {
  const endpoint = `${base}/api/ThirdParty/DailyTotals`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ BusinessDateFrom: bizFrom, BusinessDateTo: bizTo }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0,200)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}
function toArrayDays(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.Days)) return payload.Days;
  return [payload];
}
const isNum = (v) => typeof v === "number" && isFinite(v);
function deriveFromOne(day) {
  let food = 0;
  for (const it of (day?.Sales?.Items || [])) {
    const name = (it?.Name || "").toString().toUpperCase();
    const id   = (it?.InterfaceID || "").toString();
    if (name === "FOOD" || id === "5000") {
      if (isNum(it?.NetAmount)) food += it.NetAmount;
    }
  }
  const promos   = isNum(day?.Discounts?.TotalAmount) ? day.Discounts.TotalAmount : 0;
  const voids = isNum(day?.Voids?.TotalAmount) ? day.Voids.TotalAmount : 0;
  const totalNet = isNum(day?.Sales?.TotalNetAmount) ? day.Sales.TotalNetAmount : 0;
  return { food, promos, voids, totalNet };
}
function rollup(days) {
  return days.reduce((a, d) => {
    const x = deriveFromOne(d);
    a.food += x.food; a.promos += x.promos; a.voids += x.voids; a.totalNet += x.totalNet;
    return a;
  }, { food:0, promos:0, voids:0, totalNet:0 });
}

const ALLOWED_LOCATIONS = new Set(["beacon", "tulia", "cesoir", "prohibition"]);

function parseLocationsArg(input) {
  let arr = [];

  if (input == null) arr = [];
  else if (Array.isArray(input)) arr = input.map((x) => String(x));
  else if (typeof input === "string") arr = input.split(",").map((s) => s.trim());
  else {
    throw new HttpsError("invalid-argument", "locations must be an array or comma-separated string");
  }

  const normalized = arr
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new HttpsError("invalid-argument", "locations is required (e.g. ['beacon'])");
  }

  const unknown = normalized.filter((x) => !ALLOWED_LOCATIONS.has(x));
  if (unknown.length) {
    throw new HttpsError("invalid-argument", `Unknown locations: ${unknown.join(", ")}`);
  }

  return Array.from(new Set(normalized));
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function daysBetweenInclusive(fromISO, toISO) {
  if (!isISODate(fromISO) || !isISODate(toISO)) {
    throw new HttpsError("invalid-argument", "from/to must be YYYY-MM-DD");
  }

  const fromD = new Date(fromISO + "T00:00:00Z");
  const toD   = new Date(toISO + "T00:00:00Z");

  if (isNaN(fromD.getTime()) || isNaN(toD.getTime())) {
    throw new HttpsError("invalid-argument", "Invalid date value for from/to");
  }
  if (fromD > toD) {
    throw new HttpsError("invalid-argument", "from must be <= to");
  }

  const out = [];
  for (let d = new Date(fromD); d <= toD; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function r2(n) {
  const x = Number(n) || 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function extractTotalsFromDailyTotalsPayload(raw) {
  const days = toArrayDays(raw);
  const r = rollup(days);

  return {
    totalNet: r.totalNet,
    foodSales: r.food,
    discounts: r.promos,
    voids: r.voids,
  };
}

function integDocPath(locKey, weekISO) {
  return `companies/aidan/locations/${locKey}/integrations/${weekISO}`;
}

/* =======================================================================================
   ✅ ADD: dispatchFetchWeek — triggers your GitHub Action that fetches 7shifts + sales week
   ======================================================================================= */

// 🔧 Set these to match your repo + workflow file in .github/workflows/
const GH_OWNER = "saltesefalcon";
const GH_REPO = "labourdashboard";

// IMPORTANT: update this to your real workflow filename in GitHub (case-sensitive)
const GH_WORKFLOW_FILE = "fetch_labour_and_sales.yml"; // <-- CHANGE THIS if your workflow has a different name
const GH_REF = "main";

async function githubWorkflowDispatch({ token, workflowFile, ref, inputs }) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${workflowFile}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "labour-dashboard-dispatchFetchWeek",
    },
    body: JSON.stringify({ ref, inputs }),
  });

  if (res.status === 204) return { ok: true };

  const txt = await res.text().catch(() => "");
  return { ok: false, status: res.status, body: txt.slice(0, 500) };
}

exports.dispatchFetchWeek = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: [GITHUB_TOKEN],
  },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");

    const data = request.data || {};
    const weekOf = data.week_of || data.week || data.weekOf || null;

    if (!weekOf || !isISODate(weekOf)) {
      throw new HttpsError("invalid-argument", "week_of is required (YYYY-MM-DD, Monday)");
    }

    // If the client doesn’t pass locations, default to ALL locations
    let locations = ["beacon", "tulia", "cesoir", "prohibition"];
    if (data.locations != null) {
      locations = parseLocationsArg(data.locations);
    }

    // These match what your UI was sending (seen in your _check.mjs)
    const includeSales = data.include_sales == null ? true : !!data.include_sales;
    const includeExtras = data.include_extras == null ? true : !!data.include_extras;

    const token = (GITHUB_TOKEN.value() || "").trim();
    if (!token) throw new HttpsError("failed-precondition", "Missing GITHUB_TOKEN secret");

    // Try with inputs first
    const inputs = { week_of: weekOf };


    logger.info("dispatchFetchWeek -> GitHub workflow dispatch", {
      workflow: GH_WORKFLOW_FILE,
      ref: GH_REF,
      inputs,
    });

    let out = await githubWorkflowDispatch({
      token,
      workflowFile: GH_WORKFLOW_FILE,
      ref: GH_REF,
      inputs,
    });

    // If workflow doesn’t define inputs, GitHub returns 422. Retry with NO inputs.
    if (!out.ok && out.status === 422) {
      logger.warn("Workflow dispatch rejected inputs; retrying without inputs", { body: out.body });
      out = await githubWorkflowDispatch({
        token,
        workflowFile: GH_WORKFLOW_FILE,
        ref: GH_REF,
        inputs: undefined,
      });
    }

    if (!out.ok) {
      throw new HttpsError(
        "internal",
        `GitHub dispatch failed (status ${out.status || "?"}). ${out.body || ""}`.slice(0, 900)
      );
    }

    return {
      ok: true,
      week_of: weekOf,
      dispatched: { workflow: GH_WORKFLOW_FILE, ref: GH_REF, locations },
    };
  }
);

/* =======================================================================================
   Existing function: dispatchSilverwareDailyTotals
   ======================================================================================= */

exports.dispatchSilverwareDailyTotals = onCall(
  { region: "us-central1", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    logger.info(`BUILD_TAG=${BUILD_TAG}`);
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");

    const data = request.data || {};
    const week = data.week || data.week_of || null;
    const fromIn = data.from || null;
    const toIn = data.to || null;

    let from = null;
    let to = null;

    if (week) {
      from = week;
      to = addDaysISO(week, 6);
    } else if (fromIn && toIn) {
      from = fromIn;
      to = toIn;
    } else {
      throw new HttpsError(
        "invalid-argument",
        "Provide week (YYYY-MM-DD) OR from/to (YYYY-MM-DD)."
      );
    }

    const locations = parseLocationsArg(data.locations || null);
    const daysISO = daysBetweenInclusive(from, to);

    const results = {};

    for (const loc of locations) {
      try {
        const base  = process.env[`SILVERWARE_BASE_${loc.toUpperCase()}`];
        const token = process.env[`SILVERWARE_TOKEN_${loc.toUpperCase()}`];

        if (!base || !token) {
          throw new Error(`Missing SILVERWARE_BASE_${loc.toUpperCase()}/SILVERWARE_TOKEN_${loc.toUpperCase()} env vars`);
        }

        const sw_sales_by_date = {};

        let total_sales_silverware = 0;
        let food_sales_total = 0;
        let promos_silverware = 0;
        let voids_silverware = 0;

        for (const dayISO of daysISO) {
          const raw = await postDailyTotals(base, token, dayISO, dayISO);

          if (raw && raw.Success === false) {
            throw new Error(`DailyTotals Success=false for ${loc} ${dayISO}`);
          }

          const t = extractTotalsFromDailyTotalsPayload(raw);

          const sales = r2(t.totalNet ?? 0);
          sw_sales_by_date[dayISO] = sales;

          total_sales_silverware += sales;
          food_sales_total += r2(t.foodSales ?? 0);
          promos_silverware += r2(t.discounts ?? 0);
          voids_silverware += r2(t.voids ?? 0);
        }

        const payload = {
          total_sales_silverware: r2(total_sales_silverware),
          food_sales_total: r2(food_sales_total),
          promos_silverware: r2(promos_silverware),
          voids_silverware: r2(voids_silverware),

          sw_sales_by_date,

          sw_food_by_date: admin.firestore.FieldValue.delete(),
          sw_promos_by_date: admin.firestore.FieldValue.delete(),
          sw_voids_by_date: admin.firestore.FieldValue.delete(),

          source_sales: "Silverware DailyTotals (per-day)",
          source_extras: "Silverware DailyTotals",
          writer_tag: "daily_totals_cf_v2",
          synced_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        const path = integDocPath(loc, from);
        await db.doc(path).set(payload, { merge: true });
        logger.info(`WROTE_INTEGRATION_DOC=${path} days=${Object.keys(sw_sales_by_date).length}`);

        results[loc] = { ok: true, wrote: path };

      } catch (err) {
        logger.error(`[${loc}] ${err?.message || err}`);
        results[loc] = { ok: false, error: String(err?.message || err) };
      }
    }

    return { week_of: from, results };
  }
);
