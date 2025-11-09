const admin = require('firebase-admin');

function parseSA() {
  const raw = process.env.FIREBASE_SA_JSON;
  if (!raw) throw new Error('FIREBASE_SA_JSON missing');
  return JSON.parse(raw);
}
function mondayISO(d=new Date()){
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7; if (day !== 1) dt.setUTCDate(dt.getUTCDate() - (day - 1));
  return dt.toISOString().slice(0,10);
}

(async () => {
  const svc = parseSA();
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  const db = admin.firestore();

  const weekISO = process.env.WEEK_OF || mondayISO();
  const storeId = process.env.APP_KEY || 'prohibition';

  const ref = db.doc(`masterDashboard/${weekISO}/stores/${storeId}`);
  await ref.set({
    storeId, weekISO,
    labour: {
      projectedSales: 11111,
      actualSales: 22222,
      projectedLabourPct: 11.1,
      actualLabourPct: 22.2,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    _lastPublisher: 'test_writer',
    _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log('Wrote test KPIs to', ref.path);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
