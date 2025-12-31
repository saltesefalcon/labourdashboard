
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
    import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteField, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
    import {
      getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
      setPersistence, browserSessionPersistence
    } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
    import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js";

    const firebaseConfig = {
      apiKey: "AIzaSyDVULptnW9wPbhH6Qn7ys8RGmLqIxUwuCI",
      authDomain: "labour-dashboard.firebaseapp.com",
      projectId: "labour-dashboard",
      storageBucket: "labour-dashboard.appspot.com",
      messagingSenderId: "174483804575",
      appId: "1:174483804575:web:84f6858e812c9705fe6daa"
    };

    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const auth = getAuth(app);
    const functions = getFunctions(app, "us-central1");
    setPersistence(auth, browserSessionPersistence).catch(()=>{});

    const ALLOWED_UIDS = new Set([
      "e0G8FBe3xlYExc3HvSGtIk5Osgw1",
          "BslFJsAMikSucxwbL8S7qPXcC6r2",
          "nW1IbxeaZJT0hAoORZhDtgOlAdd2",
          "zbpmXxrpweXQzf7Z7JMx8kUblQi1",
          "9aQ5evQ3nbYt0kjw91ruil5Igq52"
    ]);
    const ADMIN_UIDS = new Set([
      "e0G8FBe3xlYExc3HvSGtIk5Osgw1",
          "BslFJsAMikSucxwbL8S7qPXcC6r2",
          "nW1IbxeaZJT0hAoORZhDtgOlAdd2",
          "zbpmXxrpweXQzf7Z7JMx8kUblQi1",
          "9aQ5evQ3nbYt0kjw91ruil5Igq52"
    ]);

    const on = (el, type, fn) => { if (el) el.addEventListener(type, fn); };
    window.addEventListener("error", e => {
      if (authMsg) { authMsg.textContent = e.message || String(e); authMsg.style.display = ""; }
    });

    // --- DEBUG HELPERS (safe to keep) -------------------------------------------
window._dbg = {
  async readInteg(locKey, weekISO) {
    // companies/aidan/locations/{locKey}/integrations/{weekISO}
    const ref = doc(db, `companies/aidan/locations/${locKey}/integrations/${weekISO}`);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : null;
    console.log("[integ]", locKey, weekISO, data);
    return data;
  },
  async readAll(locKey, weekISO) {
    const base = (await getDoc(doc(db, `companies/aidan/locations/${locKey}/labour/${weekISO}`))).data() || null;
    const ovr  = (await getDoc(doc(db, `companies/aidan/locations/${locKey}/overrides/${weekISO}`))).data() || null;
    const integ= (await getDoc(doc(db, `companies/aidan/locations/${locKey}/integrations/${weekISO}`))).data() || null;
    console.log({ base, ovr, integ });
    return { base, ovr, integ };
  }
};
// ---------------------------------------------------------------------------


    // Elements
    const appEl = document.getElementById("app");
    const gateEl = document.getElementById("authGate");
    const deniedEl = document.getElementById("denied");
    const signinBtn = document.getElementById("signinBtn");
    const signoutBtn = document.getElementById("signoutBtn");
    const settingsBtn = document.getElementById("settingsBtn");
    const optimizerBtn = document.getElementById("optimizerToggleBtn");
    const doSignin = document.getElementById("doSignin");
    const emailEl = document.getElementById("email");
    const passEl = document.getElementById("password");
    const authMsg = document.getElementById("authMsg");
    const authStatus = document.getElementById("authStatus");
    const userAvatar = document.getElementById("userAvatar");
    const refreshBtn = document.getElementById("refreshBtn");
    const refreshMsg = document.getElementById("refreshMsg");
    const pdfBtn  = document.getElementById("pdfBtn");
    const lockWrap = document.getElementById("lockWrap");
    const lockBtn  = document.getElementById("lockBtn");
    const lockPill = document.getElementById("lockPill");
    let CUR_USER   = null;
    let   FROZEN   = false;
    const locationSel = document.getElementById("locationSel");
    const weekInput = document.getElementById("weekInput");
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");

    // Integration status
    const syncLine = document.getElementById("syncLine");
    const salesSource = document.getElementById("salesSource");
    const extrasSource = document.getElementById("extrasSource");

    // Settings modal
    const settingsModal = document.getElementById("settingsModal");
    const settingsClose = document.getElementById("settingsClose");
    const settingsSave = document.getElementById("settingsSave");
    const settingsMsg = document.getElementById("settingsMsg");
    const setRemitPct = document.getElementById("setRemitPct");
    const setTargetPct = document.getElementById("setTargetPct");
    const setPctFood = document.getElementById("setPctFood");
    const setPctWine = document.getElementById("setPctWine");
    const setPctLiquor = document.getElementById("setPctLiquor");
    const setPctBeer = document.getElementById("setPctBeer");
    const periodList = document.getElementById("periodList");
const addPeriodBtn = document.getElementById("addPeriodBtn");
const salTotalPill = document.getElementById("salTotalPill");
const showInactiveChk = document.getElementById("showInactiveChk");

    // Weekly overrides (editable here)
    const inFoodSales = document.getElementById("inFoodSales");
    const inVoids = document.getElementById("inVoids");
    const inPromos = document.getElementById("inPromos");
    const saveBtn = document.getElementById("saveOverrides");
    const saveMsg = document.getElementById("saveMsg");

    // Manual Inputs collapse/expand
const manualToggleBtn  = document.getElementById("manualToggleBtn");
const manualInputsWrap = document.getElementById("manualInputsWrap");

function setManualOpen(open){
  if (!manualInputsWrap || !manualToggleBtn) return;
  manualInputsWrap.style.display = open ? "" : "none";
  manualToggleBtn.textContent = open ? "Hide" : "Show";
  localStorage.setItem("showManualInputs", open ? "1" : "0");
}

// default closed (remember last choice)
setManualOpen(localStorage.getItem("showManualInputs") === "1");

if (manualToggleBtn){
  manualToggleBtn.addEventListener("click", () => {
    const isOpen = manualInputsWrap && manualInputsWrap.style.display !== "none";
    setManualOpen(!isOpen);
  });
}


    // Budgets & extras view
    const vwProjSales = document.getElementById("vwProjSales");
    const bdgFood = document.getElementById("bdgFood");
    const bdgWine = document.getElementById("bdgWine");
    const bdgLiquor = document.getElementById("bdgLiquor");
    const bdgBeer = document.getElementById("bdgBeer");
    const vwVoids = document.getElementById("vwVoids");
    const vwPromos = document.getElementById("vwPromos");
    const vwAutoSales = document.getElementById("vwAutoSales");
    const srcVoids = document.getElementById("srcVoids");
    const srcPromos = document.getElementById("srcPromos");
    const vwLastWeek = document.getElementById("vwLastWeek");

    // KPI refs
    const kpiProjSales = document.getElementById("kpiProjSales");
    const kpiActSales  = document.getElementById("kpiActSales");
    const kpiProjPct   = document.getElementById("kpiProjPct");
    const kpiActPct    = document.getElementById("kpiActPct");

// FOH/BOH Optimizer: Coming soon (disabled navigation for now)
const soonModal = document.getElementById("soonModal");
const soonClose = document.getElementById("soonClose");
const soonOk    = document.getElementById("soonOk");

function openSoonModal(){
  if (soonModal) soonModal.style.display = "flex";
}
function closeSoonModal(){
  if (soonModal) soonModal.style.display = "none";
}

on(soonClose, "click", closeSoonModal);
on(soonOk,    "click", closeSoonModal);
on(soonModal, "click", (e) => { if (e.target === soonModal) closeSoonModal(); });

if (optimizerBtn) {
  on(optimizerBtn, "click", openSoonModal);
}


    // Helpers
    const fmtMoney = n => (n==null? "—" : n.toLocaleString(undefined,{style:"currency",currency:"CAD",maximumFractionDigits:0}));
    const fmtInt   = n => (n==null? "—" : Math.round(n).toLocaleString());
    const fmtPct   = n => (n==null? "—" : (n*100).toFixed(1) + "%");
    function getMondayISO(d=new Date()){ const dt=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); const day=dt.getUTCDay()||7; if(day!==1) dt.setUTCDate(dt.getUTCDate()-(day-1)); return dt.toISOString().slice(0,10); }
    function shiftDays(iso,delta){ const d=new Date(iso+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0,10); }
    function todayISO(){
      const d = new Date();
      const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      return dt.toISOString().slice(0,10);
    }
    function hasSunday(days, weekISO){
      const want = shiftDays(weekISO, 6);            // Sunday of that week
      return (days||[]).some(d =>
        d?.date === want && (
          (d.actual_sales ?? 0) !== 0 || (d.actual_labor_cost ?? 0) !== 0
        )
      );
    }
    function parseISODate(iso){ return new Date(iso + "T00:00:00Z"); }
function dayDiff(aISO, bISO){ return Math.floor((parseISODate(bISO) - parseISODate(aISO))/86400000); }
function isoMin(aISO, bISO){ return (aISO <= bISO) ? aISO : bISO; }
function isoMax(aISO, bISO){ return (aISO >= bISO) ? aISO : bISO; }

// inclusive overlap (returns 0..7)
function overlapDaysInWeek(aStartISO, aEndISO, weekStartISO, weekEndISO){
  // treat null end as far future
  const aEnd = aEndISO && aEndISO !== "" ? aEndISO : "9999-12-31";
  const start = isoMax(aStartISO, weekStartISO);
  const end   = isoMin(aEnd, weekEndISO);
  const days  = dayDiff(start, end) + 1; // inclusive
  return Math.max(0, Math.min(7, days));
}

// Compute salaried dollars for (a) full week and (b) to-date in the week (cutoff)
function salaryFromPeriods(periods=[], weekISO, cutoffISO){
  if (!Array.isArray(periods) || periods.length===0) return null;
  const weekStart = weekISO;
  const weekEnd   = shiftDays(weekISO, 6);
  const cutoff    = isoMin(cutoffISO || weekEnd, weekEnd);

  let fullWeek = 0;
  let toDate   = 0;

  for (const p of periods){
    const w = Number(p?.weekly) || 0;
    const s = (p?.start || "").trim();
    if (!w || !s) continue;
    const e = (p?.end || null);

    // overlap for whole week
    const dFull = overlapDaysInWeek(s, e, weekStart, weekEnd);
    if (dFull > 0) fullWeek += w * (dFull / 7);

    // overlap up to cutoff (today or Sunday, whichever is earlier)
    const dTo   = overlapDaysInWeek(s, e, weekStart, cutoff);
    if (dTo > 0) toDate += w * (dTo / 7);
  }
  // round to cents
  const r2 = n => Math.round(n * 100) / 100;
  return { fullWeek: r2(fullWeek), toDate: r2(toDate) };
}

function salaryForDay(periods=[], dayISO){
  if (!Array.isArray(periods) || !dayISO) return 0;
  let total = 0;

  for (const p of periods){
    const w = Number(p?.weekly) || 0;
    const s = (p?.start || "").trim();
    if (!w || !s) continue;

    const e = (p?.end || "").trim();
    const endISO = e ? e : "9999-12-31";

    if (dayISO >= s && dayISO <= endISO) total += (w / 7);
  }
  return Math.round(total * 100) / 100;
}


// ----- Salaried management: period-aware helpers -----
// Data model (preferred):
// settings.mgr_salary_periods = [
//   { name: "Alice", periods: [
//       { start:"2025-01-01", weekly:1200 },                  // open-ended
//       { start:"2025-05-15", weekly:1400 },                  // raise (from this date)
//       { start:"2025-10-01", weekly:1400, end:"2025-12-31"}  // termination (closed period)
//   ]}
// ]
//
// Back-compat fallback (no periods configured):
// settings.salaried_mgrs = [{ name:"Alice", weekly:1200 }, ...]
//
const FAR_FUTURE = "9999-12-31";

function getMgrPeriods(settings){
  const advanced = Array.isArray(settings?.mgr_salary_periods) ? settings.mgr_salary_periods : null;
  if (advanced && advanced.length) return advanced;

  // fallback: map existing weekly-only list to one open-ended period
  const legacyList = Array.isArray(settings?.salaried_mgrs) ? settings.salaried_mgrs : [];
  return legacyList.map(m => ({
    name: m?.name || "",
    periods: [{ start: "1970-01-01", weekly: Number(m?.weekly)||0 }]
  }));
}

function overlapDaysInRange(startISO, endISO, rangeStartISO, rangeEndISO){
  const s = (startISO && startISO > rangeStartISO) ? startISO : rangeStartISO;
  const e = (endISO   && endISO   < rangeEndISO)   ? endISO   : rangeEndISO;
  if (e < s) return 0;
  const A = Date.parse(s+"T00:00:00Z");
  const B = Date.parse(e+"T00:00:00Z");
  return Math.floor((B - A) / 86400000) + 1; // inclusive days
}

function sumSalariedFullWeek(settings, weekISO){
  const wkStart = weekISO;
  const wkEnd   = shiftDays(weekISO, 6);
  const list = getMgrPeriods(settings);
  let total = 0;
  for (const mgr of list){
    const periods = Array.isArray(mgr?.periods) ? mgr.periods : [];
    for (const p of periods){
      const days = overlapDaysInRange(p.start, p.end || FAR_FUTURE, wkStart, wkEnd);
      if (days>0) total += (Number(p.weekly)||0) * (days/7);
    }
  }
  return total;
}

function sumSalariedToDate(settings, weekISO, cutoffISO){
  const wkStart = weekISO;
  const list = getMgrPeriods(settings);
  let total = 0;
  for (const mgr of list){
    const periods = Array.isArray(mgr?.periods) ? mgr.periods : [];
    for (const p of periods){
      const days = overlapDaysInRange(p.start, p.end || FAR_FUTURE, wkStart, cutoffISO);
      if (days>0) total += (Number(p.weekly)||0) * (days/7);
    }
  }
  return total;
}

// Legacy weekly-sum fallback (when no period table is used)
function sumLegacyWeekly(settings){
  const list = Array.isArray(settings?.salaried_mgrs) ? settings.salaried_mgrs : [];
  const sumList = list.reduce((a,m)=> a + (Number(m?.weekly)||0), 0);
  const legacy  = Number(settings?.salaried_mgmt) || 0; // old single number
  return sumList > 0 ? sumList : legacy;
}

    
    function num(v){ const n=parseFloat(v); return isNaN(n)?0:n; }
    const isNum = v => typeof v === "number" && isFinite(v);
    const pickVal = (manual, auto) => (isNum(manual) && manual > 0 ? manual : (isNum(auto) ? auto : 0));
    const pill = (el, txt, g) => { el.textContent = txt || "—"; el.classList.remove("good","bad","warn"); if (g) el.classList.add(g); };

    // Coerce anything numeric-looking to a number; return null if not finite
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// Prefer a non-zero primary; otherwise use fallback if it exists
const preferNonZero = (primary, fallback) => {
  const p = toNum(primary);
  const f = toNum(fallback);
  if (p != null && p > 0) return p;
  if (f != null) return f;
  return p ?? f ?? null;
};
    
    // % colour grading
    function gradePct(p){ if(p==null) return null; const x=p*100; if (x<=30.7) return "good"; if (x<=31.9) return "warn"; return "bad"; }
    function applyPctClass(el, p){
      el.classList.remove("pct-good","pct-warn","pct-bad");
      const g = gradePct(p);
      if (g==="good") el.classList.add("pct-good");
      else if (g==="warn") el.classList.add("pct-warn");
      else if (g==="bad") el.classList.add("pct-bad");
    }

    function getSettingsPath(locKey){ return `companies/aidan/locations/${locKey}/settings/app`; }
    async function loadSettingsFor(locKey){
      const snap = await getDoc(doc(db, getSettingsPath(locKey)));
      return snap.exists() ? snap.data() : {
        salaried_mgrs: [], salaried_mgmt: 0, remit_pct: 0,target_labour_pct: 0,
        budget_pct_food: 0, budget_pct_wine: 0, budget_pct_liquor: 0, budget_pct_beer: 0
      };
    }
    async function saveSettingsFor(locKey, data){
      await setDoc(doc(db, getSettingsPath(locKey)), data, { merge:true });
    }

    // --- currency scaling (detect cents vs dollars) ---
    function detectCurrencyScale(days = []) {
      for (const d of days) {
        const a = typeof d?.actual_sales === "number" ? d.actual_sales : null;
        const p = typeof d?.projected_sales === "number" ? d.projected_sales : null;
        if ((a != null && a >= 100000) || (p != null && p >= 100000)) return 0.01;
      }
      return 1;
    }

    // ----- lock helpers -----
function weekEndISO(weekISO){ return shiftDays(weekISO, 6); }
function isWeekComplete(weekISO){ return todayISO() > weekEndISO(weekISO); }


    function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function cutoffForWeek(weekISO){
  const today = todayISO();
  const end   = shiftDays(weekISO, 6);
  if (today < weekISO) return weekISO;   // week not started
  if (today > end)     return end;       // week finished
  return today;                          // mid-week → today
}

function isPastMonth(weekISO){
  const w = new Date(weekISO + "T00:00:00Z");
  const t = new Date();
  const wy = w.getUTCFullYear(), wm = w.getUTCMonth();
  const ty = t.getUTCFullYear(), tm = t.getUTCMonth();
  return (wy < ty) || (wy === ty && wm < tm);
}

function updateFrozenUI(frozen){
  FROZEN = !!frozen;
  if (lockPill){
    lockPill.textContent = FROZEN ? "Frozen" : "Unfrozen";
    lockPill.classList.remove("good","bad","warn");
    lockPill.classList.add(FROZEN ? "bad" : "good");
  }
  if (lockBtn){
    lockBtn.textContent = FROZEN ? "Unlock week" : "Lock week";
  }
  // when frozen, prevent mutating actions (refresh + manual overrides)
  if (refreshBtn) refreshBtn.disabled = FROZEN;
  if (saveBtn)    saveBtn.disabled    = FROZEN;
  if (inFoodSales) inFoodSales.disabled = FROZEN;
  if (inVoids)     inVoids.disabled    = FROZEN;
  if (inPromos)    inPromos.disabled   = FROZEN;
}

async function toggleLock(){
  const loc   = locationSel.value;
  const week  = weekInput.value;

  try{
    const nextFrozen = !FROZEN;

    await setDoc(
      doc(db, `companies/aidan/locations/${loc}/labour/${week}`),
      {
        frozen: nextFrozen,
        frozen_by_uid:   CUR_USER?.uid   || null,
        frozen_by_email: CUR_USER?.email || null,
        frozen_at: serverTimestamp()
      },
      { merge:true }
    );

    updateFrozenUI(nextFrozen);
    refreshMsg.textContent = nextFrozen ? "Week locked." : "Week unlocked.";
  }catch(e){
    refreshMsg.textContent = "Lock toggle failed: " + (e.message || e);
  }
}


async function maybeAutoLock(base, weekISO){
  // Auto-lock any week that’s in a past month and is complete, if not already frozen
  if (!base?.frozen && isPastMonth(weekISO) && isWeekComplete(weekISO) && IS_ADMIN){
    const loc = locationSel.value;
    try{
      await setDoc(
        doc(db, `companies/aidan/locations/${loc}/labour/${weekISO}`),
        { frozen:true, frozen_by_uid: CUR_USER?.uid || null, frozen_at: serverTimestamp() },
        { merge:true }
      );
      updateFrozenUI(true);
    }catch(_){} // best-effort
  }else{
    updateFrozenUI(!!base?.frozen);
  }
}


function daysElapsedInWeek(weekISO, cutoffISO){
  const a = Date.parse(weekISO + "T00:00:00Z");
  const b = Date.parse(cutoffISO + "T00:00:00Z");
  // inclusive count: Mon..Mon = 1, Mon..Tue = 2, … max 7
  return clamp(Math.floor((b - a) / 86400000) + 1, 1, 7);
}


    // Defaults
    weekInput.value = getMondayISO(new Date());
    locationSel.value = "beacon";
    prevBtn.onclick = () => { weekInput.value = shiftDays(weekInput.value,-7); load(); };
    nextBtn.onclick = () => { weekInput.value = shiftDays(weekInput.value,+7); load(); };
    locationSel.onchange = load;
    weekInput.onchange = load;

   async function refreshWeek(){
   if (FROZEN) {
  refreshMsg.textContent = "Week is locked (frozen). Unlock it to refresh.";
  return;
}
  const week_of = weekInput.value;
  const locKey  = locationSel.value; // beacon | tulia | prohibition | cesoir
  refreshMsg.textContent = "Dispatching update…";

  try {
    // 7shifts/weekly pulls
    const call7  = httpsCallable(functions, "dispatchFetchWeek");
    // Silverware DailyTotals pulls (use the name you deployed)
    const callSW = httpsCallable(functions, "dispatchSilverwareDailyTotals");

    await Promise.allSettled([
      call7({ week_of, include_sales:true, include_extras:true }),
      callSW({ week_of, locations:[locKey] })
    ]);

    refreshMsg.textContent = "Update started. Check again shortly.";
    setTimeout(load, 4000); // re-read once the writers finish
  } catch (e) {
    refreshMsg.textContent = "Refresh failed: " + (e.message || e);
  }
}

    refreshBtn.onclick = refreshWeek;

async function ensureFreshness(base, integ, weekISO, locKey){
  if (base?.frozen) return; // don't auto-refresh frozen weeks
  const guardKey = `autoRefresh:${locKey}:${weekISO}`;
  const lastGuard = Number(localStorage.getItem(guardKey) || 0);
  const now = Date.now();

  // Try to read an integration timestamp if present
  let lastSync = 0;
  const s = integ?.synced_at;
  if (s?.toMillis) lastSync = s.toMillis();
  else if (typeof s === "string") {
    const t = new Date(s).getTime();
    if (!isNaN(t)) lastSync = t;
  }

  const STALE_MS = 3 * 60 * 60 * 1000; // 3 hours
  const stale = !lastSync || (now - lastSync) > STALE_MS;

  // const weekEndISO = shiftDays(weekISO, 6);
  const endISO = shiftDays(weekISO, 6);
  const afterSunday = todayISO() > endISO;
  const missingSun = !hasSunday(base?.days || [], weekISO);

  // don’t spam – at most once per 30 min per loc/week
  if (((missingSun && afterSunday) || stale) && (now - lastGuard > 30 * 60 * 1000)) {
    try{
      refreshMsg.textContent = "Auto-updating…";
      const call7  = httpsCallable(functions, "dispatchFetchWeek");
      const callSW = httpsCallable(functions, "dispatchSilverwareDailyTotals");
      await Promise.allSettled([
        call7({ week_of: weekISO, include_sales:true, include_extras:true }),
        callSW({ week_of: weekISO, locations:[locKey] })
      ]);
      localStorage.setItem(guardKey, String(now));
      setTimeout(load, 4000);
    }catch(_){ /* silent */ }
  }
}


    // --- Idle sign-out (7 minutes) ---
    const IDLE_MS = 7 * 60 * 1000;
    let idleTimer = null;
    const activityEvents = ["mousemove","keydown","click","touchstart"];
    function resetIdleTimer(){ if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { signOut(auth).catch(()=>{}); }, IDLE_MS); }
    function attachIdle(){ activityEvents.forEach(ev => window.addEventListener(ev, resetIdleTimer, {passive:true})); document.addEventListener("visibilitychange", () => { if (!document.hidden) resetIdleTimer(); }); resetIdleTimer(); }
    function detachIdle(){ activityEvents.forEach(ev => window.removeEventListener(ev, resetIdleTimer)); if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }
    // NOTE: removed beforeunload sign-out so we can navigate to foh-boh.html without killing the session

    // Auth
    on(signinBtn, "click", () => {
      gateEl.scrollIntoView({behavior:"smooth",block:"center"});
      emailEl && emailEl.focus();
    });
    on(signoutBtn, "click", async () => { await signOut(auth); });
    on(doSignin, "click", async () => {
      if (!emailEl || !passEl) return;
      authMsg.style.display = "none";
      try {
        await signInWithEmailAndPassword(auth, emailEl.value.trim(), passEl.value);
        emailEl.value = ""; passEl.value = "";
      } catch (e) {
        authMsg.textContent = e.message || "Sign-in failed";
        authMsg.style.display = "";
      }
    });

    let IS_ADMIN = false;

    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        CUR_USER = null;   
        if (lockBtn) { lockBtn.style.display = "none";
        lockBtn.disabled = true; }  
        detachIdle();
        gateEl.style.display = "";          // show login card again
        authStatus.textContent = "Not signed in";
        userAvatar.hidden = true;
        signoutBtn.style.display = "none";
        signinBtn.style.display = "";
        settingsBtn.style.display = "none";
        if (optimizerBtn) optimizerBtn.style.display = "none";
        appEl.hidden = true;
        deniedEl.style.display = "none";
        if (refreshBtn) refreshBtn.disabled = true;
        if (refreshMsg) refreshMsg.textContent = "";
        if (pdfBtn) { pdfBtn.disabled = true; pdfBtn.onclick = null; }
        syncLine.textContent = "Last sync: —";
        salesSource.textContent = "—";
        extrasSource.textContent = "—";
        return;
      }

      attachIdle();

      authStatus.textContent = user.email || "Signed in";
      signoutBtn.style.display = "";
      signinBtn.style.display = "none";
      gateEl.style.display = "none";

      userAvatar.hidden = !user.photoURL;
      if (user.photoURL) userAvatar.src = user.photoURL;

      if (!ALLOWED_UIDS.has(user.uid)) {
        appEl.hidden = true;
        deniedEl.style.display = "";
        settingsBtn.style.display = "none";
        if (optimizerBtn) optimizerBtn.style.display = "none";
        if (refreshBtn) refreshBtn.disabled = true;
        if (refreshMsg) refreshMsg.textContent = "Not authorized to refresh.";
        if (pdfBtn) { pdfBtn.disabled = true; pdfBtn.onclick = null; }
        return;
      }

// user is signed in AND authorized
appEl.hidden = false;
deniedEl.style.display = "none";

// who/role
IS_ADMIN = ADMIN_UIDS.has(user.uid);
CUR_USER = { uid: user.uid, email: user.email || "", name: user.displayName || "" };

// Lock UI — everyone sees the pill; only admins see the button
if (lockWrap) lockWrap.style.display = "";
if (lockBtn) {
  lockBtn.style.display = IS_ADMIN ? "" : "none";
  lockBtn.disabled = !IS_ADMIN;
  lockBtn.onclick  = IS_ADMIN ? toggleLock : null;  // requires toggleLock()
}

// Other admin UI
settingsBtn.style.display = IS_ADMIN ? "" : "none";
if (optimizerBtn) optimizerBtn.style.display = "";

// Enable actions
if (refreshBtn) { refreshBtn.disabled = false; refreshMsg.textContent = ""; }
if (pdfBtn)      { pdfBtn.disabled = false; pdfBtn.onclick = downloadPdfAll; }

// finally render
load();



    });

// ----- Settings modal: Salaried Management (dated periods) -----
function applyPeriodVisibility(){
  const week = weekInput.value; // selected week start (Monday)
  const showAll = !!showInactiveChk?.checked;

  Array.from(periodList.children).forEach(row => {
    const ins = row.querySelectorAll("input");
    const end = (ins[3]?.value || "").trim(); // end date
    const inactive = end && end < week;       // ended before selected week
    row.style.display = (!showAll && inactive) ? "none" : "";
  });
}

function recalcSalaryTotal(){
  applyPeriodVisibility();

  const periods = Array.from(periodList.children).map(r=>{
    const ins = r.querySelectorAll("input");
    return {
      name:  (ins[0]?.value || "").trim(),
      weekly: Number(ins[1]?.value) || 0,
      start: (ins[2]?.value || "").trim(),
      end:   (ins[3]?.value || "").trim() || null
    };
  }).filter(p => p.name && p.weekly > 0 && p.start);

  const sal = salaryFromPeriods(periods, weekInput.value, shiftDays(weekInput.value, 6));
  const total = sal ? sal.fullWeek : 0;

  if (salTotalPill) salTotalPill.textContent = fmtMoney(total);
}

    settingsClose.onclick = () => settingsModal.style.display = "none";
    settingsBtn.onclick = async () => {
      const s = await loadSettingsFor(locationSel.value);

      // Render salary periods (beta)
periodList.innerHTML = "";
const ps = Array.isArray(s.mgr_salary_periods) ? s.mgr_salary_periods : [];
if (ps.length === 0) {
  periodList.appendChild(periodRowTemplate("", "", "", ""));
} else {
  ps.forEach(p => {
    periodList.appendChild(periodRowTemplate(p.name||"", p.weekly??"", p.start||"", p.end||""));
  });
}
// hook changes so the total stays live
recalcSalaryTotal();
periodList.oninput = recalcSalaryTotal;
showInactiveChk && (showInactiveChk.onchange = recalcSalaryTotal);

// when adding new rows, also refresh totals
addPeriodBtn.onclick = () => {
  periodList.appendChild(periodRowTemplate());
  recalcSalaryTotal();
};

      setRemitPct.value = s.remit_pct ?? 0;
      setPctFood.value  = s.budget_pct_food ?? 0;
      setPctWine.value  = s.budget_pct_wine ?? 0;
      setPctLiquor.value= s.budget_pct_liquor ?? 0;
      setPctBeer.value  = s.budget_pct_beer ?? 0;
      setTargetPct.value = s.target_labour_pct ?? 0;
      settingsMsg.textContent = "";
      setTargetPct.value = s.target_labour_pct ?? 0;
      settingsModal.style.display = "flex";
    };
    
    settingsSave.onclick = async () => {
      settingsMsg.textContent = "Saving…";
      try{
        const loc = locationSel.value;
        const ref = doc(db, getSettingsPath(loc));

// Build periods array from UI rows
const periods = Array.from(periodList.children).map(r => {
  const ins = r.querySelectorAll("input");
  const name  = (ins[0].value || "").trim();
  const weekly= Number(ins[1].value) || 0;
  const start = (ins[2].value || "").trim();   // YYYY-MM-DD
  const end   = (ins[3].value || "").trim();   // "" means ongoing
  return { name, weekly, start, end: end || null };
}).filter(p => p.name && p.weekly > 0 && p.start);


        // Save new settings and zero out the legacy field
        await setDoc(ref, {
          mgr_salary_periods: periods,  
          remit_pct:        num(setRemitPct.value),
          budget_pct_food:  num(setPctFood.value),
          budget_pct_wine:  num(setPctWine.value),
          budget_pct_liquor:num(setPctLiquor.value),
          budget_pct_beer:  num(setPctBeer.value),
          target_labour_pct: num(setTargetPct.value),
          salaried_mgmt: 0
        }, { merge:true });

        // Then delete the legacy field so it can’t repopulate on load
        try { await updateDoc(ref, { salaried_mgmt: deleteField(), salaried_mgrs: deleteField() }); } catch {}

        settingsMsg.textContent = "Saved ✓";
        await load();
      }catch(e){
        settingsMsg.textContent = "Save failed: " + (e.message || e);
      }
    };

    // Row for salary periods: name | weekly | start | end | 🗑
function periodRowTemplate(name="", weekly="", start="", end=""){
  const row = document.createElement("div");
  row.style.display = "grid";
  row.style.gridTemplateColumns = "1fr 120px 140px 140px 36px";
  row.style.gap = "8px";
  row.style.alignItems = "center";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <input type="text" placeholder="Manager name" value="${name||""}">
    <input type="number" step="0.01" placeholder="0.00" value="${weekly!==""?weekly:""}">
    <input type="date" value="${start||""}">
    <input type="date" value="${end||""}">
    <button title="Remove">🗑</button>
  `;
  row.querySelector("button").onclick = () => row.remove();
  return row;
}
// --- Helpers for robust food-only extraction ---
function normalizeCurrency(n){
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v >= 100000 ? v * 0.01 : v; // treat very large values as cents
};

function moneyMaybe(v){
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return (n >= 100000) ? n * 0.01 : n; // cents→dollars safety
}

function getAutoVoidsOnly(integ){
  integ = integ || {};

  // 1) Prefer explicit “voids only” fields if we add them in the writer later
  const explicit =
    moneyMaybe(integ.voids_only) ??
    moneyMaybe(integ.voidsOnly) ??
    moneyMaybe(integ.voids_total) ??
    moneyMaybe(integ.voidsTotal);

  if (explicit != null) {
    return { value: explicit, label: "Auto: Silverware (Voids)" };
  }

  // 2) Otherwise: subtract cancellations if both exist
  const rawVoids =
    moneyMaybe(integ.voids_silverware) ??
    moneyMaybe(integ.voids);

  const canc =
    moneyMaybe(integ.cancellations_silverware) ??
    moneyMaybe(integ.cancellations) ??
    moneyMaybe(integ.cancellations_total) ??
    moneyMaybe(integ.cancellationsTotal);

  if (rawVoids != null && canc != null) {
    return { value: Math.max(0, rawVoids - canc), label: "Auto: Silverware (Voids only)" };
  }

  // 3) fallback
  if (rawVoids != null) {
    return { value: rawVoids, label: "Auto: Silverware (Voids)" };
  }

  return { value: null, label: "—" };
}


// Deeply scan ANY Silverware DailyTotals blob and SUM all FOOD NetAmount
function deepSumFoodNet(root){
  if (!root || typeof root !== "object") return 0;
  const seen = new Set();
  let sum = 0;

  const push = (v) => { if (v && typeof v === "object") stack.push(v); };
  const stack = [root];

  while (stack.length){
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    // Case A: explicit FOOD category objects (Name or InterfaceID)
    const name = cur?.Name ?? cur?.name;
    const id   = cur?.InterfaceID ?? cur?.interfaceID ?? cur?.interfaceId;
    const isFoodRow = (typeof name === "string" && name.toUpperCase() === "FOOD") || String(id||"") === "5000";
    if (isFoodRow){
      const net = toNum(cur?.NetAmount ?? cur?.netAmount ?? cur?.net ?? cur?.Net);
      if (net) sum += net;
    }

    // Case B: “categories” style objects: { food: { net: ... } } or { FOOD: number }
    const cat = cur?.food ?? cur?.FOOD;
    if (cat != null){
      const net = toNum(
        (typeof cat === "object")
          ? (cat?.net ?? cat?.Net ?? cat?.netAmount ?? cat?.NetAmount)
          : cat
      );
      if (net) sum += net;
    }

    // Recurse
    if (Array.isArray(cur)){
      for (const v of cur) push(v);
    } else {
      for (const v of Object.values(cur)) push(v);
    }
  }
  return normalizeCurrency(sum);
}
const asNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Returns FOOD-only weekly sales if found; otherwise falls back to daySum
function getAutoFoodSales(integ, daySum){
  // 1) explicit fields writers might set
  const direct =
    toNum(integ?.food_sales_total) ?? 
    toNum(integ?.net_food_sales_silverware) ??
    toNum(integ?.food_net_sales) ??
    toNum(integ?.food_sales) ??
    toNum(integ?.food);
  if (direct && direct > 0) return { value: normalizeCurrency(direct), label: "Auto: Silverware DailyTotals (Food)" };

  // 2) deep scan of any Sales/Categories blobs for FOOD=5000
  const deep = deepSumFoodNet(integ);
  if (deep && deep > 0) return { value: deep, label: "Auto: Silverware DailyTotals (Food)" };

  // 3) fallback so the UI never blanks
  return { value: daySum, label: "Days (fallback)" };
}



function effSalesFrom(base, ovr, integ){
  const days = base?.days ?? [];
  const SCALE = detectCurrencyScale(days);
  const daySum = days.reduce((a,d)=> a + ((d.actual_sales ?? 0) * SCALE), 0);

  if (isNum(ovr?.food_sales) && ovr.food_sales > 0) {
    return Number(ovr.food_sales);
  }
  // Prefer food-only from integrations; fallback to daySum
  return getAutoFoodSales(integ || {}, daySum).value;
}


    // -------------- LOAD + RENDER (safe integrations read + prev week) --------------
    async function load(){
      saveMsg.textContent = "";
      const weekISO = weekInput.value;
      const locKey = locationSel.value;

      const basePath = `companies/aidan/locations/${locKey}/labour/${weekISO}`;
      const ovrPath  = `companies/aidan/locations/${locKey}/overrides/${weekISO}`;
      const integPath= `companies/aidan/locations/${locKey}/integrations/${weekISO}`;

      const [baseSnap, ovrSnap, settings] = await Promise.all([
        getDoc(doc(db, basePath)),
        getDoc(doc(db, ovrPath)),
        loadSettingsFor(locKey)
      ]);

      let integ = null;
      try { const s = await getDoc(doc(db, integPath)); integ = s.exists() ? s.data() : null; } catch(_) {}

      const base = baseSnap.exists()? baseSnap.data(): null;
      const ovr  = ovrSnap.exists()? ovrSnap.data(): {};

      // IMPORTANT: lock is per-week — reset UI based on THIS week doc
updateFrozenUI(!!base?.frozen);

      // also fetch PREVIOUS week for "Last Week Sales"
      const prevISO = shiftDays(weekISO, -7);
      const [pBaseSnap, pOvrSnap] = await Promise.all([
        getDoc(doc(db, `companies/aidan/locations/${locKey}/labour/${prevISO}`)),
        getDoc(doc(db, `companies/aidan/locations/${locKey}/overrides/${prevISO}`))
      ]);
      let pInteg = null;
      try { const s = await getDoc(doc(db, `companies/aidan/locations/${locKey}/integrations/${prevISO}`)); pInteg = s.exists() ? s.data() : null; } catch(_) {}

      const lastWeekSales = (pBaseSnap.exists() ? effSalesFrom(pBaseSnap.data(), pOvrSnap.exists()?pOvrSnap.data():null, pInteg) : null);

      // fill inputs
      inFoodSales.value = ovr.food_sales ?? "";
      inVoids.value     = ovr.voids ?? "";
      inPromos.value    = ovr.promos ?? "";

      render(base, ovr, settings, integ, weekISO, lastWeekSales);
      ensureFreshness(base, integ, weekISO, locKey);

      saveBtn.onclick = async () => {
        const newOvr = {
          food_sales: num(inFoodSales.value),
          voids: num(inVoids.value),
          promos: num(inPromos.value)
        };
        try{
          await setDoc(doc(db, ovrPath), newOvr, { merge:true });
          saveMsg.textContent = "Saved ✓";
          render(base, newOvr, settings, integ, weekISO, lastWeekSales);
        }catch(e){
          saveMsg.textContent = "Save failed: " + (e.message || e);
        }
      };
    }

   function render(data, ovr={}, settings={}, integ=null, weekISO, lastWeekSales){
  // effective target %
  const weekTarget  = (typeof data?.target_labour_pct === "number") ? data.target_labour_pct : null;
  const fallbackTgt = (typeof settings?.target_labour_pct === "number" && settings.target_labour_pct > 0)
    ? settings.target_labour_pct : null;
  const effTarget   = (weekTarget != null ? weekTarget : fallbackTgt);
  document.getElementById("targetPill").textContent = (effTarget != null) ? fmtPct(effTarget) : "—";

  // days + scale
  const days  = data?.days ?? [];
  const SCALE = detectCurrencyScale(days);

  // table totals (raw)
  const t = { projSales:0, actSalesDays:0, projLab:0, actLab:0, projMin:0, actMin:0 };

const tbody = document.querySelector("#dailyTable tbody");

// IMPORTANT: these must be declared ONCE in render()
const weekCutoffISO = cutoffForWeek(weekISO);
const weekEndISO_   = shiftDays(weekISO, 6); // <-- ADD this (you reference weekEndISO_ later)
const remitPct      = Number(settings.remit_pct) || 0;

tbody.innerHTML = "";

for (const d of days){
  const ps = (d.projected_sales ?? 0)      * SCALE;
  const as = (d.actual_sales ?? 0)         * SCALE;
  const pl = (d.projected_labor_cost ?? 0) * SCALE;

  // Hourly labour from 7shifts
  const alHourly = (d.actual_labor_cost ?? 0) * SCALE;

  // Daily salaried portion (weekly/7), only up to cutoff day
  const dayISO = d.date || "";
  const salDay = (dayISO && dayISO <= weekCutoffISO)
    ? salaryForDay(settings?.mgr_salary_periods || [], dayISO)
    : 0;

  // Daily gross labour incl salary, then remittance
  const grossLabDay = alHourly + salDay;
  const adjLabDay   = grossLabDay + (remitPct * grossLabDay);

  // accumulate totals (keep actLab = hourly only; salary is added later via salariedToDate)
  t.projSales    += ps;
  t.actSalesDays += as;
  t.projLab      += pl;
  t.actLab       += alHourly;
  t.projMin      += d.projected_labor_minutes ?? 0;
  t.actMin       += d.actual_labor_minutes ?? 0;

  const pct   = (adjLabDay && as) ? (adjLabDay / as) : null;
  const delta = (pct!=null && effTarget!=null) ? (pct - effTarget) : null;

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${d.date || "—"}</td>
    <td>${fmtMoney(ps)}</td>
    <td>${fmtMoney(as)}</td>
    <td>${fmtMoney(pl)}</td>
    <td>${fmtMoney(adjLabDay)}</td>
    <td>${fmtInt(d.projected_labor_minutes)}</td>
    <td>${fmtInt(d.actual_labor_minutes)}</td>
    <td>${fmtPct(pct)}</td>
    <td><span class="pill ${delta!=null?(delta<=0?"good":"bad"):""}">${delta!=null? (delta*100).toFixed(1)+" pp":"—"}</span></td>
  `;
  tbody.appendChild(tr);
}


// Food-only for the right panel — totals/KPIs still use TOTAL sales
const totalActSales = t.actSalesDays; // keep TOTAL for KPIs/table

// Prefer the explicit food-only values written by Silverware DailyTotals writers.
// Fall back to deep scan, then finally to total days sum (so UI never blanks).
const autoFoodDirect =
  toNum(integ?.food_sales_total) ??
  toNum(integ?.food_sales_silverware);

const autoFood =
  (autoFoodDirect != null && autoFoodDirect > 0)
    ? normalizeCurrency(autoFoodDirect)
    : (deepSumFoodNet(integ || {}) || totalActSales);


  let salariedToDate = 0;
  let salariedWeekFull = 0;
  const sal = salaryFromPeriods(settings?.mgr_salary_periods, weekISO, weekCutoffISO);
  if (sal) {
    salariedToDate  = sal.toDate;
    salariedWeekFull= sal.fullWeek;
  } else {
    const legacyWeekly = sumLegacyWeekly(settings);
    const elapsedDays  = daysElapsedInWeek(weekISO, weekCutoffISO);
    const weekComplete = (weekCutoffISO === weekEndISO_);
    salariedToDate     = legacyWeekly * (weekComplete ? 1 : (elapsedDays / 7));
    salariedWeekFull   = legacyWeekly;
  }

  const grossLabourToDate = (t.actLab || 0) + salariedToDate;
  const remit             = (Number(settings.remit_pct) || 0) * grossLabourToDate;
  const adjustedActLab    = grossLabourToDate + remit;

  const weekPct   = totalActSales > 0 ? (adjustedActLab / totalActSales) : null;
  const weekDelta = (weekPct!=null && effTarget!=null) ? (weekPct - effTarget) : null;

  // ----- Totals & KPIs -----
  document.getElementById("tProjSales").textContent  = fmtMoney(t.projSales);
  document.getElementById("tActSales").textContent   = fmtMoney(totalActSales);
  document.getElementById("tProjLabour").textContent = fmtMoney(t.projLab);
  document.getElementById("tActLabour").textContent  = fmtMoney(adjustedActLab);

  const tPctEl = document.getElementById("tLabourPct");
  tPctEl.textContent = fmtPct(weekPct);
  applyPctClass(tPctEl, weekPct);

  document.getElementById("tProjMin").textContent = fmtInt(t.projMin);
  document.getElementById("tActMin").textContent  = fmtInt(t.actMin);
  document.getElementById("tDelta").innerHTML     =
    `<span class="pill ${weekDelta!=null?(weekDelta<=0?"good":"bad"):""}">${weekDelta!=null? (weekDelta*100).toFixed(1)+" pp":"—"}</span>`;

  if (kpiProjSales) kpiProjSales.textContent = fmtMoney(t.projSales);
  if (kpiActSales)  kpiActSales.textContent  = fmtMoney(totalActSales);
  const projPct = (t.projLab && t.projSales) ? (t.projLab / t.projSales) : null;
  if (kpiProjPct)  kpiProjPct.textContent = fmtPct(projPct);
  if (kpiActPct)   { kpiActPct.textContent = fmtPct(weekPct); applyPctClass(kpiActPct, weekPct); }

  // ----- Integration status & sources + extras view -----
  const syncAt = integ?.synced_at;
  let syncTxt = "—";
  if (syncAt?.toDate)      syncTxt = integ.synced_at.toDate().toLocaleString();
  else if (typeof syncAt==="string"){ const dt=new Date(syncAt); syncTxt = isNaN(dt)? syncAt : dt.toLocaleString(); }
  syncLine.textContent = "Last sync: " + (syncTxt || "—");

// Totals are from day documents; food-only is shown separately below
salesSource.textContent = "Days (totals) • Food via Silverware";


// Extras (manual > integration) — Voids ONLY (exclude cancellations)
const voidsAuto = getAutoVoidsOnly(integ || {});
const autoVoids = voidsAuto.value;
  const autoPromos = isNum(integ?.promos_silverware) ? integ.promos_silverware : (isNum(integ?.promos) ? integ.promos : null);
  const effVoids   = pickVal(Number(ovr.voids),  autoVoids);
  const effPromos  = pickVal(Number(ovr.promos), autoPromos);

  if (vwAutoSales) vwAutoSales.textContent = fmtMoney(autoFood);
  if (vwVoids)     vwVoids.textContent     = fmtMoney(effVoids);
  if (vwPromos)    vwPromos.textContent    = fmtMoney(effPromos);

pill(srcVoids,
  (isNum(ovr.voids) && ovr.voids > 0) ? "Manual"
    : voidsAuto.label,
  (isNum(ovr.voids) && ovr.voids > 0) ? "bad" : null
);
  pill(srcPromos,
       (isNum(ovr.promos) && ovr.promos > 0) ? "Manual"
         : (integ?.source_extras ? `Auto: ${integ.source_extras}` : "—"));

  if (extrasSource) {
  const manualExtras = (isNum(ovr.voids) && ovr.voids > 0) || (isNum(ovr.promos) && ovr.promos > 0);
  extrasSource.textContent = manualExtras
    ? "Manual override"
    : (integ?.source_extras ? `Auto: ${integ.source_extras}` : "—");
}
  
  // Last week (auto) & budgets
  if (vwLastWeek)   vwLastWeek.textContent  = fmtMoney(isNum(lastWeekSales)? lastWeekSales : null);
  if (vwProjSales)  vwProjSales.textContent = fmtMoney(t.projSales);

  const pFood   = Number(settings.budget_pct_food)||0;
  const pWine   = Number(settings.budget_pct_wine)||0;
  const pLiquor = Number(settings.budget_pct_liquor)||0;
  const pBeer   = Number(settings.budget_pct_beer)||0;

  const bdg = (pct)=> t.projSales * pct;
  bdgFood.textContent   = fmtMoney(bdg(pFood));
  bdgWine.textContent   = fmtMoney(bdg(pWine));
  bdgLiquor.textContent = fmtMoney(bdg(pLiquor));
  bdgBeer.textContent   = fmtMoney(bdg(pBeer));
}

    // ---------------------- PDF GENERATOR ----------------------
    const LOC_LABEL = { beacon:"BEACON", tulia:"TULIA", cesoir:"CE SOIR", prohibition:"PROHIBITION" };
    const LOC_ORDER = ["beacon","tulia","cesoir","prohibition"];

    function pctClass(p){ const g=gradePct(p); return g? g : ""; }

    async function readWeekForLocation(locKey, weekISO){
      const basePath = `companies/aidan/locations/${locKey}/labour/${weekISO}`;
      const ovrPath  = `companies/aidan/locations/${locKey}/overrides/${weekISO}`;
      const integPath = `companies/aidan/locations/${locKey}/integrations/${weekISO}`; 
      const settings = await loadSettingsFor(locKey);

const [baseSnap, ovrSnap, integSnap] = await Promise.all([
  getDoc(doc(db, basePath)),
  getDoc(doc(db, ovrPath)),
  getDoc(doc(db, integPath)),
]);
const base = baseSnap.exists()? baseSnap.data(): null;
const ovr  = ovrSnap.exists()? ovrSnap.data(): {};
const integ= integSnap.exists()? integSnap.data(): null;

      const days = base?.days || [];
      const SCALE = detectCurrencyScale(days);

      let projSales=0, actSalesDays=0, projLab=0, actLab=0, projMin=0, actMin=0;
      for (const d of days){
        projSales += (d.projected_sales ?? 0)       * SCALE;
        actSalesDays  += (d.actual_sales ?? 0)      * SCALE;
        projLab   += (d.projected_labor_cost ?? 0)  * SCALE;
        actLab    += (d.actual_labor_cost ?? 0)     * SCALE;
        projMin   += d.projected_labor_minutes ?? 0;
        actMin    += d.actual_labor_minutes ?? 0;
      }

// PDF stays on TOTAL sales (not food-only)
const totalActSales = actSalesDays;

    
let salaried = 0;
const salPdf = salaryFromPeriods(settings?.mgr_salary_periods, weekISO, shiftDays(weekISO, 6));
if (salPdf) salaried = salPdf.fullWeek;
else        salaried = sumLegacyWeekly(settings);


const grossLabour  = (actLab || 0) + salaried;

      const remit        = (Number(settings.remit_pct)||0) * grossLabour;
      const adjActLab    = grossLabour + remit;

      const target = isNum(base?.target_labour_pct)
  ? base.target_labour_pct
  : (isNum(settings?.target_labour_pct) ? Number(settings.target_labour_pct) : null);

      const projPct = (projLab && projSales) ? projLab/projSales : null;
      const actPct  = (adjActLab && totalActSales) ? adjActLab/totalActSales : null;
      const delta   = (actPct!=null && target!=null) ? (actPct-target) : null;

      const budgets = {
        food:   projSales * (Number(settings.budget_pct_food)||0),
        wine:   projSales * (Number(settings.budget_pct_wine)||0),
        liquor: projSales * (Number(settings.budget_pct_liquor)||0),
        beer:   projSales * (Number(settings.budget_pct_beer)||0),
      };

      // compute previous week for PDF "Last Week Sales"
      const prevISO = shiftDays(weekISO, -7);
      const [pBaseSnap, pOvrSnap] = await Promise.all([
        getDoc(doc(db, `companies/aidan/locations/${locKey}/labour/${prevISO}`)),
        getDoc(doc(db, `companies/aidan/locations/${locKey}/overrides/${prevISO}`))
      ]);
let lastWeek = null;
if (pBaseSnap.exists()){
  const prevBase = pBaseSnap.data();
  const pDays  = prevBase?.days || [];
  const pScale = detectCurrencyScale(pDays);
  lastWeek = pDays.reduce((a,d)=> a + ((d.actual_sales ?? 0) * pScale), 0); // TOTAL
}


      return {
        locKey,
        target,
        projSales, actSales: totalActSales,
        projLab,   actLab: adjActLab,
        projMin,   actMin,
        projPct,   actPct, delta,
        lastWeek,
        promos: Number(ovr.promos)||0,
        voids: Number(ovr.voids)||0,
        budgets
      };
    }

    function sectionHtml(s, weekISO){
      const fmtMoneyLocal = (n)=> (n==null? "—" : n.toLocaleString(undefined,{style:"currency",currency:"CAD",maximumFractionDigits:0}));
      const fmtIntLocal   = (n)=> (n==null? "—" : Math.round(n).toLocaleString());
      const fmtPctLocal   = (n)=> (n==null? "—" : (n*100).toFixed(1) + "%");
      return `
        <section class="loc">
          <div class="loc-hdr">
            <div class="loc-name">${(LOC_LABEL[s.locKey] || s.locKey.toUpperCase())}</div>
            <div class="loc-week">Week of ${weekISO}</div>
          </div>

          <div class="kpis">
            <div class="k"><div class="k-h">Projected Sales</div><div class="k-v">${fmtMoneyLocal(s.projSales)}</div></div>
            <div class="k"><div class="k-h">Actual Sales</div><div class="k-v">${fmtMoneyLocal(s.actSales)}</div></div>
            <div class="k"><div class="k-h">Projected Labour %</div><div class="k-v">${fmtPctLocal(s.projPct)}</div></div>
            <div class="k ${pctClass(s.actPct)}"><div class="k-h">Actual Labour %</div><div class="k-v">${fmtPctLocal(s.actPct)}</div></div>
          </div>

          <table class="mini">
            <tbody>
              <tr><th>Total Proj Labour $</th><td>${fmtMoneyLocal(s.projLab)}</td><th>Total Act Labour $</th><td>${fmtMoneyLocal(s.actLab)}</td></tr>
              <tr><th>Target Labour %</th><td>${fmtPctLocal(s.target)}</td><th>Δ vs Target</th><td>${s.delta==null?"—":(s.delta*100).toFixed(1)+" pp"}</td></tr>
              <tr><th>Proj Min</th><td>${fmtIntLocal(s.projMin)}</td><th>Act Min</th><td>${fmtIntLocal(s.actMin)}</td></tr>
            </tbody>
          </table>

          <div class="two-col">
            <table class="mini">
              <thead><tr><th colspan="2">Last Week & Extras</th></tr></thead>
              <tbody>
                <tr><th>Last Week Sales</th><td>${fmtMoneyLocal(s.lastWeek)}</td></tr>
                <tr><th>Promos/Discounts</th><td>${fmtMoneyLocal(s.promos)}</td></tr>
                <tr><th>Voids</th><td>${fmtMoneyLocal(s.voids)}</td></tr>
              </tbody>
            </table>

            <table class="mini">
              <thead><tr><th colspan="2">Purchasing Budgets</th></tr></thead>
              <tbody>
                <tr><th>Food</th><td>${fmtMoneyLocal(s.budgets.food)}</td></tr>
                <tr><th>Wine</th><td>${fmtMoneyLocal(s.budgets.wine)}</td></tr>
                <tr><th>Liquor</th><td>${fmtMoneyLocal(s.budgets.liquor)}</td></tr>
                <tr><th>Beer</th><td>${fmtMoneyLocal(s.budgets.beer)}</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    async function downloadPdfAll(){
      const weekISO = weekInput.value;
      const results = await Promise.all(LOC_ORDER.map(loc => readWeekForLocation(loc, weekISO)));
      const sections = results.map(r => sectionHtml(r, weekISO)).join("");

      const w = window.open("", "_blank");
      w.document.write(`<!doctype html><html><head><meta charset="utf-8">
        <title>Labour Dashboard — ${weekISO}</title>
        <style>
          @media print { @page { size: Letter; margin: 14mm; } }
          body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial;margin:0;color:#111}
          .wrap{max-width:980px;margin:24px auto;padding:0 16px}
          .title{font-weight:700;font-size:20px;margin:8px 0 16px}
          .loc{page-break-inside:avoid;border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:0 0 16px}
          .loc-hdr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
          .loc-name{font-weight:700;font-size:18px}
          .loc-week{color:#6b7280;font-size:12px}
          .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0 6px}
          .k{border:1px solid #e5e7eb;border-radius:10px;padding:10px}
          .k-h{font-size:12px;color:#6b7280;margin-bottom:4px}
          .k-v{font-size:16px;font-weight:600}
          .k.good .k-v{color:#16a34a}
          .k.warn .k-v{color:#f59e0b}
          .k.bad .k-v{color:#dc2626}
          .mini{width:100%;border-collapse:collapse;margin-top:6px}
          .mini th,.mini td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:right}
          .mini th:first-child,.mini td:first-child{text-align:left}
          .two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
          @media (max-width:800px){ .kpis{grid-template-columns:repeat(2,1fr)} .two-col{grid-template-columns:1fr} }
        </style>
      </head><body><div class="wrap">
        <div class="title">Labour Dashboard — Week of ${weekISO}</div>
        ${sections}
      </div></body></html>`);
      w.document.close();
      w.focus();
      w.print();
    } // end downloadPdfAll
    // -------------------- end PDF GENERATOR --------------------
  