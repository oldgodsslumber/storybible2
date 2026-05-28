// LLM extraction flows: idea-dump extraction, side-panel note parsing,
// approval modal (extraction vs. inference), and gap-analysis wizard.

import { callLLM, parseJsonLoose, isConfigured } from "./llm.js";

// ---------- Prompts ----------

const EXTRACTION_SYSTEM = `You are an assistant for a story bible app. Your job is to read raw creative writing notes and identify story entities.

CRITICAL DISTINCTION:
- EXTRACTION: a fact stated directly in the text. ("Jack climbs towers" → Jack is a character; he climbs towers.)
- INFERENCE: something you deduced but the writer did not say. ("Jack is probably reckless" → inference.)

Be conservative. Prefer extraction over inference. When in doubt, mark as inference. Do not invent details.

Return ONLY a JSON object with this exact shape:
{
  "characters": [{"name": "...", "role": "", "traits": [], "history": [], "source": "extraction|inference", "rationale": "one short sentence"}],
  "locations":  [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "themes":     [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "connections":[{"from": "name", "to": "name", "label": "appears in|conflicts with|explores theme|...", "source": "extraction|inference", "rationale": "..."}]
}

- "name" values for connections must match a "name" field in characters/locations/themes you returned, or one of the existingEntities provided.
- Omit fields you have no data for (empty arrays/strings are fine).
- No prose outside the JSON.`;

const NOTE_PARSE_SYSTEM = `You are an assistant for a story bible app. The writer is dumping a freeform note into a side panel. You will receive the note and a list of existing entities in the project.

Your job: identify
1. NEW entities to add (characters, locations, themes)
2. UPDATES to existing entities (a new trait, a piece of history, a description change)
3. New CONNECTIONS between entities

Same EXTRACTION vs. INFERENCE rule applies: only mark "extraction" if the writer actually said it.

Return ONLY this JSON shape:
{
  "newCharacters": [{"name": "...", "role": "", "traits": [], "history": [], "source": "extraction|inference", "rationale": "..."}],
  "newLocations":  [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "newThemes":     [{"name": "...", "description": "", "source": "extraction|inference", "rationale": "..."}],
  "updates":       [{"entityName": "...", "entityType": "character|location|theme", "field": "traits|history|role|description", "addValue": "string or bullet text", "source": "extraction|inference", "rationale": "..."}],
  "connections":   [{"from": "name", "to": "name", "label": "...", "source": "extraction|inference", "rationale": "..."}]
}

No prose outside the JSON.`;

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
  const raw = await callLLM({ system: EXTRACTION_SYSTEM, user, expectJson: true });
  return parseJsonLoose(raw);
}

export async function parseSidePanelNote(noteText, existingEntities) {
  if (!isConfigured()) throw new Error("Configure an LLM provider in Settings first.");
  const summary = summarizeExistingEntities(existingEntities);
  const user = `Existing entities in this project:\n${summary}\n\nNew note from the writer:\n"""\n${noteText}\n"""\n\nReturn the JSON described in the system prompt.`;
  const raw = await callLLM({ system: NOTE_PARSE_SYSTEM, user, expectJson: true });
  return parseJsonLoose(raw);
}

export async function runGapAnalysis(themeText, extracted) {
  if (!isConfigured()) throw new Error("Configure an LLM provider in Settings first.");
  const user = `Idea dump:\n"""\n${themeText}\n"""\n\nExtracted so far:\n${JSON.stringify(extracted, null, 2)}\n\nReturn the JSON described in the system prompt.`;
  const raw = await callLLM({ system: GAP_ANALYSIS_SYSTEM, user, expectJson: true });
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
  // Normalize either idea-dump shape (characters/locations/themes/connections)
  // or note-parse shape (newCharacters/newLocations/newThemes/updates/connections).
  const characters = parsed.characters || parsed.newCharacters || [];
  const locations  = parsed.locations  || parsed.newLocations  || [];
  const themes     = parsed.themes     || parsed.newThemes     || [];
  const updates    = parsed.updates    || [];
  const connections = parsed.connections || [];
  return { characters, locations, themes, updates, connections };
}

function emptyApproved() {
  return { characters: [], locations: [], themes: [], updates: [], connections: [] };
}

function renderApproval(container, state) {
  container.innerHTML = "";
  const sections = [
    { key: "characters", label: "Characters", render: renderCharacter },
    { key: "locations",  label: "Locations",  render: renderLocation },
    { key: "themes",     label: "Themes",     render: renderTheme },
    { key: "updates",    label: "Updates to existing cards", render: renderUpdate },
    { key: "connections",label: "Connections", render: renderConnection }
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
function renderUpdate(u) {
  return `<div class="approval-name">Update <strong>${esc(u.entityName)}</strong> (${esc(u.entityType)})</div>
          <div class="small muted">${esc(u.field)}: ${esc(u.addValue)}</div>`;
}
function renderConnection(c) {
  return `<div class="approval-name"><strong>${esc(c.from)}</strong> → <strong>${esc(c.to)}</strong></div>
          <div class="small muted">${esc(c.label)}</div>`;
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
