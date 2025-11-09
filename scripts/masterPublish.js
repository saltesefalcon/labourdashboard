// scripts/masterPublish.js
// Minimal helpers to publish weekly Labour KPIs to the Master Dashboard.
// Uses Firestore v9 modular CDN imports. No build step needed.

import {
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// Monday of the week as YYYY-MM-DD (local time)
export function mondayISO(d = new Date()) {
  const day = d.getDay(); // 0..6, Sun=0
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const da = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

/**
 * Publish weekly labour KPIs.
 * @param {import('https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js').Firestore} db
 * @param {{
 *   weekISO: string,
 *   storeId: string, // 'prohibition' | 'tulia' | 'beacon' | 'cesoir'
 *   projectedSales: number,
 *   actualSales: number,
 *   projectedLabourPct: number,
 *   actualLabourPct: number
 * }} p
 */
export async function publishLabourKpis(db, p) {
  const ref = doc(db, "masterDashboard", p.weekISO, "stores", p.storeId);
  await setDoc(
    ref,
    {
      storeId: p.storeId,
      weekISO: p.weekISO,
      labour: {
        projectedSales: p.projectedSales,
        actualSales: p.actualSales,
        projectedLabourPct: p.projectedLabourPct,
        actualLabourPct: p.actualLabourPct,
        updatedAt: serverTimestamp(),
      },
      _lastPublisher: "labour",
      _updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}
