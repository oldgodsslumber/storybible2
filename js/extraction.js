// LLM extraction flows: idea-dump extraction, side-panel note parsing,
// approval modal (extraction vs. inference), and gap-analysis wizard.

import { callLLM, parseJsonLoose, isConfigured } from "./llm.js";
import { buildProjectContext } from "./story-settings.js";

// State ref so extraction prompts can include project context.
let STATE_REF = null;
export function provideExtractionStateRef(stateObj) { STATE_REF = stateObj; }
function context() { return buildProjectContext(STATE_REF?.project); }

// ---------- Prompts ----------

const EXTRACTION_SYSTEM = `You are an assistant for a story bible app. Your job is to read raw creative writing notes and identify story entities AND project-level metadata.

CRITICAL DISTINCTION:
- EXTRACTION: a fact stated directly in the text. ("Jack climbs towers" → Jack is a character; he climbs towers.)
- INFERENCE: something you deduced but the writer did not say. ("Jack is probably reckless" → inference.)

Be conservative. Prefer extraction over inference. When in doubt, mark as inference. Do not invent details.

You will also propose values for Story Settings — project-level metadata:
- genre: short phrase describing the genre / setting ("modern science fiction", "noir thriller", "high fantasy", etc.)
- premise: one-sentence high-concept hook
- anchorConcepts: proper-noun terms the writer coined that should always be referred to by that exact name (e.g. "Curtain Fall" — the giant stormcloud covering the United States). Treat ALL-CAPS or quoted proper nouns as strong candidates.

And BEATS — structural moments larger than a single scene but smaller than an ongoing subplot:
- A beat is a discrete turning point: "the inciting incident", "the midpoint reversal", "the dark night of the soul", "Act 2 turn", "climax", "denouement".
- A beat is NOT a scene (the smallest unit) and NOT an arc (the long throughline). When the writer describes a major moment that organizes several potential scenes, that's a beat.
- If the writer explicitly lists beats or uses words like "the midpoint", "the climax", "inciting incident", "Act 2 turn", or describes structural turning points, propose them as beats with a structurePosition tag.

And SCENES — the smallest atomic moments. A scene is one continuous event in one location. If the writer describes a specific moment, encounter, conversation, or action set-piece, propose it as a scene.

For BOTH scenes and beats, include a "columnHint" — the column ID from the Outline columns list in the PROJECT CONTEXT above. Match the writer's words ("during the prologue" → prologue; "in Act 3" → act-3; "after the story ends" → epilogue). If unclear, use the default main column shown in PROJECT CONTEXT.

Return ONLY a JSON object with this exact shape:
{
  "characters": [{"name": "...", "role": "", "traits": [], "history": [], "source": "extraction|inference", "rationale": "one short sentence"}],
  "locations":  [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "themes":     [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "scenes":     [{"name": "...", "shortDescription": "...", "longDescription": "", "columnHint": "act-1|prologue|...", "source": "extraction|inference", "rationale": "..."}],
  "beats":      [{"name": "...", "description": "...", "structurePosition": "Inciting Incident|Midpoint|Climax|...", "columnHint": "act-1|prologue|...", "source": "extraction|inference", "rationale": "..."}],
  "storySettings": {
    "genre":   {"value": "...", "source": "extraction|inference", "rationale": "..."},
    "premise": {"value": "...", "source": "extraction|inference", "rationale": "..."},
    "anchorConcepts": [{"term": "...", "definition": "...", "source": "extraction|inference", "rationale": "..."}]
  },
  "connections":[{"from": "name", "to": "name", "label": "appears in|conflicts with|explores theme|...", "source": "extraction|inference", "rationale": "..."}]
}

- "name" values for connections must match a "name" field in any of the entity arrays you returned, or one of the existingEntities provided.
- For storySettings: if you have no signal at all for a field, omit it (or set "value": ""). Don't fabricate to fill slots.
- columnHint must be one of the column IDs listed in PROJECT CONTEXT. If none of the columns fit, use the default main column shown there.
- No prose outside the JSON.`;

const NOTE_PARSE_SYSTEM = `You are an assistant for a story bible app. The writer is dumping a freeform note into a side panel. You will receive the note and a list of existing entities in the project.

Your job: identify
1. NEW entities to add (characters, locations, themes, scenes, beats)
2. UPDATES to existing entities (a new trait, a piece of history, a description change)
3. New CONNECTIONS between entities
4. STORY SETTINGS proposals — if the note clarifies the project's genre, premise, or introduces a new anchor concept (proper-noun term that should always be referred to by that exact name), propose them.

A SCENE is the smallest unit — one continuous moment in one location. ("Jack confronts Sara on the rooftop" → scene.)
A BEAT is a structural moment between a single scene and an ongoing subplot — "the inciting incident", "the midpoint", "the climax", "Act 2 turn". If the writer describes a major plot pivot that organizes several scenes (rather than a single moment-to-moment scene), propose it as a beat with a structurePosition tag.

For BOTH new scenes and new beats, include a "columnHint" — the column ID from the Outline columns list in the PROJECT CONTEXT above. Match the writer's words ("during the prologue" → prologue; "in Act 3" → act-3; "after the story ends" → epilogue; "in the midpoint of the second act" → the act containing the midpoint, usually act-2 or act-3). If unclear, use the default main column shown in PROJECT CONTEXT.

Same EXTRACTION vs. INFERENCE rule applies: only mark "extraction" if the writer actually said it.

Return ONLY this JSON shape:
{
  "newCharacters": [{"name": "...", "role": "", "traits": [], "history": [], "source": "extraction|inference", "rationale": "..."}],
  "newLocations":  [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "newThemes":     [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "newScenes":     [{"name": "...", "shortDescription": "...", "longDescription": "", "columnHint": "act-1|prologue|...", "source": "extraction|inference", "rationale": "..."}],
  "newBeats":      [{"name": "...", "description": "...", "structurePosition": "...", "columnHint": "act-1|prologue|...", "source": "extraction|inference", "rationale": "..."}],
  "updates":       [{"entityName": "...", "entityType": "character|location|theme|beat|scene", "field": "traits|history|role|description|structurePosition|shortDescription|longDescription", "addValue": "string or bullet text", "source": "extraction|inference", "rationale": "..."}],
  "storySettings": {
    "genre":   {"value": "...", "source": "extraction|inference", "rationale": "..."},
    "premise": {"value": "...", "source": "extraction|inference", "rationale": "..."},
    "anchorConcepts": [{"term": "...", "definition": "...", "source": "extraction|inference", "rationale": "..."}]
  },
  "connections":   [{"from": "name", "to": "name", "label": "...", "source": "extraction|inference", "rationale": "..."}]
}

- Omit storySettings fields you have no signal for. Don't invent a genre.
- columnHint must be one of the column IDs listed in PROJECT CONTEXT. If you can't tell which column fits, use the default main column shown there.
- No prose outside the JSON.`;

const GAP_ANALYSIS_SYSTEM = `You are an assistant for a story bible app. The writer has provided an idea dump and the system has extracted some entities. Your job is to ask the writer 3–7 short, specific questions that fill the most important narrative gaps.

Rules:
- Tailor every question to the actual story content. NO generic questions like "what is your story about?" — that's already been answered.
- One question at a time, in the order you return.
- For theme/pillar questions, offer 4–6 short option chips the writer can pick from.
- Mark each question with its target field so the answer can be applied.

Return ONLY this JSON shape:
{
  "questions": [
    {
      "id": "q1",
      "question": "short, specific question",
      "kind": "free-text" | "chips",
      "options": ["chip1","chip2",...],          // only if kind=chips
      "targetEntityName": "Jack" | null,         // who/what this is about
      "targetEntityType": "character|theme|location|project" | null,
      "targetField": "traits|history|role|description|pillars|logline" | null,
      "rationale": "why I'm asking (one sentence)"
    }
  ]
}

No prose outside the JSON.`;

// ---------- LLM-callable flows ----------

export async function extractFromIdeaDump(themeText) {
  if (!isConfigured()) throw new Error("Configure an LLM provider in Settings first.");
  const user = `Idea dump:\n"""\n${themeText}\n"""\n\nReturn the JSON described in the system prompt.`;
  const raw = await callLLM({ system: context() + EXTRACTION_SYSTEM, user, expectJson: true });
  return parseJsonLoose(raw);
}

export async function parseSidePanelNote(noteText, existingEntities) {
  if (!isConfigured()) throw new Error("Configure an LLM provider in Settings first.");
  const summary = summarizeExistingEntities(existingEntities);
  const user = `Existing entities in this project:\n${summary}\n\nNew note from the writer:\n"""\n${noteText}\n"""\n\nReturn the JSON described in the system prompt.`;
  const raw = await callLLM({ system: context() + NOTE_PARSE_SYSTEM, user, expectJson: true });
  return parseJsonLoose(raw);
}

export async function runGapAnalysis(themeText, extracted) {
  if (!isConfigured()) throw new Error("Configure an LLM provider in Settings first.");
  const user = `Idea dump:\n"""\n${themeText}\n"""\n\nExtracted so far:\n${JSON.stringify(extracted, null, 2)}\n\nReturn the JSON described in the system prompt.`;
  const raw = await callLLM({ system: context() + GAP_ANALYSIS_SYSTEM, user, expectJson: true });
  return parseJsonLoose(raw);
}

function summarizeExistingEntities(entities) {
  if (!entities || entities.length === 0) return "(none)";
  return entities.map(e => `- [${e.type}] ${e.title}${e.role ? ` — ${e.role}` : ""}`).join("\n");
}

// ---------- Approval Modal ----------
// Shows extracted + inferred items grouped. Extracted are pre-checked,
// inferred require explicit checkbox. Resolves to the user-approved subset.

export function openApprovalModal(parsed, { title = "Review extracted items", onApprove }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal approval-modal">
      <div class="modal-header">
        <h2>${esc(title)}</h2>
        <button class="ghost small close-modal" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted small">
          <strong>Extraction</strong> items are taken directly from your text.
          <strong>Inference</strong> items are guesses — uncheck any you don't want.
        </p>
        <div id="approvalBody"></div>
      </div>
      <div class="modal-actions">
        <button class="ghost cancel">Skip all</button>
        <button class="primary save">Add checked items</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#approvalBody");
  const state = collectApprovalItems(parsed);
  renderApproval(body, state);

  const close = () => overlay.remove();
  overlay.querySelector(".close-modal").addEventListener("click", close);
  overlay.querySelector(".cancel").addEventListener("click", () => { close(); onApprove?.(emptyApproved()); });
  overlay.addEventListener("click", e => { if (e.target === overlay) { close(); onApprove?.(emptyApproved()); } });

  overlay.querySelector(".save").addEventListener("click", () => {
    const approved = readApproval(body, state);
    close();
    onApprove?.(approved);
  });
}

function collectApprovalItems(parsed) {
  // Normalize either idea-dump shape (characters/locations/themes/scenes/beats/connections)
  // or note-parse shape (newCharacters/newLocations/newThemes/newScenes/newBeats/updates/connections).
  const characters = parsed.characters || parsed.newCharacters || [];
  const locations  = parsed.locations  || parsed.newLocations  || [];
  const themes     = parsed.themes     || parsed.newThemes     || [];
  const scenes     = parsed.scenes     || parsed.newScenes     || [];
  const beats      = parsed.beats      || parsed.newBeats      || [];
  const updates    = parsed.updates    || [];
  const connections = parsed.connections || [];
  // Story Settings — flatten into a single section of pickable items.
  const storySettings = [];
  const ss = parsed.storySettings || {};
  if (ss.genre && ss.genre.value) {
    storySettings.push({
      _ssField: "genre",
      label: "Genre / setting",
      value: ss.genre.value,
      source: ss.genre.source || "inference",
      rationale: ss.genre.rationale || ""
    });
  }
  if (ss.premise && ss.premise.value) {
    storySettings.push({
      _ssField: "premise",
      label: "Premise",
      value: ss.premise.value,
      source: ss.premise.source || "inference",
      rationale: ss.premise.rationale || ""
    });
  }
  for (const a of (ss.anchorConcepts || [])) {
    if (!a.term) continue;
    storySettings.push({
      _ssField: "anchor",
      term: a.term,
      definition: a.definition || "",
      source: a.source || "extraction",
      rationale: a.rationale || ""
    });
  }
  return { characters, locations, themes, scenes, beats, updates, connections, storySettings };
}

function emptyApproved() {
  return { characters: [], locations: [], themes: [], scenes: [], beats: [], updates: [], connections: [], storySettings: [] };
}

function renderApproval(container, state) {
  container.innerHTML = "";
  const sections = [
    { key: "storySettings", label: "Story Settings", render: renderStorySetting },
    { key: "characters",    label: "Characters",     render: renderCharacter },
    { key: "beats",         label: "Beats",          render: renderBeat },
    { key: "scenes",        label: "Scenes",         render: renderScene },
    { key: "locations",     label: "Locations",      render: renderLocation },
    { key: "themes",        label: "Themes",         render: renderTheme },
    { key: "updates",       label: "Updates to existing cards", render: renderUpdate },
    { key: "connections",   label: "Connections",    render: renderConnection }
  ];
  let anyItems = false;
  for (const sec of sections) {
    const items = state[sec.key];
    if (!items || items.length === 0) continue;
    anyItems = true;
    const grp = document.createElement("section");
    grp.className = "approval-group";
    grp.innerHTML = `<h3>${esc(sec.label)}</h3>`;
    items.forEach((item, idx) => {
      const isExtraction = (item.source || "extraction") === "extraction";
      const row = document.createElement("label");
      row.className = "approval-row " + (isExtraction ? "is-extraction" : "is-inference");
      row.innerHTML = `
        <input type="checkbox" data-section="${sec.key}" data-idx="${idx}" ${isExtraction ? "checked" : ""} />
        <div class="approval-content">
          ${sec.render(item)}
          <div class="approval-meta">
            <span class="source-tag ${isExtraction ? "extraction" : "inference"}">${isExtraction ? "extraction" : "inference"}</span>
            ${item.rationale ? `<span class="muted small"> — ${esc(item.rationale)}</span>` : ""}
          </div>
        </div>
      `;
      grp.appendChild(row);
    });
    container.appendChild(grp);
  }
  if (!anyItems) {
    container.innerHTML = `<p class="muted">Nothing to add. The text didn't surface any new entities.</p>`;
  }
}

function readApproval(container, state) {
  const out = emptyApproved();
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (!cb.checked) return;
    const sec = cb.dataset.section;
    const idx = parseInt(cb.dataset.idx, 10);
    out[sec].push(state[sec][idx]);
  });
  return out;
}

function renderCharacter(c) {
  const traits = (c.traits || []).join(", ");
  const history = (c.history || []).join("; ");
  return `<div class="approval-name"><strong>${esc(c.name)}</strong>${c.role ? ` — ${esc(c.role)}` : ""}</div>
          ${traits ? `<div class="small muted">Traits: ${esc(traits)}</div>` : ""}
          ${history ? `<div class="small muted">History: ${esc(history)}</div>` : ""}`;
}
function renderLocation(l) {
  return `<div class="approval-name"><strong>${esc(l.name)}</strong></div>
          ${l.description ? `<div class="small muted">${esc(l.description)}</div>` : ""}`;
}
function renderTheme(t) {
  return `<div class="approval-name"><strong>${esc(t.name)}</strong></div>
          ${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ""}`;
}
function renderBeat(b) {
  const col = b.columnHint ? ` → column ${esc(b.columnHint)}` : "";
  return `<div class="approval-name"><strong>${esc(b.name)}</strong>${b.structurePosition ? ` <span class="muted small">— ${esc(b.structurePosition)}</span>` : ""}<span class="muted small">${col}</span></div>
          ${b.description ? `<div class="small muted">${esc(b.description)}</div>` : ""}`;
}
function renderScene(s) {
  const col = s.columnHint ? ` → column ${esc(s.columnHint)}` : "";
  return `<div class="approval-name"><strong>${esc(s.name)}</strong><span class="muted small">${col}</span></div>
          ${s.shortDescription ? `<div class="small muted">${esc(s.shortDescription)}</div>` : ""}`;
}
function renderUpdate(u) {
  return `<div class="approval-name">Update <strong>${esc(u.entityName)}</strong> (${esc(u.entityType)})</div>
          <div class="small muted">${esc(u.field)}: ${esc(u.addValue)}</div>`;
}
function renderConnection(c) {
  return `<div class="approval-name"><strong>${esc(c.from)}</strong> → <strong>${esc(c.to)}</strong></div>
          <div class="small muted">${esc(c.label)}</div>`;
}
function renderStorySetting(s) {
  if (s._ssField === "anchor") {
    return `<div class="approval-name">Anchor term: <strong>${esc(s.term)}</strong></div>
            <div class="small muted">${esc(s.definition)}</div>`;
  }
  return `<div class="approval-name"><strong>${esc(s.label)}</strong></div>
          <div class="small muted">${esc(s.value)}</div>`;
}

// ---------- Gap-Analysis Wizard ----------
// Shows one question at a time. User can answer or skip.
// Resolves to {answers: [{question, answer, ...question fields}]}.

export function openWizardModal(questions, { onComplete }) {
  if (!questions || questions.length === 0) {
    onComplete?.({ answers: [] });
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal wizard-modal">
      <div class="modal-header">
        <h2>A few questions</h2>
        <button class="ghost small close-modal">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted small">Skip any you'd rather not answer now. Your answers become bullets on the relevant cards.</p>
        <div class="wizard-progress"><span id="wizardProgress"></span></div>
        <div id="wizardSlot"></div>
      </div>
      <div class="modal-actions">
        <button class="ghost skip">Skip</button>
        <button class="primary next">Next</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const state = { i: 0, answers: [] };
  const slot = overlay.querySelector("#wizardSlot");
  const progressEl = overlay.querySelector("#wizardProgress");
  const nextBtn = overlay.querySelector(".next");
  const skipBtn = overlay.querySelector(".skip");

  const render = () => {
    const q = questions[state.i];
    progressEl.textContent = `Question ${state.i + 1} of ${questions.length}`;
    slot.innerHTML = `
      <p class="wizard-question">${esc(q.question)}</p>
      ${q.rationale ? `<p class="muted small">${esc(q.rationale)}</p>` : ""}
      ${q.kind === "chips"
        ? `<div class="chip-group">${(q.options || []).map(o => `<button type="button" class="chip" data-val="${attr(o)}">${esc(o)}</button>`).join("")}</div>
           <input class="wizard-input" id="wizardChipText" placeholder="…or type your own" />`
        : `<textarea class="wizard-input" id="wizardText" rows="4" placeholder="Type your answer…"></textarea>`
      }
    `;
    if (q.kind === "chips") {
      const chipText = slot.querySelector("#wizardChipText");
      slot.querySelectorAll(".chip").forEach(b => {
        b.addEventListener("click", () => {
          slot.querySelectorAll(".chip").forEach(x => x.classList.remove("selected"));
          b.classList.add("selected");
          chipText.value = b.dataset.val;
        });
      });
    }
    nextBtn.textContent = state.i === questions.length - 1 ? "Done" : "Next";
  };

  const readAnswer = () => {
    const q = questions[state.i];
    if (q.kind === "chips") return slot.querySelector("#wizardChipText").value.trim();
    return slot.querySelector("#wizardText").value.trim();
  };

  const advance = (answerStr) => {
    const q = questions[state.i];
    if (answerStr) state.answers.push({ ...q, answer: answerStr });
    state.i++;
    if (state.i >= questions.length) {
      overlay.remove();
      onComplete?.({ answers: state.answers });
      return;
    }
    render();
  };

  nextBtn.addEventListener("click", () => advance(readAnswer()));
  skipBtn.addEventListener("click", () => advance(""));
  overlay.querySelector(".close-modal").addEventListener("click", () => { overlay.remove(); onComplete?.({ answers: state.answers }); });

  render();
}

// ---------- Helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function attr(s) { return esc(s); }
