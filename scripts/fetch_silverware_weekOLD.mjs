// Usage:
//   WEEK_OF=2025-10-06 node scripts/fetch_silverware_week.mjs
//
// Env (GitHub Actions / local):
//   FIREBASE_SERVICE_ACCOUNT_JSON
//   SILVERWARE_BASE_BEACON / SILVERWARE_TOKEN_BEACON
//   SILVERWARE_BASE_TULIA  / SILVERWARE_TOKEN_TULIA
//   SILVERWARE_BASE_PROHIBITION / SILVERWARE_TOKEN_PROHIBITION
//   SILVERWARE_BASE_CESOIR / SILVERWARE_TOKEN_CESOIR
//   OPTIONAL:
//     FOOD_CATEGORY_HINTS="Food,Kitchen"    // comma-separated aliases
//     SILVERWARE_TZ_OFFSET_MINUTES="-240"   // e.g., -240 for EDT

import admin from "firebase-admin";

const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();

// ------- location config (no secrets in code) -------
const LOCS = {
  beacon: {
    base: process.env.SILVERWARE_BASE_BEACON,
    token: process.env.SILVERWARE_TOKEN_BEACON,
  },
  tulia: {
    base: process.env.SILVERWARE_BASE_TULIA,
    token: process.env.SILVERWARE_TOKEN_TULIA,
  },
  prohibition: {
    base: process.env.SILVERWARE_BASE_PROHIBITION,
    token: process.env.SILVERWARE_TOKEN_PROHIBITION,
  },
  cesoir: {
    base: process.env.SILVERWARE_BASE_CESOIR,
    token: process.env.SILVERWARE_TOKEN_CESOIR,
  },
};

// ------- time helpers -------
function mondayISO(d = new Date()) {
  const z = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const wd = z.getUTCDay() || 7; // 1=Mon..7
  if (wd !== 1) z.setUTCDate(z.getUTCDate() - (wd - 1));
  return z.toISOString().slice(0, 10);
}
function rangeForWeekISO(iso, tzOffsetMin = 0) {
  const mk = (s) => {
    const d = new Date(`${s}T00:00:00Z`);
    d.setUTCMinutes(d.getUTCMinutes() - tzOffsetMin);
    return d.toISOString();
  };
  const start = mk(iso);
  const endDate = new Date(start);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const end = endDate.toISOString();
  return { start, end };
}

const TZ_OFFSET_MIN = parseInt(process.env.SILVERWARE_TZ_OFFSET_MINUTES || "0", 10);
const FOOD_HINTS = (process.env.FOOD_CATEGORY_HINTS || "food,kitchen").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// ------- Silverware API helpers -------
async function swFetch(base, token, path, body = null) {
  const u = `${base.replace(/\/$/, "")}${path}`;
  const init = {
    method: body ? "POST" : "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(u, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return res.json();
}

// Tries POST first (common for Avrio4), falls back to GET with query params.
async function listOrders(base, token, startISO, endISO, page = 1) {
  try {
    return await swFetch(base, token, "/api/ThirdParty/GetOrders", {
      StartDate: startISO, EndDate: endISO, Page: page, PageSize: 500,
    });
  } catch {
    const qs = new URLSearchParams({
      StartDate: startISO, EndDate: endISO, Page: String(page), PageSize: "500",
    });
    return await swFetch(base, token, `/api/ThirdParty/GetOrders?${qs}`);
  }
}

async function getOrder(base, token, orderId) {
  try {
    return await swFetch(base, token, "/api/ThirdParty/GetOrder", { OrderID: orderId });
  } catch {
    const qs = new URLSearchParams({ OrderID: String(orderId) });
    return await swFetch(base, token, `/api/ThirdParty/GetOrder?${qs}`);
  }
}

// ------- flexible extractors (schema-safe) -------
const num = (v) => (typeof v === "number" ? v : (v ? Number(v) : 0)) || 0;

function orderLines(o) {
  return (
    o?.Lines ||
    o?.Items ||
    o?.OrderLines ||
    o?.OrderItems ||
    o?.CheckLines ||
    []
  );
}
function lineTotal(line) {
  return (
    num(line?.NetTotal) ||
    num(line?.LineTotal) ||
    num(line?.ExtendedPrice) ||
    num(line?.Total) ||
    num(line?.Amount)
  );
}
function lineDiscount(line) {
  return (
    num(line?.Discount) ||
    num(line?.DiscountAmount) ||
    0
  );
}
function orderHeaderDiscount(o) {
  return (
    num(o?.DiscountTotal) ||
    num(o?.PromotionsTotal) ||
    num(o?.CheckDiscountTotal) ||
    num(o?.TotalDiscount) ||
    0
  );
}
function lineCategoryName(line) {
  return String(
    line?.SalesCategoryName ||
    line?.CategoryName ||
    line?.MenuGroup ||
    line?.Family ||
    line?.Category ||
    ""
  ).toLowerCase();
}
function looksLikeFood(line) {
  const name = lineCategoryName(line);
  return FOOD_HINTS.some(h => name.includes(h));
}
function isVoided(line) {
  const s = String(line?.Status || "").toLowerCase();
  return line?.IsVoid === true || line?.Voided === true || s === "void" || s === "voided";
}

// ------- main aggregator -------
async function collectForWeek(base, token, weekISO) {
  const { start, end } = rangeForWeekISO(weekISO, TZ_OFFSET_MIN);
  let page = 1;
  let orders = 0;
  let food = 0;
  let voids = 0;
  let promos = 0;
  let more = true;

  while (more) {
    const payload = await listOrders(base, token, start, end, page);
    const rows = payload?.Orders || payload?.Data || payload || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      more = false;
      break;
    }

    for (const row of rows) {
      orders++;
      // If row lacks lines, fetch full order:
      const o = orderLines(row).length ? row : await getOrder(base, token, row?.OrderID ?? row?.Id ?? row?.ID);

      const lines = orderLines(o);
      for (const ln of lines) {
        const amt = lineTotal(ln);
        if (isVoided(ln)) {
          voids += Math.max(amt, 0);
          continue; // don't double-count as food
        }
        if (looksLikeFood(ln)) {
          food += Math.max(amt, 0);
        }
        promos += Math.max(lineDiscount(ln), 0);
      }
      // Header-level discounts/promos:
      promos += Math.max(orderHeaderDiscount(o), 0);
    }

    // simple pager guess: stop if fewer than PageSize returned
    more = rows.length >= 500;
    page++;
  }

  // Round to cents
  const round2 = (n) => Math.round(n * 100) / 100;
  return { start, end, orders, food: round2(food), voids: round2(voids), promos: round2(promos) };
}

async function writeOverrides(locKey, weekISO, totals) {
  const ref = db.doc(`companies/aidan/locations/${locKey}/overrides/${weekISO}`);
  await ref.set({
    food_sales: totals.food,
    voids: totals.voids,
    comps: totals.promos, // map promos/discounts -> comps
    source_silverware: {
      orders: totals.orders,
      days_scanned: 7,
      last_run: new Date().toISOString()
    }
  }, { merge: true });
}

async function main() {
  const weekISO = process.env.WEEK_OF || mondayISO();
  for (const [locKey, cfg] of Object.entries(LOCS)) {
    if (!cfg.base || !cfg.token) {
      console.warn(`[${locKey}] skipped — missing base/token`);
      continue;
    }
    try {
      const totals = await collectForWeek(cfg.base, cfg.token, weekISO);
      await writeOverrides(locKey, weekISO, totals);
      console.log(`[${locKey}] orders=${totals.orders} food=$${totals.food} voids=$${totals.voids} promos=$${totals.promos}`);
    } catch (e) {
      console.error(`[${locKey}] FAILED:`, e.message);
    }
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
