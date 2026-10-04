/* Computer Lab Report — shared offline queue + sync engine.
   Used by the student submit page and rptview.html (staff view).
   Queue lives in localStorage (per browser, per device). Sync pushes to
   Firestore `publicReports` (status: pending) when online. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, collection, addDoc, serverTimestamp,
  doc, getDocs, query, where, setDoc, updateDoc, arrayUnion, limit,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export const APP_VERSION = "1.0.0";
export const COMMAND_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const firebaseConfig = {
  apiKey: "AIzaSyBfTwlUw5GJxd0tQNaFJTIosR9R5HElSn0",
  authDomain: "streamoflix-ce012.firebaseapp.com",
  projectId: "streamoflix-ce012",
  storageBucket: "streamoflix-ce012.firebasestorage.app",
  messagingSenderId: "414276254075",
  appId: "1:414276254075:web:46311491317412b563e5de",
  measurementId: "G-FXVY0FW5LH",
};

let db = null;
try {
  db = getFirestore(initializeApp(firebaseConfig));
} catch (err) {
  console.error("Firebase init failed:", err);
}
export function getDb() { return db; }

export function normalizePcInput(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  if (/teacher/i.test(t)) return "LAB-TEACHER-PC";
  const m = /(\d{1,3})/.exec(t);
  if (m) return "LAB-STUDENT-PC-" + m[1].padStart(2, "0");
  return t.toUpperCase();
}

/* ---------------- local queue ---------------- */
const QUEUE_KEY = "bafsd-offline-reports";
const MAX_QUEUE = 200;

export function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveQueue(items) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(0, MAX_QUEUE)));
  } catch (_) {}
}

export function queueReport({ pcRaw, deviceName, reporterName, description, studentId, studentMeta, studentLabel, serial, title }) {
  const items = loadQueue();
  if (items.length >= MAX_QUEUE) {
    throw new Error("queue-full");
  }
  const item = {
    id: "loc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    pcRaw: String(pcRaw || "").slice(0, 20),
    deviceName: String(deviceName || "").slice(0, 40),
    serial: String(serial || "").slice(0, 40),
    reporterName: String(reporterName || "").slice(0, 60),
    title: String(title || "").slice(0, 120),
    description: String(description || "").slice(0, 500),
    studentId: String(studentId || "").slice(0, 30),
    studentMeta: studentMeta && typeof studentMeta === "object" ? studentMeta : null,
    studentLabel: String(studentLabel || "").slice(0, 160),
    createdAt: new Date().toISOString(),
    sync: "queued",
  };
  items.unshift(item);
  saveQueue(items);
  return item;
}

export function markSynced(id) {
  const items = loadQueue();
  const it = items.find((x) => x.id === id);
  if (it) {
    it.sync = "synced";
    it.syncedAt = new Date().toISOString();
    delete it.error;
    saveQueue(items);
  }
}

export function markFailed(id, code) {
  const items = loadQueue();
  const it = items.find((x) => x.id === id);
  if (it) {
    it.sync = "failed";
    it.error = String(code || "error").slice(0, 60);
    saveQueue(items);
  }
}

export function deleteQueued(id) {
  saveQueue(loadQueue().filter((x) => x.id !== id));
}

export function countUnsynced() {
  return loadQueue().filter((x) => x.sync !== "synced").length;
}

/* ---------------- sync engine ---------------- */
let syncing = false;

export async function pushOne(item) {
  const database = getDb();
  if (!database) throw new Error("no-db");
  await addDoc(collection(database, "publicReports"), {
    pcRaw: item.pcRaw,
    deviceName: item.deviceName,
    serial: item.serial || "",
    reporterName: item.reporterName || "",
    title: item.title || "",
    description: item.description,
    studentId: item.studentId || "",
    studentMeta: item.studentMeta || null,
    studentLabel: item.studentLabel || "",
    status: "pending",
    createdAt: serverTimestamp(),
    origin: "offline-queue",
  });
}

/* Push every queued/failed item. Returns {sent, failed}. Re-entrant safe. */
export async function syncQueue() {
  if (syncing) return { sent: 0, failed: 0, skipped: true };
  if (!navigator.onLine) return { sent: 0, failed: 0, offline: true };
  if (!getDb()) return { sent: 0, failed: 0, nodb: true };
  syncing = true;
  let sent = 0, failed = 0;
  try {
    const pending = loadQueue().filter((x) => x.sync === "queued" || x.sync === "failed");
    for (const item of pending) {
      try {
        await pushOne(item);
        markSynced(item.id);
        sent++;
      } catch (err) {
        console.warn("Sync failed for", item.id, err);
        markFailed(item.id, err && err.code ? err.code : "error");
        failed++;
      }
    }
  } finally {
    syncing = false;
  }
  return { sent, failed };
}

/* ---------------- staff PIN — SAME as main app login PIN ----------------
   The main app caches its Firestore PIN hash locally on every successful
   unlock (key: bafsd_main_pin_hash). Staff pages verify against that same
   hash with the same SHA-256 system — one PIN everywhere. Change it only
   from the main app (Settings → Security); this device picks it up on the
   next online unlock. */
const MAIN_PIN_KEY = "bafsd_main_pin_hash";

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hasMainPinCached() {
  try {
    return !!localStorage.getItem(MAIN_PIN_KEY);
  } catch (_) {
    return false;
  }
}

/* Default staff PIN for all PCs — works everywhere with zero setup.
   Change it in ONE place here and redeploy. */
export const DEFAULT_STAFF_PIN = "@bafsd#1206";

/* Fallback for separate hosting (different origin = different
   localStorage, so the main-app hash is unreachable there).
   Staff creates a PIN once on this origin — same SHA-256 system,
   same UI. Main-app hash is always tried first. */
const STAFF_PIN_KEY = "bafsd_staff_pin";

export async function hasStaffPin() {
  try {
    return !!localStorage.getItem(STAFF_PIN_KEY);
  } catch (_) {
    return false;
  }
}

export async function setStaffPin(pin) {
  if (!pin || pin.length < 4) throw new Error("pin-short");
  try {
    localStorage.setItem(STAFF_PIN_KEY, await sha256Hex("bafsd-staff|" + pin));
  } catch (_) {
    throw new Error("pin-save-failed");
  }
}

/* Website-issued PIN override (Report App Manager → Change PIN).
   When present, ONLY this PIN works — the default PIN is disabled. */
const OVERRIDE_KEY = "bafsd_staff_pin_override";
const OVERRIDE_VER_KEY = "bafsd-pin-cmd-version";

export function getPinOverride() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.hash ? o : null;
  } catch (_) {
    return null;
  }
}

function getAppliedCmdVersion() {
  try {
    return Number(localStorage.getItem(OVERRIDE_VER_KEY) || 0);
  } catch (_) {
    return 0;
  }
}

function setAppliedCmdVersion(v) {
  try {
    localStorage.setItem(OVERRIDE_VER_KEY, String(v));
  } catch (_) {}
}

export function clearPinOverride() {
  try {
    localStorage.removeItem(OVERRIDE_KEY);
  } catch (_) {}
}

export async function verifyStaffPin(pin) {
  if (!pin) return false;
  const ov = getPinOverride();
  if (ov) {
    try {
      return (await sha256Hex(pin)) === ov.hash;
    } catch (_) {
      return false;
    }
  }
  if (pin === DEFAULT_STAFF_PIN) return true;
  try {
    const main = localStorage.getItem(MAIN_PIN_KEY);
    if (main && (await sha256Hex(pin)) === main) return true;
    const local = localStorage.getItem(STAFF_PIN_KEY);
    if (local && (await sha256Hex("bafsd-staff|" + pin)) === local) return true;
    return false;
  } catch (_) {
    return false;
  }
}

export function pinMode() {
  const ov = getPinOverride();
  return ov ? { mode: "custom", version: ov.version || 0 } : { mode: "default", version: 0 };
}

/* ---------------- PC binding ---------------- */
const BIND_KEY = "bafsd-pc-binding";

export function loadBinding() {
  try {
    const raw = localStorage.getItem(BIND_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.v !== 1 || !o.serial) return null;
    return o;
  } catch (_) {
    return null;
  }
}

export function saveBinding({ serial, pcName }) {
  const o = {
    v: 1,
    serial: String(serial || "").slice(0, 40),
    pcName: String(pcName || "").slice(0, 60),
    boundAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(BIND_KEY, JSON.stringify(o));
  } catch (_) {}
  return o;
}

export function clearBinding() {
  try {
    localStorage.removeItem(BIND_KEY);
  } catch (_) {}
}

/* ---------------- telemetry ---------------- */
const TELEM_AT_KEY = "bafsd-telemetry-at";
const TELEM_TIMES_KEY = "bafsd-telemetry-times";

function loadTelemTimes() {
  try {
    return JSON.parse(localStorage.getItem(TELEM_TIMES_KEY) || "{}");
  } catch (_) {
    return {};
  }
}

function touchTelemTime(which) {
  try {
    const t = loadTelemTimes();
    t[which] = new Date().toISOString();
    localStorage.setItem(TELEM_TIMES_KEY, JSON.stringify(t));
  } catch (_) {}
}

/* force=true for meaningful events (app open / staff unlock / sync done).
   Heartbeats are throttled to 1/hour to save Firestore writes. */
export async function writeTelemetry(binding, { force = false, queuedCount = 0 } = {}) {
  const database = getDb();
  if (!database || !binding?.serial || !navigator.onLine) return false;
  try {
    const last = Number(localStorage.getItem(TELEM_AT_KEY) || 0);
    if (!force && Date.now() - last < 60 * 60 * 1000) return false;
    const times = loadTelemTimes();
    const pm = pinMode();
    await setDoc(
      doc(database, "appTelemetry", binding.serial),
      {
        serial: binding.serial,
        pcName: binding.pcName || "",
        appVersion: APP_VERSION,
        lastAppOpen: times.appOpen || null,
        lastStaffView: times.staffView || null,
        queuedCount: Number(queuedCount) || 0,
        pinMode: pm.mode,
        pinVersion: pm.version,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    try {
      localStorage.setItem(TELEM_AT_KEY, String(Date.now()));
    } catch (_) {}
    return true;
  } catch (err) {
    console.warn("Telemetry failed:", err);
    return false;
  }
}

export function markAppOpen() {
  touchTelemTime("appOpen");
}

export function markStaffView() {
  touchTelemTime("staffView");
}

/* ---------------- command poller ----------------
   Fetches pending website commands for this PC (or broadcast 'all'),
   applies newer versions, acks best-effort. Returns {applied, wipes}. */
let polling = false;

export async function pollCommands(binding) {
  const out = { applied: [], wipes: [] };
  const database = getDb();
  if (polling || !database || !binding?.serial || !navigator.onLine) return out;
  polling = true;
  try {
    const now = Date.now();
    let snap;
    try {
      snap = await getDocs(
        query(collection(database, "appCommands"), where("expiresAt", ">", now), limit(100))
      );
    } catch (err) {
      console.warn("Command poll failed:", err);
      return out;
    }
    const appliedVer = getAppliedCmdVersion();
    let maxVer = appliedVer;
    for (const d of snap.docs) {
      const c = d.data() || {};
      if (c.scope !== "all" && c.scope !== binding.serial) continue;
      const ver = Number(c.version) || 0;
      if (ver <= appliedVer) continue;
      if (c.type === "pin-change" && c.pinHash) {
        try {
          localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ hash: String(c.pinHash), version: ver }));
        } catch (_) {}
        out.applied.push({ id: d.id, type: "pin-change", version: ver });
      } else if (c.type === "pin-reset") {
        clearPinOverride();
        out.applied.push({ id: d.id, type: "pin-reset", version: ver });
      } else {
        continue;
      }
      if (ver > maxVer) maxVer = ver;
      try {
        await updateDoc(doc(database, "appCommands", d.id), {
          ackedBy: arrayUnion(binding.serial),
        });
      } catch (_) {}
    }
    if (maxVer > appliedVer) setAppliedCmdVersion(maxVer);

    try {
      const wq = await getDocs(
        query(
          collection(database, "wipeRequests"),
          where("serial", "==", binding.serial),
          where("status", "==", "approved"),
          limit(20)
        )
      );
      wq.forEach((w) => out.wipes.push({ id: w.id, ...(w.data() || {}) }));
    } catch (err) {
      console.warn("Wipe poll failed:", err);
    }
  } finally {
    polling = false;
  }
  return out;
}

export async function markWipeExecuted(reqId) {
  const database = getDb();
  if (!database) throw new Error("no-db");
  await updateDoc(doc(database, "wipeRequests", reqId), {
    status: "executed",
    executedAt: serverTimestamp(),
  });
}

export async function createWipeRequest({ serial, pcName, kind, reportId }) {
  const database = getDb();
  if (!database) throw new Error("no-db");
  // const safeSerial = String(serial || "").trim().slice(0, 40);
  // if (!safeSerial) throw new Error("missing-serial");
  const ref = await addDoc(collection(database, "wipeRequests"), {
    serial: String(serial || "").slice(0, 40),
    // serial: safeSerial,
    pcName: String(pcName || "").slice(0, 60),
    kind: kind === "all-data" ? "all-data" : "report",
    reportId: reportId || null,
    status: "pending",
    requestedAt: serverTimestamp(),
  });
  return ref.id;
}

/* ---------------- delete-approval handshake ----------------
   Device-side deletes wait for website approval (Report App Manager).
   Pending request ids are tracked locally per report / all-data. */
const DELP_KEY = "bafsd-delete-pending";

export function getDeletePending() {
  try {
    const o = JSON.parse(localStorage.getItem(DELP_KEY) || "{}");
    return o && typeof o === "object" ? o : {};
  } catch (_) {
    return {};
  }
}

export function setDeletePending(key, reqId) {
  try {
    const o = getDeletePending();
    o[key] = reqId;
    localStorage.setItem(DELP_KEY, JSON.stringify(o));
  } catch (_) {}
}

export function clearDeletePending(key) {
  try {
    const o = getDeletePending();
    delete o[key];
    localStorage.setItem(DELP_KEY, JSON.stringify(o));
  } catch (_) {}
}

export function clearAllDeletePending() {
  try {
    localStorage.removeItem(DELP_KEY);
  } catch (_) {}
}

export async function fetchOwnWipeRequests(serial) {
  const database = getDb();
  if (!database || !serial) return [];
  const snap = await getDocs(
    query(collection(database, "wipeRequests"), where("serial", "==", serial), limit(50))
  );
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
}

/* Executes an approved wipe request. Returns 'reloaded' for all-data
   (page reloads into the welcome flow), true/false otherwise. */
export async function executeApprovedWipe(req) {
  if (!req || req.status !== "approved") return false;
  try {
    if (req.kind === "all-data") {
      [
        "bafsd-offline-reports",
        "bafsd-pc-binding",
        "bafsd-telemetry-at",
        "bafsd-telemetry-times",
        "bafsd-last-report",
        "bafsd-delete-pending",
        "bafsd_staff_pin",
        "bafsd_staff_pin_override",
        "bafsd-pin-cmd-version",
        "bafsd-staff-cool-until",
      ].forEach((k) => {
        try {
          localStorage.removeItem(k);
        } catch (_) {}
      });
      try {
        sessionStorage.removeItem("bafsd-staff-unlocked");
        sessionStorage.removeItem("bafsd-staff-tab");
      } catch (_) {}
      try {
        await markWipeExecuted(req.id);
      } catch (_) {}
      location.reload();
      return "reloaded";
    }
    if (req.reportId) deleteQueued(req.reportId);
    clearDeletePending(req.reportId);
    try {
      await markWipeExecuted(req.id);
    } catch (_) {}
    return true;
  } catch (err) {
    console.warn("Wipe execution failed:", err);
    return false;
  }
}

/* Syncs local pending flags with website decisions.
   Returns {executed, rejected} counts. Never throws. */
export async function syncWipeState(binding) {
  const out = { executed: 0, rejected: 0 };
  if (!binding?.serial || !navigator.onLine || !getDb()) return out;
  let mine = [];
  try {
    mine = await fetchOwnWipeRequests(binding.serial);
  } catch (_) {
    return out;
  }
  const pending = getDeletePending();
  const byId = {};
  mine.forEach((r) => (byId[r.id] = r));
  for (const [key, reqId] of Object.entries(pending)) {
    const r = byId[reqId];
    if (!r) continue;
    if (r.status === "approved") {
      const res = await executeApprovedWipe(r);
      if (res === "reloaded") return { executed: out.executed + 1, rejected: out.rejected, reloaded: true };
      if (res) out.executed++;
    } else if (r.status === "rejected") {
      clearDeletePending(key);
      out.rejected++;
    }
  }
  return out;
}
