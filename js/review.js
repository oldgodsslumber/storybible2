// M4 — Review Panel modes + Scene Generation + Trait Suggestions + Arc tension analysis.
//
// All flows go through the LLM provider configured in Settings. They consume
// the RAG-style summaries maintained in M3 (storyRoleSummary, ragSummary,
// arc.summary). If summaries are missing, the prompt instructs the model to
// use raw content as a fallback.

import { db } from "./shared.js";
import {
  doc, updateDoc, addDoc, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { callLLM, parseJsonLoose, isConfigured } from "./llm.js";
import { openSettingsModal } from "./settings.js?v=20260530";
import { logAudit } from "./audit.js";
import { openBusyOverlay } from "./shared.js";
import { buildProjectContext } from "./story-settings.js";

function ctx(state) { return buildProjectContext(state?.project); }

// Mirror of project.js runLLMAction so review-panel calls get the same
// busy overlay + console trace + error alert behavior.
async function runLLMAction(label, fn) {
  console.log("[llm-action] start:", label);
  const busy = openBusyOverlay(label);
  try {
    const result = await fn();
    console.log("[llm-action] ok:", label, result);
    busy.close();
    return { ok: true, result };
  } catch (err) {
    busy.close();
    console.error("[llm-action] failed:", label, err);
    if (err?.name === "AbortError") return { ok: false, error: err, cancelled: true };
    alert(label + " failed:\n\n" + (err?.message || String(err)));
    return { ok: false, error: err };
  }
}

// ---------- Prompts ----------

const ARC_REVIEW_SYSTEM = `You are an assistant for a story bible app. Write 2–4 paragraphs of plain prose describing the arc of a single character across the story. Cover: starting point, key turning points, resolution status, and any unresolved tension. Be specific — name scenes when relevant. Do NOT invent events.

Return ONLY this JSON:
{ "review": "paragraph text...\\n\\nparagraph text..." }`;

const SYNOPSIS_SYSTEM = `You are an assistant for a story bible app. Write a 3–5 paragraph story synopsis based on the project's scenes, characters, and themes. Plain prose. Faithfully reflect what is on the cards — do NOT invent events. If the story is fragmentary, say so honestly in the synopsis.

Return ONLY this JSON:
{ "synopsis": "paragraph text...\\n\\nparagraph text..." }`;

const THEME_COHERENCE_SYSTEM = `You are an assistant for a story bible app. Analyze whether the scenes and character behaviors consistently explore the stated theme pillars. Identify:
- which scenes / characters reinforce each theme
- which scenes / characters seem thematically disconnected (and why)
- an overall assessment

Be specific. Do NOT invent content.

Return ONLY this JSON:
{
  "perTheme": [{"theme": "name", "supporting": [{"name":"...","type":"scene|character","note":"..."}], "disconnected": [{"name":"...","type":"scene|character","note":"..."}]}],
  "overall": "1-2 sentence overall assessment"
}`;

const SCENE_GEN_SYSTEM = `You are an assistant for a story bible app. Propose a single bridging scene that fits between two given scenes (or at the start/end if only one is provided). Use the surrounding scene context and the project's themes and characters. The proposal should be specific and grounded. Do NOT invent characters or locations not in the existing entity list — instead, reference the existing names.

Return ONLY this JSON:
{
  "title": "short scene title",
  "shortDescription": "1-3 sentence short description",
  "longDescription": "optional longer description (can be empty string)",
  "rationale": "2-3 sentence 'why this fits' explanation",
  "suggestedCharacterNames": ["existing names only"],
  "suggestedLocationNames": ["existing names only"]
}`;

const TRAIT_SUGGEST_SYSTEM = `You are an assistant for a story bible app. Suggest 3–5 character traits, internal contradictions, or relationships that would philosophically explore or challenge the project's themes through THIS character. Avoid archetypes already prominent in other characters. Each suggestion gets a 2–3 sentence rationale that ties to the themes.

Return ONLY this JSON:
{
  "suggestions": [
    {"kind": "trait|contradiction|relationship", "text": "the trait/contradiction/relationship phrasing", "rationale": "..."}
  ]
}`;

const TENSION_SYSTEM = `You are an assistant for a story bible app. The writer has edited an arc summary. Your job: identify which scenes tagged to that arc are now in TENSION with the new summary, and suggest revisions.

Return ONLY this JSON:
{
  "tensions": [
    {"sceneTitle": "...", "problem": "what's in tension", "suggestion": "concrete revision direction"}
  ]
}`;

// ---------- LLM helpers ----------

async function ensureLLM() {
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) openSettingsModal();
    return false;
  }
  return true;
}

async function callJson(system, user) {
  const raw = await callLLM({ system, user, expectJson: true });
  try {
    return parseJsonLoose(raw);
  } catch (firstErr) {
    // Retry once with a stricter prompt. Catches the occasional case where
    // the model added a trailing comma or stray prose. We re-feed the model
    // its own (broken) output and ask for clean JSON of the same shape.
    console.warn("[llm] parse failed once, retrying with cleanup prompt:", firstErr.message);
    const cleanupSystem = "You are a JSON repair assistant. The user will paste broken or wrapped JSON. Return ONLY the corrected JSON, no prose, no fences. Preserve all data; only fix syntax.";
    const repaired = await callLLM({
      system: cleanupSystem,
      user: `Broken output:\n${raw}`,
      expectJson: true,
      temperature: 0
    });
    return parseJsonLoose(repaired);
  }
}

// ---------- Public API ----------

export async function reviewCharacterArc(state, characterId) {
  if (!await ensureLLM()) return null;
  const ch = state.cards.get(characterId);
  if (!ch) return null;
  const scenes = scenesFeaturingByName(state, ch.title);
  const payload = {
    character: pickCharacter(ch),
    scenesInOrder: scenes.map(pickScene),
    themes: themeList(state)
  };
  return callJson(ctx(state) + ARC_REVIEW_SYSTEM, `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON.`);
}

export async function generateSynopsis(state) {
  if (!await ensureLLM()) return null;
  const payload = {
    project: { title: state.project.title, logline: state.project.logline, themeText: state.project.themeText },
    themes: themeList(state),
    characters: characterList(state).map(pickCharacter),
    scenesInOrder: sceneList(state).map(pickScene)
  };
  return callJson(ctx(state) + SYNOPSIS_SYSTEM, `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON.`);
}

export async function themeCoherence(state) {
  if (!await ensureLLM()) return null;
  const payload = {
    themes: themeList(state),
    characters: characterList(state).map(pickCharacter),
    scenes: sceneList(state).map(pickScene)
  };
  return callJson(ctx(state) + THEME_COHERENCE_SYSTEM, `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON.`);
}

export async function generateScene(state, { beforeSceneId, afterSceneId }) {
  if (!await ensureLLM()) return null;
  const before = beforeSceneId ? state.cards.get(beforeSceneId) : null;
  const after  = afterSceneId  ? state.cards.get(afterSceneId)  : null;
  const payload = {
    precedingScene: before ? pickScene(before) : null,
    followingScene: after  ? pickScene(after)  : null,
    themes: themeList(state),
    existingCharacterNames: characterList(state).map(c => c.title),
    existingLocationNames:  locationList(state).map(c => c.title),
    nearbyScenes: sceneList(state).slice(0, 30).map(pickScene)
  };
  return callJson(ctx(state) + SCENE_GEN_SYSTEM, `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON.`);
}

export async function suggestTraits(state, characterId) {
  if (!await ensureLLM()) return null;
  const ch = state.cards.get(characterId);
  if (!ch) return null;
  const payload = {
    character: pickCharacter(ch),
    themes: themeList(state),
    otherCharacters: characterList(state).filter(c => c.id !== characterId).map(pickCharacter)
  };
  return callJson(ctx(state) + TRAIT_SUGGEST_SYSTEM, `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON.`);
}

export async function analyzeArcTension(state, arcId, newSummary) {
  if (!await ensureLLM()) return null;
  const arc = state.cards.get(arcId);
  if (!arc) return null;
  const scenes = sceneList(state).filter(s => (s.fields?.arcIds || []).includes(arcId));
  const payload = {
    arc: { title: arc.title, newSummary },
    scenes: scenes.map(pickScene)
  };
  return callJson(ctx(state) + TENSION_SYSTEM, `Context:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON.`);
}

// ---------- Helpers: list / pick ----------

function characterList(state) {
  return [...state.cards.values()].filter(c => c.type === "character" && !c.archived);
}
function sceneList(state) {
  return [...state.cards.values()]
    .filter(c => c.type === "scene" && !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
function locationList(state) {
  return [...state.cards.values()].filter(c => c.type === "location" && !c.archived);
}
function arcList(state) {
  return [...state.cards.values()].filter(c => c.type === "arc" && !c.archived);
}
function themeList(state) {
  return [...state.cards.values()]
    .filter(c => c.type === "theme" && !c.archived)
    .map(c => ({ name: c.title, description: c.fields?.description || "" }));
}
function scenesFeaturingByName(state, charTitle) {
  return sceneList(state).filter(s => {
    const ids = s.fields?.characterIds || [];
    if (ids.length) {
      // characterIds may store names or ids — handle both
      return ids.some(x => x === charTitle || x === Array.from(state.cards.values()).find(c => c.title === charTitle)?.id);
    }
    const blob = ((s.fields?.shortDescription || "") + " " + (s.fields?.ragSummary || "") + " " + (s.fields?.longDescription || "")).toLowerCase();
    return blob.includes(charTitle.toLowerCase());
  });
}

function pickCharacter(c) {
  const f = c.fields || {};
  return {
    name: c.title,
    role: f.role,
    age: f.age,
    physicalDescription: f.physicalDescription,
    history: f.history || [],
    traits: f.traits || [],
    storyRoleSummary: f.storyRoleSummary || null
  };
}
function pickScene(s) {
  const f = s.fields || {};
  return {
    title: s.title,
    order: s.order ?? 0,
    shortDescription: f.shortDescription || "",
    ragSummary: f.ragSummary || "",
    characterIds: f.characterIds || [],
    locationIds: f.locationIds || [],
    arcIds: f.arcIds || []
  };
}

// ---------- Apply scene-gen result to Firestore ----------

export async function insertGeneratedScene(state, projectId, gen, position) {
  // position: { afterId } means insert right after that scene; otherwise append.
  // We'll set the new scene's order to be the average of neighboring orders,
  // then reflow.
  const ordered = sceneList(state);
  let order;
  if (position?.afterId) {
    const i = ordered.findIndex(s => s.id === position.afterId);
    if (i < 0) order = ordered.length;
    else if (i === ordered.length - 1) order = ordered[i].order + 1;
    else order = (ordered[i].order + ordered[i + 1].order) / 2;
  } else if (position?.beforeId) {
    const i = ordered.findIndex(s => s.id === position.beforeId);
    if (i <= 0) order = (ordered[0]?.order ?? 0) - 1;
    else order = (ordered[i].order + ordered[i - 1].order) / 2;
  } else {
    order = (ordered[ordered.length - 1]?.order ?? -1) + 1;
  }

  const characterIds = matchNamesToIds(state, "character", gen.suggestedCharacterNames || []);
  const locationIds  = matchNamesToIds(state, "location",  gen.suggestedLocationNames  || []);

  const data = {
    type: "scene",
    title: gen.title || "Untitled scene",
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    order,
    fields: {
      shortDescription: gen.shortDescription || "",
      longDescription:  gen.longDescription  || "",
      ragSummary: gen.shortDescription || null,
      ragSummaryStale: !!gen.longDescription,
      characterIds, locationIds, arcIds: []
    }
  };
  const ref = await addDoc(collection(db, "users", state.user.uid, "projects", projectId, "cards"), data);
  state.cards.set(ref.id, { id: ref.id, ...data });
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: ref.id, field: "created", oldValue: null,
    newValue: { type: "scene", title: data.title, source: "scene-gen" }
  }], state.project);
  return ref.id;
}

function matchNamesToIds(state, type, names) {
  const out = [];
  for (const n of names) {
    const card = [...state.cards.values()].find(c => c.type === type && !c.archived && c.title.toLowerCase() === n.toLowerCase());
    if (card) out.push(card.id);
  }
  return out;
}

// ---------- Apply arc summary edit + trigger tension analysis ----------

export async function saveArcSummary(state, projectId, arcId, newSummary) {
  const arc = state.cards.get(arcId);
  if (!arc) return;
  const old = arc.fields?.summary || "";
  arc.fields = arc.fields || {};
  arc.fields.summary = newSummary;
  arc.fields.summary_userEdited = true;
  arc.fields.summaryStale = false;
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", arcId), {
    "fields.summary": newSummary,
    "fields.summary_userEdited": true,
    "fields.summaryStale": false,
    updatedAt: serverTimestamp()
  });
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: arcId, field: "summary", oldValue: old, newValue: newSummary
  }], state.project);
}

// ---------- Apply trait suggestions ----------

export async function applyTraitSuggestions(state, projectId, characterId, suggestions) {
  const ch = state.cards.get(characterId);
  if (!ch) return;
  ch.fields = ch.fields || {};
  const traits = Array.isArray(ch.fields.traits) ? ch.fields.traits.slice() : [];
  const audits = [];
  for (const s of suggestions) {
    if (!s.text) continue;
    traits.push(s.text);
    audits.push({ entityType: "card", entityId: characterId, field: "traits", oldValue: null, newValue: s.text });
  }
  ch.fields.traits = traits;
  ch.fields.storyRoleSummaryStale = true;
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", characterId), {
    "fields.traits": traits,
    "fields.storyRoleSummaryStale": true,
    updatedAt: serverTimestamp()
  });
  if (audits.length) await logAudit(state.user.uid, projectId, audits, state.project);
}

// ---------- Review Panel UI ----------

export function renderReviewPanel(container, state, projectId, { onChanged }) {
  container.innerHTML = `
    <div class="review-header">
      <h2>Review Panel</h2>
      <div class="review-mode-tabs">
        <button class="review-tab active" data-mode="character" title="One character's journey across the story">Character Arc</button>
        <button class="review-tab" data-mode="synopsis" title="Story-level synopsis of everything">Synopsis</button>
        <button class="review-tab" data-mode="arcs" title="Per-subplot arc-card summaries with tension flagging">Subplot Arcs</button>
        <button class="review-tab" data-mode="theme" title="Where scenes and characters support or drift from the themes">Theme Coherence</button>
      </div>
      <p id="reviewModeBlurb" class="muted small review-blurb"></p>
    </div>
    <div id="reviewBody" class="review-body"></div>
  `;
  const body = container.querySelector("#reviewBody");
  const blurb = container.querySelector("#reviewModeBlurb");
  const tabs = container.querySelectorAll(".review-tab");
  const setBlurb = (mode) => {
    const blurbs = {
      character: "Pick a character. The model writes 2–4 paragraphs on their trajectory across the whole story: starting point, turning points, where they end up.",
      synopsis:  "A 3–5 paragraph story-level synopsis built from your themes, characters, and ordered scenes. Good for sanity-checking that the story communicates what you intend.",
      arcs:      "Each Arc card here represents a subplot or throughline. Edit its summary and save to ask the model which scenes now feel in tension with that arc.",
      theme:     "Which scenes and characters support each theme pillar, and which feel disconnected. Surfaces drift early."
    };
    blurb.textContent = blurbs[mode] || "";
  };
  tabs.forEach(t => t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    setBlurb(t.dataset.mode);
    renderReviewMode(body, state, projectId, t.dataset.mode, onChanged);
  }));
  setBlurb("character");
  renderReviewMode(body, state, projectId, "character", onChanged);
}

function renderReviewMode(body, state, projectId, mode, onChanged) {
  if (mode === "character")     return renderCharacterMode(body, state, projectId);
  if (mode === "synopsis")      return renderSynopsisMode(body, state);
  if (mode === "arcs")          return renderArcsMode(body, state, projectId, onChanged);
  if (mode === "theme")         return renderThemeMode(body, state);
}

function renderCharacterMode(body, state, projectId) {
  const chars = characterList(state);
  if (chars.length === 0) {
    body.innerHTML = `<p class="muted">No characters yet. Add some from the Graph view.</p>`;
    return;
  }
  body.innerHTML = `
    <label>Character
      <select id="reviewCharSel">
        ${chars.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join("")}
      </select>
    </label>
    <button id="runCharReview" class="primary">Run review</button>
    <div id="charReviewOut" class="review-output"></div>
  `;
  body.querySelector("#runCharReview").addEventListener("click", async () => {
    console.log("[review] character arc clicked");
    const id = body.querySelector("#reviewCharSel").value;
    const out = body.querySelector("#charReviewOut");
    const { ok, result: r } = await runLLMAction(
      "Reviewing character arc",
      () => reviewCharacterArc(state, id)
    );
    if (!ok || !r) { out.innerHTML = ""; return; }
    out.innerHTML = `<div class="review-prose">${proseToHtml(r.review || "")}</div>`;
  });
}

function renderSynopsisMode(body, state) {
  body.innerHTML = `
    <button id="runSynopsis" class="primary">Generate synopsis</button>
    <div id="synopsisOut" class="review-output"></div>
  `;
  body.querySelector("#runSynopsis").addEventListener("click", async () => {
    console.log("[review] synopsis clicked");
    const out = body.querySelector("#synopsisOut");
    const { ok, result: r } = await runLLMAction(
      "Generating synopsis",
      () => generateSynopsis(state)
    );
    if (!ok || !r) { out.innerHTML = ""; return; }
    out.innerHTML = `<div class="review-prose">${proseToHtml(r.synopsis || "")}</div>`;
  });
}

function renderArcsMode(body, state, projectId, onChanged) {
  const arcs = arcList(state);
  if (arcs.length === 0) {
    body.innerHTML = `<p class="muted">No arc cards yet. Add an Arc card from the Graph view, then tag scenes to it from the scene editor.</p>`;
    return;
  }
  body.innerHTML = `<div id="arcsList"></div>`;
  const list = body.querySelector("#arcsList");
  for (const arc of arcs) {
    const taggedScenes = sceneList(state).filter(s => (s.fields?.arcIds || []).includes(arc.id));
    const section = document.createElement("section");
    section.className = "arc-block";
    section.innerHTML = `
      <h3>${esc(arc.title)} <span class="muted small">(${taggedScenes.length} scene${taggedScenes.length===1?"":"s"})</span></h3>
      <label>Summary <textarea data-arc-id="${arc.id}" class="arc-summary-input" rows="4">${esc(arc.fields?.summary || "")}</textarea></label>
      <div class="arc-actions">
        <button class="primary small save-arc">Save & check tension</button>
      </div>
      <div class="arc-tension"></div>
    `;
    list.appendChild(section);

    section.querySelector(".save-arc").addEventListener("click", async () => {
      console.log("[review] save-arc clicked", { arcId: arc.id });
      const ta = section.querySelector(".arc-summary-input");
      const tensionBox = section.querySelector(".arc-tension");
      const newSummary = ta.value;
      try {
        await saveArcSummary(state, projectId, arc.id, newSummary);
      } catch (e) {
        alert("Saving arc summary failed: " + (e.message || e));
        return;
      }
      const { ok, result: r } = await runLLMAction(
        "Analyzing arc tension",
        () => analyzeArcTension(state, arc.id, newSummary)
      );
      if (!ok) return;
      if (!r || !r.tensions || r.tensions.length === 0) {
        tensionBox.innerHTML = `<p class="muted small">No scene tensions detected with the new summary.</p>`;
      } else {
        tensionBox.innerHTML = `
          <h4>Scenes in tension</h4>
          <ul class="tension-list">
            ${r.tensions.map(t => `
              <li>
                <div class="tension-scene"><strong>${esc(t.sceneTitle)}</strong></div>
                <div class="muted small">Problem: ${esc(t.problem)}</div>
                <div class="muted small">Suggestion: ${esc(t.suggestion)}</div>
              </li>
            `).join("")}
          </ul>
        `;
      }
      onChanged?.();
    });
  }
}

function renderThemeMode(body, state) {
  body.innerHTML = `
    <button id="runThemeCheck" class="primary">Run theme coherence check</button>
    <div id="themeOut" class="review-output"></div>
  `;
  body.querySelector("#runThemeCheck").addEventListener("click", async () => {
    console.log("[review] theme coherence clicked");
    const out = body.querySelector("#themeOut");
    const { ok, result: r } = await runLLMAction(
      "Analyzing theme coherence",
      () => themeCoherence(state)
    );
    if (!ok || !r) { out.innerHTML = ""; return; }
    const perTheme = (r.perTheme || []).map(t => `
        <section class="theme-block">
          <h3>${esc(t.theme)}</h3>
          ${t.supporting?.length ? `
            <h4>Supporting</h4>
            <ul>${t.supporting.map(x => `<li><strong>${esc(x.name)}</strong> <span class="muted small">(${esc(x.type)})</span> — ${esc(x.note)}</li>`).join("")}</ul>` : ""}
          ${t.disconnected?.length ? `
            <h4>Disconnected</h4>
            <ul class="disconnected">${t.disconnected.map(x => `<li><strong>${esc(x.name)}</strong> <span class="muted small">(${esc(x.type)})</span> — ${esc(x.note)}</li>`).join("")}</ul>` : ""}
        </section>
      `).join("");
    out.innerHTML = `${perTheme}<p class="review-overall"><strong>Overall:</strong> ${esc(r.overall || "")}</p>`;
  });
}

// ---------- Trait suggestion modal ----------

export function openTraitSuggestModal(suggestions, { onApply }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal approval-modal">
      <div class="modal-header">
        <h2>Trait suggestions</h2>
        <button class="ghost small close-modal">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted small">Pick the ones you want to add to this character's traits.</p>
        <div id="traitList"></div>
      </div>
      <div class="modal-actions">
        <button class="ghost cancel">Skip all</button>
        <button class="primary save">Add checked</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const list = overlay.querySelector("#traitList");
  if (!suggestions || suggestions.length === 0) {
    list.innerHTML = `<p class="muted">No suggestions came back.</p>`;
  } else {
    suggestions.forEach((s, idx) => {
      const row = document.createElement("label");
      row.className = "approval-row is-inference";
      row.innerHTML = `
        <input type="checkbox" data-idx="${idx}" />
        <div class="approval-content">
          <div class="approval-name"><strong>${esc(s.text)}</strong> <span class="muted small">(${esc(s.kind || "trait")})</span></div>
          <div class="muted small">${esc(s.rationale || "")}</div>
        </div>
      `;
      list.appendChild(row);
    });
  }
  const close = () => overlay.remove();
  overlay.querySelector(".close-modal").addEventListener("click", close);
  overlay.querySelector(".cancel").addEventListener("click", close);
  overlay.querySelector(".save").addEventListener("click", () => {
    const picked = [];
    list.querySelectorAll('input[type=checkbox]').forEach(cb => {
      if (cb.checked) picked.push(suggestions[parseInt(cb.dataset.idx, 10)]);
    });
    close();
    onApply?.(picked);
  });
}

// ---------- Scene proposal modal ----------

export function openSceneProposalModal(gen, { onAccept, onCancel }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal scene-proposal-modal">
      <div class="modal-header">
        <h2>Proposed scene</h2>
        <button class="ghost small close-modal">✕</button>
      </div>
      <div class="modal-body">
        <label>Title <input id="genTitle" value="${attr(gen.title || "")}" /></label>
        <label>Short description <textarea id="genShort" rows="3">${esc(gen.shortDescription || "")}</textarea></label>
        <label>Long description (optional) <textarea id="genLong" rows="4">${esc(gen.longDescription || "")}</textarea></label>
        <div class="proposal-meta">
          <p class="muted small"><strong>Why this fits:</strong> ${esc(gen.rationale || "")}</p>
          ${gen.suggestedCharacterNames?.length ? `<p class="muted small"><strong>Suggested characters:</strong> ${gen.suggestedCharacterNames.map(esc).join(", ")}</p>` : ""}
          ${gen.suggestedLocationNames?.length ? `<p class="muted small"><strong>Suggested locations:</strong> ${gen.suggestedLocationNames.map(esc).join(", ")}</p>` : ""}
        </div>
      </div>
      <div class="modal-actions">
        <button class="ghost cancel">Discard</button>
        <button class="primary accept">Insert scene</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".close-modal").addEventListener("click", () => { close(); onCancel?.(); });
  overlay.querySelector(".cancel").addEventListener("click", () => { close(); onCancel?.(); });
  overlay.querySelector(".accept").addEventListener("click", () => {
    const edited = {
      ...gen,
      title: overlay.querySelector("#genTitle").value.trim(),
      shortDescription: overlay.querySelector("#genShort").value.trim(),
      longDescription:  overlay.querySelector("#genLong").value.trim()
    };
    close();
    onAccept?.(edited);
  });
}

// ---------- Misc ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function attr(s) { return esc(s); }
function proseToHtml(text) {
  return esc(text).split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("");
}
