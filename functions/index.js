// functions/index.js
"use strict";

const admin = require("firebase-admin");
const { onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");

admin.initializeApp();

// ----- Secrets (already set via CLI/Console) -----
const SW_BASE_BEACON        = defineSecret("SILVERWARE_BASE_BEACON");
const SW_TOKEN_BEACON       = defineSecret("SILVERWARE_TOKEN_BEACON");
const SW_BASE_TULIA         = defineSecret("SILVERWARE_BASE_TULIA");
const SW_TOKEN_TULIA        = defineSecret("SILVERWARE_TOKEN_TULIA");
const SW_BASE_CESOIR        = defineSecret("SILVERWARE_BASE_CESOIR");
const SW_TOKEN_CESOIR       = defineSecret("SILVERWARE_TOKEN_CESOIR");
const SW_BASE_PROHIBITION   = defineSecret("SILVERWARE_BASE_PROHIBITION");
const SW_TOKEN_PROHIBITION  = defineSecret("SILVERWARE_TOKEN_PROHIBITION");

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
  const voids    = (isNum(day?.Voids?.TotalAmount) ? day.Voids.TotalAmount : 0)
                 + (isNum(day?.Cancellations?.TotalAmount) ? day.Cancellations.TotalAmount : 0);
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
function integDocPath(locKey, weekISO) {
  return `companies/aidan/locations/${locKey}/integrations/${weekISO}`;
}

exports.dispatchSilverwareDailyTotals = onCall(
  {
    region: "us-central1",
    secrets: [
      SW_BASE_BEACON, SW_TOKEN_BEACON,
      SW_BASE_TULIA, SW_TOKEN_TULIA,
      SW_BASE_CESOIR, SW_TOKEN_CESOIR,
      SW_BASE_PROHIBITION, SW_TOKEN_PROHIBITION,
    ],
    cors: true,
  },
  async (req) => {
    const week_of = req.data?.week_of;
    if (!week_of || !/^\d{4}-\d{2}-\d{2}$/.test(week_of)) {
      throw new Error("week_of (YYYY-MM-DD) is required");
    }
    const from = mondayOf(week_of);
    const to   = addDaysISO(from, 6);

    const locs = Array.isArray(req.data?.locations) && req.data.locations.length
      ? req.data.locations.map(s => String(s).toLowerCase())
      : Object.keys(MAP);

    const db = admin.firestore();
    const results = {};

    for (const loc of locs) {
      const cfg = MAP[loc];
      if (!cfg) { results[loc] = { ok:false, error:"invalid location" }; continue; }
      const base  = cfg.base.value();
      const token = cfg.token.value();
      if (!base || !token) { results[loc] = { ok:false, error:"missing secrets" }; continue; }

      try {
        const data  = await postDailyTotals(base, token, from, to);
        const sums  = rollup(toArrayDays(data));
        const r2    = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

        const payload = {
          total_sales_silverware: r2(sums.totalNet),  // use for Actual Sales
          food_sales_total:       r2(sums.food),      // Food-only
          promos_silverware:      r2(sums.promos),
          voids_silverware:       r2(sums.voids),
          source_sales:  "Silverware DailyTotals (Total)",
          source_extras: "Silverware DailyTotals",
          synced_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        const path = integDocPath(loc, from);
        await db.doc(path).set(payload, { merge: true });
        results[loc] = { ok: true, wrote: path, totals: payload };
      } catch (err) {
        logger.error(`[${loc}] ${err.message || err}`);
        results[loc] = { ok:false, error: String(err.message || err) };
      }
    }

    return { week_of: from, results };
  }
);

