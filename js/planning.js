// Story-planning aids built on the Outline:
//   1. Scene function — what each scene DOES (POV, goal, conflict, outcome,
//      what changes, value shift). Filled by hand or by the LLM; never
//      overwritten by it. Lets the Outline flag scenes where nothing turns.
//   2. Structure checklist — the beats the project's chosen structure expects,
//      matched against the writer's beat cards, with one-click placeholders,
//      a rough pacing check per column, and an optional LLM structure review.

import { callLLMJson } from "./llm.js?v=20261025";
import { buildProjectContext, getColumnsForProject, getStorySettings, sortScenesByOutline } from "./story-settings.js?v=20261025";

// ---------------------------------------------------------------------------
// Scene function
// ---------------------------------------------------------------------------

export const VALUE_SHIFTS = [
  { id: "up",    icon: "▲", label: "Ends better" },
  { id: "down",  icon: "▼", label: "Ends worse" },
  { id: "mixed", icon: "⇅", label: "Reversal / mixed" },
  { id: "flat",  icon: "●", label: "Nothing changes" }
];
export const SCENE_FUNCTION_FIELDS = ["goal", "conflict", "outcome", "change"];

export function valueShiftInfo(id) { return VALUE_SHIFTS.find(v => v.id === id) || null; }

// A scene counts as "analysed" once it has a value shift or any function text.
export function hasSceneFunction(f) {
  return !!(f?.valueShift || SCENE_FUNCTION_FIELDS.some(k => (f?.[k] || "").trim()));
}

// The editor block. Field inputs carry data-field so the card editor's
// normal save-on-blur/change wiring persists them.
export function sceneFunctionEditorHtml(card, state, esc) {
  const f = card.fields || {};
  const chars = [...state.cards.values()]
    .filter(c => c.type === "character" && !c.archived)
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  const opt = (value, label, current) => `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
  return `
    <details class="scene-function"${hasSceneFunction(f) ? " open" : ""}>
      <summary>What this scene does</summary>
      <p class="muted small">Every scene should turn something. If you can't name the goal, the conflict and what's different by the end, the scene may be doing no work.</p>
      <label>Point of view
        <select data-field="povCharacterId">
          ${opt("", "— none —", f.povCharacterId || "")}
          ${chars.map(c => opt(c.id, c.title || "(untitled)", f.povCharacterId || "")).join("")}
        </select>
      </label>
      <label>Goal <span class="muted small">— what does the POV character want here?</span>
        <textarea data-field="goal" rows="2">${esc(f.goal || "")}</textarea></label>
      <label>Conflict <span class="muted small">— what stands in the way?</span>
        <textarea data-field="conflict" rows="2">${esc(f.conflict || "")}</textarea></label>
      <label>Outcome <span class="muted small">— how does it end?</span>
        <textarea data-field="outcome" rows="2">${esc(f.outcome || "")}</textarea></label>
      <label>What changes <span class="muted small">— what's different by the end?</span>
        <textarea data-field="change" rows="2">${esc(f.change || "")}</textarea></label>
      <label>Value shift
        <select data-field="valueShift">
          ${opt("", "— not set —", f.valueShift || "")}
          ${VALUE_SHIFTS.map(v => opt(v.id, `${v.icon} ${v.label}`, f.valueShift || "")).join("")}
        </select>
      </label>
      <button type="button" class="ghost small fill-scene-function">✨ Fill empty fields from the description</button>
    </details>
  `;
}

// Small badges for the Outline card.
export function sceneFunctionBadgesHtml(card, state, esc) {
  const f = card.fields || {};
  const bits = [];
  const pov = f.povCharacterId ? state.cards.get(f.povCharacterId) : null;
  if (pov && !pov.archived) bits.push(`<span class="sf-chip" title="Point of view">👁 ${esc(pov.title)}</span>`);
  const shift = valueShiftInfo(f.valueShift);
  if (shift) {
    bits.push(`<span class="sf-chip sf-shift sf-${shift.id}" title="${esc(shift.label)}">${shift.icon}${shift.id === "flat" ? " nothing changes" : ""}</span>`);
  }
  return bits.length ? `<div class="sf-chips">${bits.join("")}</div>` : "";
}

const SCENE_FUNCTION_SYSTEM = `You are a story editor for a story bible app. For each scene you are given, identify what the scene DOES dramatically:
- povCharacter: the name of the point-of-view character (must be one of the listed character names, or "" if unclear)
- goal: what the POV character wants in this scene (one sentence)
- conflict: what opposes that goal (one sentence)
- outcome: how the scene ends for the goal (one sentence)
- change: what is different at the end of the scene compared to the start (one sentence)
- valueShift: "up" if things end better for the POV character than they started, "down" if worse, "mixed" if it reverses or is bittersweet, "flat" if nothing meaningfully changes

Base everything on the scene text. Do NOT invent events. If the scene text is too thin to tell, use "" for that field — an honest blank beats a guess. "flat" is a valid, useful answer: it tells the writer the scene may not be earning its place.

Return ONLY this JSON:
{ "scenes": [ { "key": "the key you were given", "povCharacter": "", "goal": "", "conflict": "", "outcome": "", "change": "", "valueShift": "up|down|mixed|flat|" } ] }`;

// Ask the LLM for the function of each scene. Returns
// [{ sceneId, patch }] where patch holds ONLY fields that are currently empty
// on the card — the writer's own words are never replaced.
export async function analyzeSceneFunctions(state, scenes, { signal } = {}) {
  const characters = [...state.cards.values()].filter(c => c.type === "character" && !c.archived);
  const charByName = new Map(characters.map(c => [(c.title || "").trim().toLowerCase(), c.id]));
  const out = [];
  const BATCH = 8;
  for (let i = 0; i < scenes.length; i += BATCH) {
    const slice = scenes.slice(i, i + BATCH);
    const payload = {
      characters: characters.map(c => c.title),
      scenes: slice.map((s, j) => ({
        key: String(i + j + 1),
        title: s.title,
        shortDescription: s.fields?.shortDescription || "",
        longDescription: s.fields?.longDescription || "",
        taggedCharacters: (s.fields?.characterIds || []).map(id => state.cards.get(id)?.title).filter(Boolean)
      }))
    };
    const res = await callLLMJson({
      system: buildProjectContext(state.project) + SCENE_FUNCTION_SYSTEM,
      user: `Scenes:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON described in the system prompt.`,
      signal
    });
    const rows = Array.isArray(res?.scenes) ? res.scenes : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const idx = parseInt(row.key, 10) - 1 - i;
      const scene = slice[idx];
      if (!scene) continue;
      const f = scene.fields || {};
      const patch = {};
      for (const k of SCENE_FUNCTION_FIELDS) {
        const v = typeof row[k] === "string" ? row[k].trim() : "";
        if (v && !(f[k] || "").trim()) patch[k] = v;
      }
      if (!f.valueShift && valueShiftInfo(row.valueShift)) patch.valueShift = row.valueShift;
      const povId = charByName.get(String(row.povCharacter || "").trim().toLowerCase());
      if (!f.povCharacterId && povId) patch.povCharacterId = povId;
      if (Object.keys(patch).length) out.push({ sceneId: scene.id, patch });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structure templates
// ---------------------------------------------------------------------------
// Expected beats per structure: the column they usually live in, a rough
// position in the story (%), a one-line description, and other names writers
// use for the same beat (for matching existing beat cards).

const B = (name, column, at, description, aliases = []) => ({ name, column, at, description, aliases });

export const STRUCTURE_BEATS = {
  "story-bible-default": [
    B("Inciting Incident", "act-1", 10, "The event that disrupts the normal world and sets the story moving.", ["catalyst", "call to adventure", "inciting"]),
    B("Lock-in", "act-1", 25, "The protagonist commits to the goal — there's no going back.", ["plot point 1", "first plot point", "break into two", "break into act 2", "point of no return", "first turning point"]),
    B("Midpoint", "act-3", 50, "A false victory or false defeat that raises the stakes and turns the protagonist from reacting to acting.", ["mid-point", "midpoint reversal", "false victory", "false defeat"]),
    B("All Is Lost", "act-4", 75, "The lowest point: the plan has failed and things are as bad as they can be.", ["crisis", "dark night of the soul", "plot point 2", "second plot point", "low point"]),
    B("Climax", "act-5", 90, "The final confrontation, where the protagonist uses what they've learned.", ["final battle", "showdown", "finale"]),
    B("Resolution", "act-6", 98, "The new normal — show how the protagonist and their world have changed.", ["denouement", "dénouement", "final image", "aftermath"])
  ],
  "3-act": [
    B("Inciting Incident", "act-1", 10, "The event that disrupts the normal world.", ["catalyst", "call to adventure", "inciting"]),
    B("Plot Point 1", "act-1", 25, "The protagonist commits to the journey; Act 2 begins.", ["first plot point", "lock-in", "break into two", "point of no return"]),
    B("Midpoint", "act-2", 50, "A reversal that raises the stakes.", ["mid-point", "false victory", "false defeat"]),
    B("Plot Point 2", "act-2", 75, "The lowest point that launches the final act.", ["second plot point", "all is lost", "crisis", "dark night of the soul"]),
    B("Climax", "act-3", 90, "The decisive confrontation.", ["finale", "showdown"]),
    B("Resolution", "act-3", 98, "The aftermath and new normal.", ["denouement", "dénouement", "final image"])
  ],
  "5-act": [
    B("Inciting Moment", "act-1", 10, "The force that sets the conflict in motion.", ["inciting incident", "exciting force", "catalyst"]),
    B("Complication", "act-2", 30, "Obstacles mount and tension rises.", ["rising action", "rising"]),
    B("Climax", "act-3", 50, "The turning point of the drama.", ["turning point", "crisis"]),
    B("Reversal", "act-4", 70, "Consequences of the climax play out against the protagonist.", ["falling action", "peripeteia"]),
    B("Moment of Final Suspense", "act-4", 80, "A last doubt about the outcome before the end.", ["final suspense", "last chance"]),
    B("Dénouement", "act-5", 95, "The resolution — or catastrophe — that closes the story.", ["denouement", "catastrophe", "resolution"])
  ],
  "save-the-cat": [
    B("Opening Image", "act-1", 1, "A snapshot of the hero's world before the story.", []),
    B("Theme Stated", "act-1", 5, "Someone states what the story is really about.", []),
    B("Set-Up", "act-1", 5, "The hero's world, flaws and what needs fixing.", ["setup"]),
    B("Catalyst", "act-2", 10, "The life-changing event.", ["inciting incident"]),
    B("Debate", "act-2", 15, "The hero hesitates — should I go?", []),
    B("Break Into Two", "act-3", 20, "The hero chooses to act and enters a new world.", ["break into 2", "plot point 1", "lock-in"]),
    B("B Story", "act-3", 22, "A secondary story (often a relationship) that carries the theme.", ["b-story"]),
    B("Fun and Games", "act-3", 35, "The promise of the premise — the trailer moments.", ["fun & games"]),
    B("Midpoint", "act-4", 50, "False victory or false defeat; stakes go up.", ["mid-point"]),
    B("Bad Guys Close In", "act-4", 62, "Pressure mounts from outside and doubt from inside.", []),
    B("All Is Lost", "act-5", 75, "The lowest point; often a 'whiff of death'.", ["crisis"]),
    B("Dark Night of the Soul", "act-5", 78, "The hero wallows before finding the answer.", ["dark night"]),
    B("Break Into Three", "act-6", 80, "The solution — A and B stories combine.", ["break into 3", "plot point 2"]),
    B("Finale", "act-6", 90, "The hero applies the lesson and wins (or loses) the day.", ["climax"]),
    B("Final Image", "act-6", 99, "The mirror of the opening image — proof of change.", ["closing image"])
  ],
  "heros-journey": [
    B("Ordinary World", "act-1", 2, "The hero's normal life before the adventure.", []),
    B("Call to Adventure", "act-1", 8, "A challenge or problem appears.", ["inciting incident", "catalyst"]),
    B("Refusal of the Call", "act-1", 12, "The hero hesitates or refuses.", ["refusal"]),
    B("Meeting the Mentor", "act-1", 17, "Guidance, a gift or training.", ["mentor"]),
    B("Crossing the Threshold", "act-1", 25, "The hero commits and enters the special world.", ["first threshold", "lock-in", "plot point 1"]),
    B("Tests, Allies, Enemies", "act-2", 35, "The hero learns the rules of the new world.", ["tests allies enemies", "tests"]),
    B("Approach to the Inmost Cave", "act-2", 45, "Preparing for the central ordeal.", ["approach", "inmost cave"]),
    B("The Ordeal", "act-2", 55, "The central life-or-death crisis.", ["ordeal", "midpoint"]),
    B("Reward", "act-2", 65, "The hero seizes the sword — something gained.", ["seizing the sword"]),
    B("The Road Back", "act-3", 75, "The hero heads home, often pursued.", ["road back"]),
    B("Resurrection", "act-3", 90, "A final test where everything is at stake.", ["climax"]),
    B("Return with the Elixir", "act-3", 98, "The hero returns changed, bringing something to share.", ["elixir", "return"])
  ],
  "kishotenketsu": [
    B("Ki — Introduction", "act-1", 10, "Introduce the characters and setting.", ["ki", "introduction"]),
    B("Shō — Development", "act-2", 35, "Develop what was introduced, without conflict-driven escalation.", ["sho", "shō", "development"]),
    B("Ten — Twist", "act-3", 65, "An unexpected turn that recontextualises everything.", ["ten", "twist"]),
    B("Ketsu — Reconciliation", "act-4", 90, "Bring the elements together into a new understanding.", ["ketsu", "conclusion", "reconciliation"])
  ],
  "free": []
};

// Rough expected share of scenes per main column (%), for the pacing check.
const COLUMN_WEIGHTS = {
  "story-bible-default": { "act-1": 25, "act-2": 20, "act-3": 10, "act-4": 15, "act-5": 10, "act-6": 20 },
  "3-act":               { "act-1": 25, "act-2": 50, "act-3": 25 },
  "5-act":               { "act-1": 20, "act-2": 20, "act-3": 20, "act-4": 20, "act-5": 20 },
  "save-the-cat":        { "act-1": 10, "act-2": 10, "act-3": 30, "act-4": 25, "act-5": 5, "act-6": 20 },
  "heros-journey":       { "act-1": 25, "act-2": 50, "act-3": 25 },
  "kishotenketsu":       { "act-1": 25, "act-2": 25, "act-3": 25, "act-4": 25 }
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Match the project's beat cards to the structure's expected beats.
// A card matches when its structure position or title names the beat (or an
// alias). Each card fills at most one slot; exact names win over aliases.
export function structureStatus(state) {
  const structure = getStorySettings(state.project).structure;
  const expected = STRUCTURE_BEATS[structure] || [];
  const columns = getColumnsForProject(state.project);
  const colLabel = (id) => columns.find(c => c.id === id)?.label || id;
  const beats = [...state.cards.values()].filter(c => c.type === "beat" && !c.archived);
  const used = new Set();
  const names = (b) => [norm(b.fields?.structurePosition), norm(b.title)].filter(Boolean);
  const findCard = (exp, aliasesToo) => beats.find(b => !used.has(b.id) && names(b).some(n => {
    const targets = [norm(exp.name), ...(aliasesToo ? exp.aliases.map(norm) : [])];
    return targets.some(t => n === t || (t.length > 3 && (n.includes(t) || t.includes(n) && n.length > 3)));
  }));
  const rows = expected.map(exp => ({ exp, card: null }));
  for (const pass of [false, true]) {
    for (const row of rows) {
      if (row.card) continue;
      const c = findCard(row.exp, pass);
      if (c) { row.card = c; used.add(c.id); }
    }
  }
  const items = rows.map(({ exp, card }) => ({
    ...exp,
    columnLabel: colLabel(exp.column),
    card,
    misplaced: !!(card && card.fields?.columnId && card.fields.columnId !== exp.column),
    cardColumnLabel: card ? colLabel(card.fields?.columnId) : ""
  }));

  // Pacing: scenes per main column vs the rough guide.
  const weights = COLUMN_WEIGHTS[structure] || null;
  const scenes = [...state.cards.values()].filter(c => c.type === "scene" && !c.archived);
  const mainCols = columns.filter(c => c.isMain);
  const inMain = scenes.filter(s => mainCols.some(c => c.id === s.fields?.columnId));
  const total = inMain.length;
  const pacing = weights ? mainCols.map(c => {
    const count = inMain.filter(s => s.fields?.columnId === c.id).length;
    const share = total ? (count / total) * 100 : 0;
    const guide = weights[c.id] ?? 0;
    let flag = "";
    if (total >= 6) {
      if (count === 0) flag = "empty";
      else if (share > guide * 2 && share - guide >= 15) flag = "heavy";
      else if (share < guide * 0.4) flag = "thin";
    }
    return { id: c.id, label: c.label, count, share, guide, flag };
  }) : [];

  return { structure, items, found: items.filter(i => i.card).length, pacing, sceneTotal: total };
}

// The Outline's checklist panel. Side effects are delegated to project.js.
export function renderStructurePanel(state, { esc, open, onToggle, onAddBeat, onAddAll, onOpenCard, onCheckAI, aiResult }) {
  const st = structureStatus(state);
  const panel = document.createElement("details");
  panel.id = "structurePanel";
  panel.className = "structure-panel";

  if (!st.items.length) {
    panel.innerHTML = `<summary><strong>Structure checklist</strong> <span class="muted small">— pick a story structure in 📖 Story settings to get a beat checklist</span></summary>`;
    return panel;
  }
  const missing = st.items.filter(i => !i.card);
  // Unless the writer has chosen, stay open only while there's something to
  // act on — a complete, well-paced checklist shouldn't push the board down.
  if (open ?? (missing.length > 0 || st.pacing.some(p => p.flag))) panel.open = true;
  const pct = (n) => `${Math.round(n)}%`;
  panel.innerHTML = `
    <summary>
      <strong>Structure checklist</strong>
      <span class="sp-count ${missing.length ? "sp-incomplete" : "sp-complete"}">${st.found} of ${st.items.length} beats</span>
      ${st.pacing.some(p => p.flag) ? `<span class="sp-count sp-incomplete">pacing</span>` : ""}
    </summary>
    <div class="sp-body">
      <div class="sp-beats">
        <ol class="sp-beat-list">
          ${st.items.map((it, i) => `
            <li class="sp-beat ${it.card ? "sp-found" : "sp-missing"}">
              <span class="sp-mark">${it.card ? "✓" : "○"}</span>
              <div class="sp-beat-main">
                <div><strong>${esc(it.name)}</strong> <span class="muted small">~${it.at}% · ${esc(it.columnLabel)}</span></div>
                <div class="muted small">${esc(it.description)}</div>
                ${it.card ? `<div class="small">→ <a href="#" class="sp-open" data-card="${esc(it.card.id)}">${esc(it.card.title)}</a>${it.misplaced ? ` <span class="sp-warn">sits in ${esc(it.cardColumnLabel)} — usually ${esc(it.columnLabel)}</span>` : ""}</div>` : ""}
              </div>
              ${it.card ? "" : `<button type="button" class="ghost small sp-add" data-i="${i}">+ Add</button>`}
            </li>`).join("")}
        </ol>
        ${missing.length > 1 ? `<button type="button" class="ghost small sp-add-all">+ Add all ${missing.length} missing beats as placeholders</button>` : ""}
      </div>
      <div class="sp-side">
        <h4>Pacing <span class="muted small">— scenes per column vs a rough guide</span></h4>
        ${st.sceneTotal ? `
          <ul class="sp-pacing">
            ${st.pacing.map(p => `
              <li class="${p.flag ? "sp-flag" : ""}">
                <span class="sp-pace-label">${esc(p.label)}</span>
                <span class="sp-bar"><span class="sp-bar-fill" style="width:${Math.min(100, p.share)}%"></span><span class="sp-bar-guide" style="left:${Math.min(100, p.guide)}%"></span></span>
                <span class="sp-pace-num">${p.count} · ${pct(p.share)}</span>
                ${p.flag === "empty" ? `<span class="sp-warn">empty</span>` : p.flag === "heavy" ? `<span class="sp-warn">heavy</span>` : p.flag === "thin" ? `<span class="sp-warn">thin</span>` : ""}
              </li>`).join("")}
          </ul>
          ${st.sceneTotal < 6 ? `<p class="muted small">Pacing flags appear once there are 6+ scenes.</p>` : ""}
        ` : `<p class="muted small">No scenes yet.</p>`}
        <button type="button" class="ghost small sp-ai">✨ Check structure with AI</button>
        <div class="sp-ai-out">${aiResult ? renderAiResult(aiResult, esc) : ""}</div>
      </div>
    </div>
  `;
  // Remember only real clicks (setting .open in code also fires "toggle").
  panel.querySelector("summary").addEventListener("click", () => setTimeout(() => onToggle?.(panel.open), 0));
  panel.querySelectorAll(".sp-add").forEach(btn => btn.addEventListener("click", e => {
    e.preventDefault();
    onAddBeat?.(st.items[parseInt(btn.dataset.i, 10)]);
  }));
  panel.querySelector(".sp-add-all")?.addEventListener("click", e => { e.preventDefault(); onAddAll?.(missing); });
  panel.querySelectorAll(".sp-open").forEach(a => a.addEventListener("click", e => { e.preventDefault(); onOpenCard?.(a.dataset.card); }));
  panel.querySelector(".sp-ai")?.addEventListener("click", e => { e.preventDefault(); onCheckAI?.(); });
  return panel;
}

function renderAiResult(r, esc) {
  const list = (v) => Array.isArray(v) ? v.filter(x => x && typeof x === "object") : [];
  const missing = list(r.missingTurns);
  const issues = list(r.issues);
  return `
    ${r.overall ? `<p class="sp-ai-overall">${esc(r.overall)}</p>` : ""}
    ${missing.length ? `<h5>Missing or weak turns</h5><ul>${missing.map(m => `<li><strong>${esc(m.beat)}</strong> — ${esc(m.why)}${m.suggestion ? `<div class="muted small">Try: ${esc(m.suggestion)}</div>` : ""}</li>`).join("")}</ul>` : ""}
    ${issues.length ? `<h5>Structure notes</h5><ul>${issues.map(m => `<li>${m.where ? `<strong>${esc(m.where)}:</strong> ` : ""}${esc(m.problem)}${m.suggestion ? `<div class="muted small">Try: ${esc(m.suggestion)}</div>` : ""}</li>`).join("")}</ul>` : ""}
    ${!missing.length && !issues.length && !r.overall ? `<p class="muted small">No structural problems found.</p>` : ""}
  `;
}

const STRUCTURE_REVIEW_SYSTEM = `You are a story editor reviewing an outline against its chosen story structure. You get the structure's expected beats (with rough positions), the writer's beat cards, and the scenes in story order (with each scene's goal / conflict / outcome / value shift where known).

Find:
1. Missing or weak turns — expected beats with no scene that actually performs them (a beat card that exists but no scene delivers it counts as weak).
2. Structural problems — turns in the wrong place, acts that run long or short, stretches of scenes where nothing changes (value shift "flat" or no clear outcome), a midpoint that doesn't raise the stakes, a climax the protagonist doesn't drive, etc.
Be specific: name scenes and beats. Base it on what's on the cards; do not invent events. Keep each note to one or two sentences.

Return ONLY this JSON:
{
  "overall": "2-3 sentence assessment",
  "missingTurns": [ { "beat": "expected beat name", "why": "what's missing or weak", "suggestion": "a concrete idea drawn from the existing story" } ],
  "issues": [ { "where": "column or scene name", "problem": "...", "suggestion": "..." } ]
}`;

export async function reviewStructure(state, { signal } = {}) {
  const st = structureStatus(state);
  const columns = getColumnsForProject(state.project);
  const label = (id) => columns.find(c => c.id === id)?.label || id || "(unplaced)";
  const scenes = sortScenesByOutline([...state.cards.values()].filter(c => c.type === "scene" && !c.archived), state.project);
  const charName = (id) => state.cards.get(id)?.title || "";
  const payload = {
    structure: st.structure,
    expectedBeats: st.items.map(i => ({ name: i.name, column: i.columnLabel, approxPercent: i.at, purpose: i.description, beatCard: i.card ? i.card.title : null })),
    beatCards: [...state.cards.values()].filter(c => c.type === "beat" && !c.archived)
      .map(b => ({ title: b.title, structurePosition: b.fields?.structurePosition || "", column: label(b.fields?.columnId), description: b.fields?.description || "" })),
    scenesInOrder: scenes.map(s => ({
      title: s.title,
      column: label(s.fields?.columnId),
      summary: s.fields?.shortDescription || s.fields?.ragSummary || "",
      pov: charName(s.fields?.povCharacterId),
      goal: s.fields?.goal || "", conflict: s.fields?.conflict || "", outcome: s.fields?.outcome || "",
      change: s.fields?.change || "", valueShift: s.fields?.valueShift || ""
    })),
    pacing: st.pacing.map(p => ({ column: p.label, scenes: p.count, guidePercent: p.guide }))
  };
  return callLLMJson({
    system: buildProjectContext(state.project) + STRUCTURE_REVIEW_SYSTEM,
    user: `Outline:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON described in the system prompt.`,
    signal
  });
}
