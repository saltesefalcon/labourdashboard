// Usage:
//   WEEK_OF=2025-10-27 node scripts/fetch_silverware_getorders.mjs
//
// Required env:
//   FIREBASE_SERVICE_ACCOUNT_JSON
//   SILVERWARE_BASE_BEACON          // e.g. https://avrio.../Avrio4/<tenant>
//   SILVERWARE_TOKEN_BEACON         // JWT; "Bearer " prefix not required
//
// Optional:
//   FOOD_CATEGORY_HINTS="Food,Kitchen"
//   SILVERWARE_TZ_OFFSET_MINUTES="-240"

import admin from "firebase-admin";

// ---------- config ----------
const WEEK_OF = process.env.WEEK_OF;
if (!WEEK_OF) { console.error("WEEK_OF (YYYY-MM-DD Monday) is required."); process.exit(1); }

const BASE  = (process.env.SILVERWARE_BASE_BEACON || "").replace(/\/+$/,"");
const TOKEN = (process.env.SILVERWARE_TOKEN_BEACON || "");
if (!BASE || !TOKEN) { console.error("SILVERWARE_BASE_BEACON and SILVERWARE_TOKEN_BEACON are required."); process.exit(1); }

const FOOD_HINTS = (process.env.FOOD_CATEGORY_HINTS || "Food,Kitchen")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const TZ_OFFSET_MIN = Number(process.env.SILVERWARE_TZ_OFFSET_MINUTES || "-240");

// ---------- firebase ----------
const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(SA) });
const db = admin.firestore();

// ---------- helpers ----------
function isoAddDays(iso, d){ const t=new Date(iso+"T00:00:00Z"); t.setUTCDate(t.getUTCDate()+d); return t.toISOString().slice(0,10); }
const FROM = WEEK_OF;
const TO   = isoAddDays(WEEK_OF, 6);
const bearer = t => (t.startsWith("Bearer ") ? t : `Bearer ${t}`);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp = v => (v < 0.0001 ? 0 : v);

// API call
async function swGetOrders(){
  const url = `${BASE}/api/ThirdParty/GetOrders`;
  const body = { BusinessDateFrom: FROM, BusinessDateTo: TO };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization": bearer(TOKEN) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GetOrders ${res.status}: ${text.slice(0,300)}`);
  }
  const json = await res.json();
  return Array.isArray(json) ? json : (json?.data ?? json?.orders ?? []);
}

// classification helpers
const isVoidLine = it =>
  !!(it?.IsVoided || it?.isVoided || it?.Voided || it?.Status === "Voided" || (num(it?.VoidedQty) > 0));
const isTaxOrService = it => {
  const t = (it?.Type || it?.LineType || "").toString().toLowerCase();
  const n = (it?.Name || it?.Description || "").toString().toLowerCase();
  return t.includes("tax") || t.includes("gratuity") || t.includes("service") || n.includes("tax") || n.includes("hst");
};
const grossOf = it => num(it?.NetAmount ?? it?.Total ?? it?.ExtendedPrice ?? it?.ExtPrice ?? it?.Price ?? it?.Amount);
const itemDiscountOf = it => num(it?.Discount ?? it?.DiscountAmount ?? it?.ItemDiscount ?? it?.LineDiscount ?? 0);
const catName = it => (it?.CategoryName || it?.Category || it?.DepartmentName || "").toString().toLowerCase();
const isFood = it => FOOD_HINTS.some(h => catName(it).includes(h));

// pro-rate order-level discounts across non-void, non-tax lines
function distributeOrderDiscount(totalOrderDisc, items){
  const elig = items.filter(i => !isVoidLine(i) && !isTaxOrService(i));
  const base = elig.reduce((a,i)=> a + grossOf(i), 0);
  const shares = new Map();
  if (base <= 0 || totalOrderDisc <= 0) return shares;
  for (const i of elig) shares.set(i, totalOrderDisc * (grossOf(i) / base));
  return shares;
}

function rollupOrders(orders){
  let foodNet = 0, promos = 0, voids = 0;

  for (const ord of orders){
    const lines = ord?.Items || ord?.items || ord?.Lines || ord?.lines || [];
    const orderDisc = num(
      ord?.OrderDiscountTotal ?? ord?.DiscountTotal ?? ord?.DiscountsTotal ?? ord?.TotalDiscounts ?? ord?.OrderDiscounts
    );
    const share = distributeOrderDiscount(orderDisc, lines);

    for (const it of lines){
      if (isTaxOrService(it)) continue;

      const gross = grossOf(it);
      const itemDisc = itemDiscountOf(it);
      const prorate  = share.get(it) || 0;

      if (isVoidLine(it)) { voids += Math.max(0, gross); continue; }

      promos += Math.max(0, itemDisc) + Math.max(0, prorate);
      if (isFood(it)) foodNet += Math.max(0, gross) - Math.max(0, itemDisc) - Math.max(0, prorate);
    }
  }

  return {
    food_sales_total: clamp(Math.round(foodNet)),
    promos_silverware: clamp(Math.round(promos)),
    voids_silverware: clamp(Math.round(voids)),
  };
}

async function run(){
  console.log(`[beacon] GetOrders ${FROM}..${TO}`);
  const orders = await swGetOrders();
  const roll = rollupOrders(orders);
  console.log(`[beacon] food_net=${roll.food_sales_total} promos=${roll.promos_silverware} voids=${roll.voids_silverware}`);

  const ref = db.doc(`companies/aidan/locations/beacon/integrations/${WEEK_OF}`);
// IMPORTANT: Do NOT overwrite DailyTotals integration fields.
// Store Orders-derived values under non-colliding keys.
const {
  food_sales_total,
  promos_silverware,
  voids_silverware,
  ...rest
} = roll;

await ref.set({
  ...rest,

  // renamed to avoid collisions with DailyTotals
  orders_food_sales_total: food_sales_total,
  orders_promos: promos_silverware,
  orders_voids: voids_silverware,

  tz_offset_min: TZ_OFFSET_MIN,
  synced_at_orders: admin.firestore.FieldValue.serverTimestamp(),
  source_orders: "Silverware (Orders)",

  orders_sample: Array.isArray(orders) ? (orders[0] ?? null) : null
}, { merge:true });


  console.log("Done.");
}

run().catch(async (e) => {
  console.error("ERROR:", e?.message || e);
  // Helpful hint if permissions are wrong
  if (String(e).includes("401")) {
    console.error("Token likely lacks permission for ThirdParty/GetOrders. Ask Silverware to enable ThirdParty Orders API for this app/token.");
  }
  const ref = db.doc(`companies/aidan/locations/beacon/integrations/${WEEK_OF}`);
await ref.set({
  source_orders: "Silverware (Orders)",
  last_error_orders: (e?.message || String(e)).slice(0, 500),
  synced_at_orders: admin.firestore.FieldValue.serverTimestamp(),
}, { merge:true });

  process.exit(1);
});
