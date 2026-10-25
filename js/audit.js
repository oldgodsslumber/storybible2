// Audit trail. Appended to project.auditTrail. Used by Global Refresh to
// know what has changed since the last refresh, and to detect when a
// summary needs regeneration.
//
// Each entry shape:
//   { timestamp, entityType, entityId, field, oldValue, newValue }
//
// timestamp is Date.now() (ms since epoch). We can't use serverTimestamp()
// inside arrayUnion(), and for change-ordering purposes client time is fine.

import { db } from "./shared.js?v=20261024";
import {
  doc, updateDoc, arrayUnion, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const MAX_VALUE_CHARS = 1000; // truncate big values so the project doc doesn't blow up
const MAX_VALUE_JSON = 2000;  // cap on any one value's serialized size
// The trail lives on the project doc, which Firestore caps at 1 MiB. Once it
// passes MAX_ENTRIES we rewrite it keeping the newest KEEP_ENTRIES. Only the
// entries since the last Global Refresh matter, so old history is expendable.
const MAX_ENTRIES = 300;
const KEEP_ENTRIES = 200;

// Coerce any value into something Firestore will accept inside arrayUnion:
// no undefined, no nested arrays, no sentinels/class instances, bounded size.
// Audit entries are a log — a lossy value beats a rejected write that takes
// the caller's whole save down with it.
function sanitize(value, inArray = false) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    return value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) + "…[truncated]" : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    // A nested array can't be stored — flatten it into the parent list.
    const flat = inArray ? [] : value.flat(Infinity).slice(0, 40).map(v => sanitize(v, true));
    return inArray ? JSON.stringify(value).slice(0, MAX_VALUE_CHARS) : flat;
  }
  if (typeof value === "object") {
    if (typeof value.toMillis === "function") return value.toMillis();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null; // FieldValue sentinels etc.
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = sanitize(v, false);
    }
    return out;
  }
  return null;
}

function bounded(value) {
  const clean = sanitize(value);
  if (clean && typeof clean === "object") {
    const json = JSON.stringify(clean);
    if (json.length > MAX_VALUE_JSON) return json.slice(0, MAX_VALUE_JSON) + "…[truncated]";
  }
  return clean;
}

export async function logAudit(userId, projectId, entries, localProject) {
  if (!entries || entries.length === 0) return;
  const stamped = entries.map(e => ({
    timestamp: Date.now(),
    entityType: e.entityType || "",
    entityId: e.entityId || "",
    field: e.field || "",
    oldValue: bounded(e.oldValue),
    newValue: bounded(e.newValue)
  }));
  const ref = doc(db, "users", userId, "projects", projectId);
  const current = localProject?.auditTrail || [];
  if (localProject && current.length + stamped.length > MAX_ENTRIES) {
    const next = current.concat(stamped).slice(-KEEP_ENTRIES);
    await updateDoc(ref, { auditTrail: next, updatedAt: serverTimestamp() });
    localProject.auditTrail = next;
    return;
  }
  await updateDoc(ref, {
    auditTrail: arrayUnion(...stamped),
    updatedAt: serverTimestamp()
  });
  if (localProject) {
    localProject.auditTrail = current.concat(stamped);
  }
}

// Field → which summary it makes stale.
// Returned object lists impacted entity types/fields.
export function staleImpact(entityType, field) {
  if (entityType === "card-character") {
    if (["role", "history", "traits", "physicalDescription", "age", "title"].includes(field)) {
      return { self: { field: "storyRoleSummaryStale", value: true } };
    }
  }
  if (entityType === "card-scene") {
    if (field === "longDescription") {
      return { self: { field: "ragSummaryStale", value: true } };
    }
  }
  if (entityType === "card-concept") {
    if (field === "description") {
      return { self: { field: "summaryStale", value: true } };
    }
  }
  if (entityType === "card-beat") {
    if (["description", "structurePosition", "relatedSceneIds", "relatedArcIds"].includes(field)) {
      return { self: { field: "summaryStale", value: true } };
    }
  }
  return null;
}

export function changesSinceLastRefresh(project) {
  const trail = project?.auditTrail || [];
  const last = project?.lastRefreshAt;
  const lastMs = last?.toMillis ? last.toMillis() : (typeof last === "number" ? last : 0);
  return trail.filter(e => (e.timestamp || 0) > lastMs);
}
