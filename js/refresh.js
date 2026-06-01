// Global Refresh: regenerate stale summaries (character storyRoleSummary,
// scene ragSummary, arc summary) using the audit trail as evidence. Batches
// audit-trail context into ~12 changes per LLM call. Shows a progress bar.
// Locks editing during the run.
//
// Conflict resolution: if a target summary was manually edited by the user
// since the last LLM generation, a Windows-style prompt asks
// (Keep existing / Use new / Keep both) before overwriting.

import { db } from "./shared.js";
import {
  doc, updateDoc, collection, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { callLLM, parseJsonLoose, isConfigured, callLLMJson } from "./llm.js";
import { changesSinceLastRefresh } from "./audit.js";
import { buildProjectContext } from "./story-settings.js";

const BATCH_SIZE = 12;

const CHAR_SUMMARY_SYSTEM = `You are an assistant for a story bible app. Summarize a character's role in the story in 2–4 sentences. Be specific. Pull from the character card and the scenes they appear in. Do NOT invent facts.

Return ONLY this JSON:
{ "summary": "..." }`;

const SCENE_SUMMARY_SYSTEM = `You are an assistant for a story bible app. Given a scene's long description, write a tight short-description suitable for RAG retrieval (1–3 sentences). It should be concrete and named-entity-rich so retrieval works. Do NOT invent facts.

Return ONLY this JSON:
{ "ragSummary": "..." }`;

const ARC_SUMMARY_SYSTEM = `You are an assistant for a story bible app. Summarize the shape and trajectory of a narrative arc in 2–4 sentences, based on the scenes tagged to it and recent changes. Do NOT invent facts.

Return ONLY this JSON:
{ "summary": "..." }`;

const BEAT_SUMMARY_SYSTEM = `You are an assistant for a story bible app. Summarize a story beat in 1–3 sentences based on its description, its position in the structure, and the scenes that implement it. Keep it tight — beats are structural markers, not full prose.

Return ONLY this JSON:
{ "summary": "..." }`;

// ---------- Public entry ----------

export async function runGlobalRefresh({ state, projectId, onChanged }) {
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) {
      const { openSettingsModal } = await import("./settings.js?v=20260530");
      openSettingsModal();
    }
    return;
  }

  const stale = collectStaleTargets(state);
  if (stale.length === 0) {
    alert("Nothing to refresh — no stale summaries.");
    return;
  }

  const overlay = openProgressOverlay(stale.length);
  let done = 0;
  let updatedCount = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of stale) {
    overlay.setStep(`Refreshing ${target.kind}: ${target.title}`);
    try {
      const generated = await generateSummary(target, state);
      const accepted = await maybeResolveConflict(target, generated);
      if (accepted) {
        await writeSummary(state, projectId, target, accepted);
        updatedCount++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error("Refresh failed for", target, err);
      failed++;
    }
    done++;
    overlay.setProgress(done, stale.length);
  }

  // Mark lastRefreshAt
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId), {
    lastRefreshAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  state.project.lastRefreshAt = { toMillis: () => Date.now() };

  overlay.close();
  onChanged?.();

  const parts = [];
  parts.push(`${updatedCount} summar${updatedCount === 1 ? "y" : "ies"} updated`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} failed`);
  alert("Refresh complete. " + parts.join(", ") + ".");
}

// ---------- Collect what needs refreshing ----------

function collectStaleTargets(state) {
  const out = [];
  for (const c of state.cards.values()) {
    if (c.archived) continue;
    if (c.type === "character" && c.fields?.storyRoleSummaryStale) {
      out.push({ kind: "character", cardId: c.id, title: c.title });
    } else if (c.type === "scene" && c.fields?.ragSummaryStale && (c.fields?.longDescription || "").trim()) {
      out.push({ kind: "scene", cardId: c.id, title: c.title });
    } else if (c.type === "arc" && c.fields?.summaryStale) {
      out.push({ kind: "arc", cardId: c.id, title: c.title });
    } else if (c.type === "beat" && c.fields?.summaryStale) {
      out.push({ kind: "beat", cardId: c.id, title: c.title });
    }
  }
  // Also flag: characters that have NO storyRoleSummary yet, scenes with
  // longDescription but no ragSummary, beats with description but no summary.
  for (const c of state.cards.values()) {
    if (c.archived) continue;
    if (c.type === "character" && !c.fields?.storyRoleSummary && hasAnyContent(c)) {
      if (!out.find(t => t.cardId === c.id)) out.push({ kind: "character", cardId: c.id, title: c.title });
    }
    if (c.type === "scene" && !c.fields?.ragSummary && (c.fields?.longDescription || "").trim()) {
      if (!out.find(t => t.cardId === c.id)) out.push({ kind: "scene", cardId: c.id, title: c.title });
    }
    if (c.type === "beat" && !c.fields?.summary && (c.fields?.description || "").trim()) {
      if (!out.find(t => t.cardId === c.id)) out.push({ kind: "beat", cardId: c.id, title: c.title });
    }
  }
  return out;
}

function hasAnyContent(card) {
  const f = card.fields || {};
  return !!(f.role || f.physicalDescription || (f.history && f.history.length) || (f.traits && f.traits.length));
}

// ---------- Generation ----------

async function generateSummary(target, state) {
  const card = state.cards.get(target.cardId);
  if (!card) return null;
  const changes = relevantChanges(state.project, target.cardId);

  if (target.kind === "character") {
    const scenesWith = scenesFeaturingCharacter(state, target.cardId);
    const ctx = {
      character: {
        title: card.title,
        role: card.fields?.role,
        age: card.fields?.age,
        physicalDescription: card.fields?.physicalDescription,
        history: card.fields?.history || [],
        traits: card.fields?.traits || []
      },
      scenesFeaturing: scenesWith.map(s => ({
        title: s.title,
        shortDescription: s.fields?.shortDescription || "",
        ragSummary: s.fields?.ragSummary || ""
      })),
      recentChanges: changes
    };
    const out = await callBatched(CHAR_SUMMARY_SYSTEM, ctx);
    return { field: "storyRoleSummary", value: out.summary || "" };
  }

  if (target.kind === "scene") {
    const ctx = {
      scene: {
        title: card.title,
        shortDescription: card.fields?.shortDescription || "",
        longDescription: card.fields?.longDescription || ""
      },
      recentChanges: changes
    };
    const out = await callBatched(SCENE_SUMMARY_SYSTEM, ctx);
    return { field: "ragSummary", value: out.ragSummary || "" };
  }

  if (target.kind === "arc") {
    const scenesInArc = [...state.cards.values()].filter(
      c => c.type === "scene" && !c.archived && (c.fields?.arcIds || []).includes(target.cardId)
    );
    const ctx = {
      arc: { title: card.title, currentSummary: card.fields?.summary || "" },
      scenesInArc: scenesInArc.map(s => ({
        title: s.title,
        shortDescription: s.fields?.shortDescription || "",
        ragSummary: s.fields?.ragSummary || ""
      })),
      recentChanges: changes
    };
    const out = await callBatched(ARC_SUMMARY_SYSTEM, ctx);
    return { field: "summary", value: out.summary || "" };
  }

  if (target.kind === "beat") {
    const scenesInBeat = [...state.cards.values()].filter(
      c => c.type === "scene" && !c.archived && (card.fields?.relatedSceneIds || []).includes(c.id)
    );
    const ctx = {
      beat: {
        title: card.title,
        description: card.fields?.description || "",
        structurePosition: card.fields?.structurePosition || "",
        currentSummary: card.fields?.summary || ""
      },
      scenesInBeat: scenesInBeat.map(s => ({
        title: s.title,
        shortDescription: s.fields?.shortDescription || "",
        ragSummary: s.fields?.ragSummary || ""
      })),
      recentChanges: changes
    };
    const out = await callBatched(BEAT_SUMMARY_SYSTEM, ctx);
    return { field: "summary", value: out.summary || "" };
  }

  return null;
}

function relevantChanges(project, cardId) {
  const all = changesSinceLastRefresh(project);
  return all.filter(e => e.entityId === cardId);
}

function scenesFeaturingCharacter(state, characterId) {
  return [...state.cards.values()].filter(
    c => c.type === "scene" && !c.archived && (c.fields?.characterIds || []).includes(characterId)
  );
}

async function callBatched(system, payload) {
  // If recentChanges is large, split into ~BATCH_SIZE chunks and feed sequentially.
  const changes = payload.recentChanges || [];
  if (changes.length <= BATCH_SIZE) {
    return runOne(system, payload);
  }
  // Multi-batch: feed accumulated context across calls. The model's last
  // output is used as the canonical summary.
  let last = null;
  for (let i = 0; i < changes.length; i += BATCH_SIZE) {
    const slice = changes.slice(i, i + BATCH_SIZE);
    const partial = { ...payload, recentChanges: slice, previousDraft: last };
    last = await runOne(system, partial);
  }
  return last || {};
}

async function runOne(system, payload) {
  const userText = `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON described in the system prompt.`;
  const projectCtx = buildProjectContext(STATE_REF?.project);
  // callLLMJson handles the "broken JSON, retry once with a repair prompt"
  // pattern so a single malformed reply in a multi-target refresh doesn't
  // burn that target with no recovery.
  return callLLMJson({ system: projectCtx + system, user: userText });
}

// ---------- Conflict resolution ----------

async function maybeResolveConflict(target, generated) {
  if (!generated || !generated.value) return null;
  const cardId = target.cardId;
  // For each summary field, we track *_userEdited. If true, user touched
  // it after the last LLM write — show conflict modal.
  const card = STATE_REF?.cards?.get(cardId);
  if (!card) return generated;
  const existing = card.fields?.[generated.field] || "";
  const userEditedFlag = `${generated.field}_userEdited`;
  if (!existing || !card.fields?.[userEditedFlag]) {
    return generated;
  }
  // Conflict: ask user
  const choice = await openConflictModal({
    title: target.title,
    field: generated.field,
    existing,
    proposed: generated.value
  });
  if (choice === "existing") return null;
  if (choice === "new") return generated;
  if (choice === "both") {
    return { field: generated.field, value: `${existing}\n\n---\n\n${generated.value}` };
  }
  return null;
}

let STATE_REF = null;
export function provideStateRef(stateObj) { STATE_REF = stateObj; }

function openConflictModal({ title, field, existing, proposed }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal conflict-modal">
        <div class="modal-header">
          <h2>Update conflict — ${esc(title)}</h2>
        </div>
        <div class="modal-body">
          <p class="muted small">The LLM wants to update <code>${esc(field)}</code>, but you've edited it manually since the last refresh.</p>
          <div class="conflict-cols">
            <div>
              <h4>Your version</h4>
              <div class="conflict-text">${esc(existing)}</div>
            </div>
            <div>
              <h4>LLM proposal</h4>
              <div class="conflict-text">${esc(proposed)}</div>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="ghost choice-existing">Keep existing</button>
          <button class="ghost choice-both">Keep both</button>
          <button class="primary choice-new">Use new</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const finish = c => { overlay.remove(); resolve(c); };
    overlay.querySelector(".choice-existing").addEventListener("click", () => finish("existing"));
    overlay.querySelector(".choice-new").addEventListener("click", () => finish("new"));
    overlay.querySelector(".choice-both").addEventListener("click", () => finish("both"));
  });
}

// ---------- Write the new summary ----------

async function writeSummary(state, projectId, target, accepted) {
  const card = state.cards.get(target.cardId);
  if (!card) return;
  card.fields = card.fields || {};
  const staleField =
    target.kind === "character" ? "storyRoleSummaryStale" :
    target.kind === "scene" ? "ragSummaryStale" :
    target.kind === "arc" ? "summaryStale" :
    target.kind === "beat" ? "summaryStale" : null;
  const userEditedFlag = `${accepted.field}_userEdited`;

  card.fields[accepted.field] = accepted.value;
  if (staleField) card.fields[staleField] = false;
  card.fields[userEditedFlag] = false; // LLM-written → reset user-edited

  await updateDoc(
    doc(db, "users", state.user.uid, "projects", projectId, "cards", target.cardId),
    {
      [`fields.${accepted.field}`]: accepted.value,
      ...(staleField ? { [`fields.${staleField}`]: false } : {}),
      [`fields.${userEditedFlag}`]: false,
      updatedAt: serverTimestamp()
    }
  );
}

// ---------- Progress overlay ----------

function openProgressOverlay(total) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay refresh-overlay";
  overlay.innerHTML = `
    <div class="modal refresh-modal">
      <div class="modal-header">
        <h2>Global Refresh</h2>
      </div>
      <div class="modal-body">
        <p id="refreshStep" class="muted">Starting…</p>
        <div class="progress-bar"><div class="progress-fill" id="refreshFill" style="width:0%"></div></div>
        <p class="muted small" id="refreshCount">0 / ${total}</p>
        <p class="muted small">Editing is locked during refresh.</p>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.classList.add("refresh-locked");
  return {
    setStep: (txt) => { overlay.querySelector("#refreshStep").textContent = txt; },
    setProgress: (n, total) => {
      const pct = total ? Math.round((n / total) * 100) : 0;
      overlay.querySelector("#refreshFill").style.width = pct + "%";
      overlay.querySelector("#refreshCount").textContent = `${n} / ${total}`;
    },
    close: () => { overlay.remove(); document.body.classList.remove("refresh-locked"); }
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
