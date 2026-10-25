// Global Refresh: regenerate stale summaries (character storyRoleSummary,
// scene ragSummary, arc summary) using the audit trail as evidence. Batches
// audit-trail context into ~12 changes per LLM call. Shows a progress bar.
// Locks editing during the run.
//
// Conflict resolution: if a target summary was manually edited by the user
// since the last LLM generation, a Windows-style prompt asks
// (Keep existing / Use new / Keep both) before overwriting.

import { db } from "./shared.js?v=20261024";
import {
  doc, updateDoc, collection, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { callLLM, parseJsonLoose, isConfigured, callLLMJson } from "./llm.js?v=20261024";
import { changesSinceLastRefresh } from "./audit.js?v=20261024";
import { buildProjectContext } from "./story-settings.js?v=20261024";

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

const CONCEPT_SUMMARY_SYSTEM = `You are an assistant for a story bible app. Summarize a named in-world concept (an event, organization, system, phenomenon, or faction) in 1–3 sentences based on its description. Do NOT invent facts.

Return ONLY this JSON:
{ "summary": "..." }`;

const BEAT_SUMMARY_SYSTEM = `You are an assistant for a story bible app. Summarize a story beat in 1–3 sentences based on its description, its position in the structure, and the scenes that implement it. Keep it tight — beats are structural markers, not full prose.

Return ONLY this JSON:
{ "summary": "..." }`;

// ---------- Public entry ----------

export async function runGlobalRefresh({ state, projectId, onChanged }) {
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) {
      const { openSettingsModal } = await import("./settings.js?v=20261024");
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
  let stopped = false;
  let firstError = null;
  let fatal = null;
  // Snapshot "now" BEFORE generating so edits made while the refresh runs
  // still count as changes for the next one.
  const refreshStartedAt = Date.now();

  // try/finally: whatever happens, the overlay and the editing lock go away.
  try {
    for (const target of stale) {
      if (overlay.signal.aborted) { stopped = true; break; }
      overlay.setStep(`Refreshing ${target.kind}: ${target.title}`);
      try {
        const generated = await generateSummary(target, state, overlay.signal);
        if (!generated?.value) throw new Error("LLM returned no summary");
        const accepted = await maybeResolveConflict(target, generated);
        if (accepted) {
          await writeSummary(state, projectId, target, accepted);
          updatedCount++;
        } else {
          // "Keep existing" — the writer has confirmed the current summary,
          // so it's no longer stale (otherwise every refresh asks again).
          await clearStaleFlag(state, projectId, target);
          skipped++;
        }
      } catch (err) {
        if (overlay.signal.aborted) { stopped = true; break; }
        console.error("Refresh failed for", target, err);
        failed++;
        if (!firstError) firstError = { title: target.title, message: err?.message || String(err) };
        // Bad key, no credits, missing model, quota gone — every remaining
        // target would fail the same way, so stop instead of burning calls.
        if (isFatalLlmError(err)) { fatal = err; break; }
      }
      done++;
      overlay.setProgress(done, stale.length);
    }

    // Only move the "last refresh" marker when everything was covered —
    // otherwise the failed/unvisited targets would lose their change context.
    if (!failed && !stopped) {
      await updateDoc(doc(db, "users", state.user.uid, "projects", projectId), {
        lastRefreshAt: refreshStartedAt,
        updatedAt: serverTimestamp()
      });
      state.project.lastRefreshAt = refreshStartedAt;
    }
  } catch (err) {
    console.error("[refresh] aborted", err);
    alert("Global Refresh hit an error: " + (err?.message || err));
  } finally {
    overlay.close();
    onChanged?.();
  }

  const parts = [];
  parts.push(`${updatedCount} summar${updatedCount === 1 ? "y" : "ies"} updated`);
  if (skipped) parts.push(`${skipped} kept as-is`);
  if (failed) parts.push(`${failed} failed — they stay marked stale; run Refresh again to retry`);
  if (stopped) parts.push("stopped early");
  const unvisited = stale.length - done;
  if (fatal && unvisited > 0) parts.push(`${unvisited} not attempted`);
  let msg = (fatal ? "Refresh stopped on an error. " : stopped ? "Refresh stopped. " : "Refresh complete. ") + parts.join(", ") + ".";
  if (firstError) msg += `\n\nFirst error (${firstError.title}):\n${firstError.message.slice(0, 600)}`;
  alert(msg);
}

// Errors that will repeat for every remaining target.
function isFatalLlmError(err) {
  const st = err?.status;
  if ([400, 401, 402, 403, 404].includes(st)) return true;
  if (st === 429) return true; // already past the model fall-through chain
  return /No LLM provider|API key|Ooba fetch failed/i.test(err?.message || "");
}

async function clearStaleFlag(state, projectId, target) {
  const field = staleFieldFor(target.kind);
  const card = state.cards.get(target.cardId);
  if (!field || !card) return;
  card.fields = card.fields || {};
  card.fields[field] = false;
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", target.cardId), {
    [`fields.${field}`]: false
  });
}

function staleFieldFor(kind) {
  return kind === "character" ? "storyRoleSummaryStale"
    : kind === "scene" ? "ragSummaryStale"
    : (kind === "arc" || kind === "beat" || kind === "concept") ? "summaryStale"
    : null;
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
    } else if (c.type === "concept" && c.fields?.summaryStale) {
      out.push({ kind: "concept", cardId: c.id, title: c.title });
    } else if (c.type === "scene" && c.fields?.ragSummaryStale) {
      // Long description was emptied — nothing to summarize, so the stale
      // flag can never clear through generation. Fall back to the short one.
      out.push({ kind: "scene", cardId: c.id, title: c.title });
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

async function generateSummary(target, state, signal) {
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
    const out = await callBatched(signal, CHAR_SUMMARY_SYSTEM, ctx);
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
    const out = await callBatched(signal, SCENE_SUMMARY_SYSTEM, ctx);
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
    const out = await callBatched(signal, ARC_SUMMARY_SYSTEM, ctx);
    return { field: "summary", value: out.summary || "" };
  }

  if (target.kind === "concept") {
    const ctx = {
      concept: {
        title: card.title,
        description: card.fields?.description || "",
        currentSummary: card.fields?.summary || ""
      },
      recentChanges: changes
    };
    const out = await callBatched(signal, CONCEPT_SUMMARY_SYSTEM, ctx);
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
    const out = await callBatched(signal, BEAT_SUMMARY_SYSTEM, ctx);
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

async function callBatched(signal, system, payload) {
  // If recentChanges is large, split into ~BATCH_SIZE chunks and feed sequentially.
  const changes = payload.recentChanges || [];
  if (changes.length <= BATCH_SIZE) {
    return runOne(system, payload, signal);
  }
  // Multi-batch: feed accumulated context across calls. The model's last
  // output is used as the canonical summary.
  let last = null;
  for (let i = 0; i < changes.length; i += BATCH_SIZE) {
    const slice = changes.slice(i, i + BATCH_SIZE);
    const partial = { ...payload, recentChanges: slice, previousDraft: last };
    last = await runOne(system, partial, signal);
  }
  return last || {};
}

async function runOne(system, payload, signal) {
  const userText = `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON described in the system prompt.`;
  const projectCtx = buildProjectContext(STATE_REF?.project);
  // callLLMJson handles the "broken JSON, retry once with a repair prompt"
  // pattern so a single malformed reply in a multi-target refresh doesn't
  // burn that target with no recovery.
  return callLLMJson({ system: projectCtx + system, user: userText, signal });
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
    return { field: generated.field, value: `${existing}\n\n---\n\n${generated.value}`, keepUserEdited: true };
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
  const staleField = staleFieldFor(target.kind);
  const userEditedFlag = `${accepted.field}_userEdited`;
  // LLM-only text resets the flag; "Keep both" text includes the writer's
  // own words, so the next refresh must ask again before replacing it.
  const userEdited = !!accepted.keepUserEdited;

  await updateDoc(
    doc(db, "users", state.user.uid, "projects", projectId, "cards", target.cardId),
    {
      [`fields.${accepted.field}`]: accepted.value,
      ...(staleField ? { [`fields.${staleField}`]: false } : {}),
      [`fields.${userEditedFlag}`]: userEdited,
      updatedAt: serverTimestamp()
    }
  );
  card.fields[accepted.field] = accepted.value;
  if (staleField) card.fields[staleField] = false;
  card.fields[userEditedFlag] = userEdited;
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
      <div class="modal-actions">
        <button class="ghost small refresh-stop">Stop</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.classList.add("refresh-locked");
  const controller = new AbortController();
  const stopBtn = overlay.querySelector(".refresh-stop");
  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
    controller.abort(new DOMException("Refresh stopped", "AbortError"));
  });
  return {
    signal: controller.signal,
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
