// scripts/write_payroll_schedule_snapshot.mjs
// Usage example:
//   node scripts/write_payroll_schedule_snapshot.mjs --loc beacon --week 2026-01-05 --in .\\_7shifts_shifts_249636_2026-01-05.json --cred .\\serviceAccountKey.json

import fs from "fs";
import path from "path";
import admin from "firebase-admin";

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

const inFile = arg("in");
const loc = arg("loc", "beacon");
const week = arg("week");
const company = arg("company", "aidan");
const credPath = arg("cred"); // optional: service account json

if (!inFile || !week) {
  console.error("Missing args. Required: --in <jsonFile> --week <YYYY-MM-DD>");
  process.exit(1);
}

// ---------- Firebase Admin init ----------
function initAdmin() {
  if (admin.apps.length) return;

  if (credPath) {
    const abs = path.resolve(credPath);
    const serviceAccount = JSON.parse(fs.readFileSync(abs, "utf8"));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return;
  }

  // Fallback: Application Default Credentials (ADC)
  // Works if GOOGLE_APPLICATION_CREDENTIALS is set OR you’re in an environment with ADC.
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

initAdmin();
const db = admin.firestore();

// ---------- helpers ----------
function norm(s) {
  return String(s || "").trim();
}
function normLower(s) {
  return norm(s).toLowerCase();
}
function splitName(full) {
  const parts = norm(full).split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

// Try to locate the shifts array in common 7shifts response shapes
function findShiftsArray(root) {
  if (!root) return [];
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(root?.data?.data)) return root.data.data;
  if (Array.isArray(root?.data?.shifts)) return root.data.shifts;
  if (Array.isArray(root?.shifts)) return root.shifts;
  return [];
}

function getUserObj(shift) {
  return (
    shift.user ||
    shift.employee ||
    shift.assignee ||
    shift.assigned_to ||
    shift.user_details ||
    shift.userDetails ||
    null
  );
}

function employeeFromShift(shift) {
  const u = getUserObj(shift) || {};

  // Names might live on user object OR directly on shift
  const full =
    pick(u, ["name", "full_name", "fullName"]) ||
    pick(shift, ["name", "full_name", "fullName"]) ||
    "";

  let first =
    pick(u, ["first_name", "firstName", "first"]) ||
    pick(shift, ["first_name", "firstName", "first"]) ||
    "";
  let last =
    pick(u, ["last_name", "lastName", "last"]) ||
    pick(shift, ["last_name", "lastName", "last"]) ||
    "";

  if ((!first && !last) && full) {
    const sp = splitName(full);
    first = sp.first;
    last = sp.last;
  }

  const empId =
    pick(u, ["user_id", "userId", "employee_id", "employeeId", "id"]) ||
    pick(shift, ["user_id", "userId", "employee_id", "employeeId"]) ||
    null;

  const empNo =
    pick(u, ["employee_number", "employeeNumber", "emp_no", "empNo"]) ||
    pick(shift, ["employee_number", "employeeNumber", "emp_no", "empNo"]) ||
    "";

  // Dept classification usually is NOT reliable in shifts payload — default FOH for now.
  // You can later map via role/department if you want.
  const roleName =
    pick(shift, ["role_name", "roleName"]) ||
    pick(u, ["role_name", "roleName"]) ||
    null;

  return {
    dept: "FOH",
    empId: empId ? String(empId) : null,
    empNo: String(empNo || ""),
    first: norm(first),
    last: norm(last),
    wage: null,
    active: true,
    sourceRole: roleName,
  };
}

function keyForEmp(e) {
  if (e.empId) return `id:${e.empId}`;
  return `name:${normLower(e.first)}|${normLower(e.last)}`;
}

// ---------- main ----------
const raw = JSON.parse(fs.readFileSync(path.resolve(inFile), "utf8"));
const shifts = findShiftsArray(raw);

if (!shifts.length) {
  console.error("Could not find shifts array in JSON. Top-level keys:", Object.keys(raw || {}));
  process.exit(2);
}

// Deduplicate employees from shifts
const map = new Map();
let skippedNoName = 0;

for (const s of shifts) {
  const emp = employeeFromShift(s);
  if (!emp.first && !emp.last) {
    skippedNoName++;
    continue;
  }
  const k = keyForEmp(emp);
  if (!map.has(k)) map.set(k, emp);
}

const employees = Array.from(map.values()).sort((a, b) =>
  String(a.first || "").localeCompare(String(b.first || ""), undefined, { sensitivity: "base" })
);

const docPath = db
  .collection("companies")
  .doc(company)
  .collection("locations")
  .doc(loc)
  .collection(
