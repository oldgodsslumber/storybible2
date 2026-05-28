// Audit trail. Appended to project.auditTrail. Used by Global Refresh to
// know what has changed since the last refresh, and to detect when a
// summary needs regeneration.
//
// Each entry shape:
//   { timestamp, entityType, entityId, field, oldValue, newValue }
//
// timestamp is Date.now() (ms since epoch). We can't use serverTimestamp()
// inside arrayUnion(), and for change-ordering purposes client time is fine.

import { db } from "./shared.js";
import {
  doc, updateDoc, arrayUnion, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const MAX_VALUE_CHARS = 1000; // truncate big values so the project doc doesn't blow up

function trim(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) + "…[truncated]" : value;
  }
  if (Array.isArray(value)) return value.slice(0, 40).map(trim);
  return value;
}

export async function logAudit(userId, projectId, entries, localProject) {
  if (!entries || entries.length === 0) return;
  const stamped = entries.map(e => ({
    timestamp: Date.now(),
    entityType: e.entityType,
    entityId: e.entityId,
    field: e.field || "",
    oldValue: trim(e.oldValue ?? null),
    newValue: trim(e.newValue ?? null)
  }));
  const ref = doc(db, "users", userId, "projects", projectId);
  await updateDoc(ref, {
    auditTrail: arrayUnion(...stamped),
    updatedAt: serverTimestamp()
  });
  if (localProject) {
    localProject.auditTrail = (localProject.auditTrail || []).concat(stamped);
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
