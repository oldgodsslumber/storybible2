// Story-planning aids built on the Outline:
//   1. Scene function — what each scene DOES (POV, goal, conflict, outcome,
//      what changes, value shift). Filled by hand or by the LLM; never
//      overwritten by it. Lets the Outline flag scenes where nothing turns.
//   2. Structure checklist — the beats the project's chosen structure expects,
//      matched against the writer's beat cards, with one-click placeholders,
//      a rough pacing check per column, and an optional LLM structure review.

import { callLLMJson, wasTruncated } from "./llm.js?v=20261025";
import { buildProjectContext, getColumnsForProject, getStorySettings, sortScenesByOutline } from "./story-settings.js?v=20261025";

// ---------------------------------------------------------------------------
// Scene function
// ---------------------------------------------------------------------------

export const VALUE_SHIFTS = [
  { id: "up",    icon: "▲", label: "Ends better",      short: "better" },
  { id: "down",  icon: "▼", label: "Ends worse",       short: "worse" },
  { id: "mixed", icon: "⇅", label: "Reversal / mixed", short: "reversal" },
  { id: "flat",  icon: "●", label: "Nothing changes",  short: "nothing changes" }
];
export const SCENE_FUNCTION_FIELDS = ["goal", "conflict", "outcome", "change"];

export function valueShiftInfo(id) { return VALUE_SHIFTS.find(v => v.id === id) || null; }

// A scene counts as "analysed" once it has a value shift or any function text.
export function hasSceneFunction(f) {
  return !!(f?.valueShift || f?.povCharacterId || SCENE_FUNCTION_FIELDS.some(k => (f?.[k] || "").trim()));
}

// The editor block. Field inputs carry data-field so the card editor's
// normal save-on-blur/change wiring persists them.
export function sceneFunctionEditorHtml(card, state, esc) {
  const f = card.fields || {};
  const chars = [...state.cards.values()]
    .filter(c => c.type === "character" && !c.archived)
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  const aiSet = new Set(Array.isArray(f.aiFilled) ? f.aiFilled : []);
  const ai = (k) => aiSet.has(k) ? `<span class="sf-ai" title="Written by the AI — edit it to make it yours">✨</span> ` : "";
  const opt = (value, label, current) => `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
  return `
    <details class="scene-function"${hasSceneFunction(f) ? " open" : ""}>
      <summary>What this scene does <button type="button" class="ghost small fill-scene-function" title="Fill empty fields from the scene description">✨ Fill from description</button></summary>
      <p class="muted small">Every scene should turn something. If you can't name the goal, the conflict and what's different by the end, the scene may be doing no work.</p>
      <label>Point of view ${ai("povCharacterId")}
        <select data-field="povCharacterId">
          ${opt("", "— none —", f.povCharacterId || "")}
          ${chars.map(c => opt(c.id, c.title || "(untitled)", f.povCharacterId || "")).join("")}
          ${f.povCharacterId && !chars.some(c => c.id === f.povCharacterId)
            ? opt(f.povCharacterId, `${state.cards.get(f.povCharacterId)?.title || "Missing character"} (archived — pick another)`, f.povCharacterId) : ""}
        </select>
      </label>
      <label>Goal ${ai("goal")}<span class="muted small">— what does the POV character want here?</span>
        <textarea data-field="goal" rows="2">${esc(f.goal || "")}</textarea></label>
      <label>Conflict ${ai("conflict")}<span class="muted small">— what stands in the way?</span>
        <textarea data-field="conflict" rows="2">${esc(f.conflict || "")}</textarea></label>
      <label>Outcome ${ai("outcome")}<span class="muted small">— how does it end?</span>
        <textarea data-field="outcome" rows="2">${esc(f.outcome || "")}</textarea></label>
      <label>What changes ${ai("change")}<span class="muted small">— what's different by the end?</span>
        <textarea data-field="change" rows="2">${esc(f.change || "")}</textarea></label>
      <label>Value shift ${ai("valueShift")}
        <select data-field="valueShift">
          ${opt("", "— not set —", f.valueShift || "")}
          ${VALUE_SHIFTS.map(v => opt(v.id, `${v.icon} ${v.label}`, f.valueShift || "")).join("")}
        </select>
      </label>
    </details>
  `;
}

// Small badges for the Outline card.
export function sceneFunctionBadgesHtml(card, state, esc) {
  const f = card.fields || {};
  const bits = [];
  const pov = f.povCharacterId ? state.cards.get(f.povCharacterId) : null;
  if (pov && !pov.archived) bits.push(`<span class="sf-chip" title="Point of view">👁 ${esc(pov.title)}</span>`);
  else if (f.povCharacterId) bits.push(`<span class="sf-chip sf-gone" title="The POV character was archived or merged — pick a new one in the editor">👁 ${esc(pov?.title || "missing character")} (archived)</span>`);
  const shift = valueShiftInfo(f.valueShift);
  if (shift) {
    bits.push(`<span class="sf-chip sf-shift sf-${shift.id}" title="${esc(shift.label)}">${shift.icon} ${esc(shift.short)}</span>`);
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

// Ask the LLM for the function of each scene, BATCH scenes per call.
// `onBatch(results, { batch, batches })` runs after every batch so the caller
// can save as it goes — a later failure or Cancel never discards finished
// work. Each result is { sceneId, patch } where patch holds only fields that
// were empty when the scene was sent (the caller re-checks before writing).
// A failed batch is skipped and counted; aborts and errors that would fail
// every batch (bad key, no quota…) are re-thrown.
// Resolves to { answered, unanswered, failedBatches, batches }.
export async function analyzeSceneFunctions(state, scenes, { signal, onBatch } = {}) {
  const characters = [...state.cards.values()].filter(c => c.type === "character" && !c.archived);
  const charByName = new Map(characters.map(c => [(c.title || "").trim().toLowerCase(), c.id]));
  const columns = getColumnsForProject(state.project);
  const colLabel = (id) => columns.find(c => c.id === id)?.label || "";
  // Story order, so the model sees each scene where it sits.
  const ordered = sortScenesByOutline(scenes, state.project);
  const allInOrder = sortScenesByOutline(
    [...state.cards.values()].filter(c => c.type === "scene" && !c.archived), state.project);
  const neighbour = (s, delta) => {
    const i = allInOrder.findIndex(x => x.id === s.id);
    const n = i >= 0 ? allInOrder[i + delta] : null;
    return n ? `${n.title}: ${clip(n.fields?.shortDescription || n.fields?.ragSummary || "", 200)}` : "";
  };

  const BATCH = 8;
  const batches = Math.ceil(ordered.length / BATCH);
  let answered = 0, failedBatches = 0;
  for (let b = 0; b < batches; b++) {
    const slice = ordered.slice(b * BATCH, (b + 1) * BATCH);
    const payload = {
      characters: characters.map(c => c.title),
      scenes: slice.map((s, j) => ({
        key: String(j + 1), // keys restart per batch — models renumber anyway
        title: s.title,
        column: colLabel(s.fields?.columnId),
        previousScene: neighbour(s, -1),
        nextScene: neighbour(s, 1),
        shortDescription: s.fields?.shortDescription || "",
        longDescription: clip(s.fields?.longDescription || "", 4000),
        taggedCharacters: (s.fields?.characterIds || []).map(id => state.cards.get(id)).filter(c => c && !c.archived).map(c => c.title)
      }))
    };
    let res;
    try {
      res = await callLLMJson({
        system: buildProjectContext(state.project, { columns: false }) + SCENE_FUNCTION_SYSTEM,
        user: `Scenes:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON described in the system prompt.`,
        signal
      });
    } catch (err) {
      if (err?.name === "AbortError" || isFatal(err)) throw err;
      console.warn("[scene-function] batch failed; continuing", b + 1, err);
      failedBatches++;
      continue;
    }
    const results = [];
    const seen = new Set();
    for (const row of Array.isArray(res?.scenes) ? res.scenes : []) {
      if (!row || typeof row !== "object") continue;
      const idx = parseInt(row.key, 10) - 1;
      const scene = slice[idx];
      if (!scene || seen.has(scene.id)) continue; // first answer per scene wins
      seen.add(scene.id);
      const f = scene.fields || {};
      const patch = {};
      for (const k of SCENE_FUNCTION_FIELDS) {
        const v = typeof row[k] === "string" ? clip(row[k].trim(), FIELD_MAX) : "";
        if (v && !(f[k] || "").trim()) patch[k] = v;
      }
      const shift = String(row.valueShift || "").trim().toLowerCase();
      if (!f.valueShift && valueShiftInfo(shift)) patch.valueShift = shift;
      const povId = charByName.get(String(row.povCharacter || "").trim().toLowerCase());
      if (!f.povCharacterId && povId) patch.povCharacterId = povId;
      if (Object.keys(patch).length) results.push({ sceneId: scene.id, patch });
    }
    answered += seen.size;
    if (onBatch) await onBatch(results, { batch: b + 1, batches });
  }
  return { answered, unanswered: ordered.length - answered, failedBatches, batches };
}

const FIELD_MAX = 600;
function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
// Errors that will fail every remaining batch the same way.
function isFatal(err) {
  return [400, 401, 402, 403, 404, 429].includes(err?.status) || /API key|No LLM provider|Ooba fetch failed/i.test(err?.message || "");
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
    B("Inciting Incident", "act-1", 10, "The event that disrupts the normal world and sets the story moving.", ["catalyst", "call to adventure", "inciting", "inciting moment", "exciting force"]),
    B("Lock-in", "act-1", 25, "The protagonist commits to the goal — there's no going back.", ["plot point 1", "first plot point", "break into two", "break into act 2", "point of no return", "first turning point", "crossing the threshold", "crossing the first threshold", "break into act 2"]),
    B("Midpoint", "act-3", 50, "A false victory or false defeat that raises the stakes and turns the protagonist from reacting to acting.", ["mid-point", "midpoint reversal", "false victory", "false defeat", "ordeal", "the ordeal", "midpoint twist"]),
    B("All Is Lost", "act-4", 75, "The lowest point: the plan has failed and things are as bad as they can be.", ["crisis", "dark night of the soul", "plot point 2", "second plot point", "low point", "dark night", "whiff of death", "plot point 2"]),
    B("Climax", "act-5", 90, "The final confrontation, where the protagonist uses what they've learned.", ["final battle", "showdown", "finale", "resurrection", "break into three"]),
    B("Resolution", "act-6", 98, "The new normal — show how the protagonist and their world have changed.", ["denouement", "dénouement", "final image", "aftermath", "return with the elixir", "final image", "new normal"])
  ],
  "3-act": [
    B("Inciting Incident", "act-1", 10, "The event that disrupts the normal world.", ["catalyst", "call to adventure", "inciting"]),
    B("Plot Point 1", "act-1", 25, "The protagonist commits to the journey; Act 2 begins.", ["first plot point", "lock-in", "break into two", "point of no return", "crossing the threshold", "break into act 2"]),
    B("Midpoint", "act-2", 50, "A reversal that raises the stakes.", ["mid-point", "false victory", "false defeat"]),
    B("Plot Point 2", "act-2", 75, "The lowest point that launches the final act.", ["second plot point", "all is lost", "crisis", "dark night of the soul", "dark night", "whiff of death", "break into act 3"]),
    B("Climax", "act-3", 90, "The decisive confrontation.", ["finale", "showdown", "resurrection", "final battle"]),
    B("Resolution", "act-3", 98, "The aftermath and new normal.", ["denouement", "dénouement", "final image", "return with the elixir", "new normal", "aftermath"])
  ],
  "5-act": [
    B("Inciting Moment", "act-1", 10, "The force that sets the conflict in motion.", ["inciting incident", "exciting force", "catalyst", "exposition"]),
    B("Complication", "act-2", 30, "Obstacles mount and tension rises.", ["rising action", "rising"]),
    B("Climax", "act-3", 50, "The turning point of the drama.", ["turning point", "crisis"]),
    B("Reversal", "act-4", 70, "Consequences of the climax play out against the protagonist.", ["falling action", "peripeteia"]),
    B("Moment of Final Suspense", "act-4", 80, "A last doubt about the outcome before the end.", ["final suspense", "last chance"]),
    B("Dénouement", "act-5", 95, "The resolution — or catastrophe — that closes the story.", ["denouement", "catastrophe", "resolution"])
  ],
  "save-the-cat": [
    B("Opening Image", "act-1", 1, "A snapshot of the hero's world before the story.", []),
    B("Theme Stated", "act-1", 5, "Someone states what the story is really about.", [, "theme is stated"]),
    B("Set-Up", "act-1", 5, "The hero's world, flaws and what needs fixing.", ["setup"]),
    B("Catalyst", "act-2", 10, "The life-changing event.", ["inciting incident"]),
    B("Debate", "act-2", 15, "The hero hesitates — should I go?", []),
    B("Break Into Two", "act-3", 20, "The hero chooses to act and enters a new world.", ["break into 2", "plot point 1", "lock-in", "break into act 2", "crossing the threshold"]),
    B("B Story", "act-3", 22, "A secondary story (often a relationship) that carries the theme.", ["b-story"]),
    B("Fun and Games", "act-3", 35, "The promise of the premise — the trailer moments.", ["fun & games"]),
    B("Midpoint", "act-4", 50, "False victory or false defeat; stakes go up.", ["mid-point"]),
    B("Bad Guys Close In", "act-4", 62, "Pressure mounts from outside and doubt from inside.", []),
    B("All Is Lost", "act-5", 75, "The lowest point; often a 'whiff of death'.", ["crisis", "whiff of death"]),
    B("Dark Night of the Soul", "act-5", 78, "The hero wallows before finding the answer.", ["dark night"]),
    B("Break Into Three", "act-6", 80, "The solution — A and B stories combine.", ["break into 3", "plot point 2", "break into act 3"]),
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
    B("Return with the Elixir", "act-3", 98, "The hero returns changed, bringing something to share.", ["elixir", "return with elixir"])
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

// ---------------------------------------------------------------------------
// Beat matching
// ---------------------------------------------------------------------------
// Text is normalised so "Plot Point One", "plot point I" and "Plot-Point 1"
// compare equal: lowercase, accents stripped, number words and Roman numerals
// to digits, punctuation to spaces, a leading "the" dropped.
const NUMBER_WORDS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6" };
export function normBeat(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map(w => NUMBER_WORDS[w] || w)
    .join(" ")
    .replace(/^the /, "");
}
const hasPhrase = (text, phrase) => phrase && (" " + text + " ").includes(" " + phrase + " ");

// How strongly a card's text names an expected beat:
//   4 exact name · 3 exact alias · 2 the name appears as whole words
//   1 a multi-word alias appears as whole words · 0 no match.
// Single-word aliases ("return", "mentor") only ever match exactly — as a
// fragment they produce false hits like "Point of No Return".
function matchScore(texts, exp) {
  const name = normBeat(exp.name);
  const aliases = exp.aliases.map(normBeat);
  let best = 0;
  for (const t of texts) {
    if (!t) continue;
    if (t === name) best = Math.max(best, 4);
    else if (aliases.includes(t)) best = Math.max(best, 3);
    else if (name.length >= 4 && hasPhrase(t, name)) best = Math.max(best, 2);
    else if (aliases.some(a => a.includes(" ") && hasPhrase(t, a))) best = Math.max(best, 1);
  }
  return best;
}

// Assign cards to expected beats globally: strongest matches first, then a
// card already in the beat's usual column, then story position — so the
// result never depends on the order cards happened to load in.
function assignMatches(expected, cards, columnIndex) {
  const pairs = [];
  expected.forEach((exp, ei) => {
    for (const c of cards) {
      const score = matchScore([normBeat(c.fields?.structurePosition), normBeat(c.title)], exp);
      if (!score) continue;
      const inColumn = c.fields?.columnId === exp.column ? 1 : 0;
      pairs.push({ ei, card: c, score, inColumn, pos: (columnIndex.get(c.fields?.columnId) ?? 99) * 1000 + (c.fields?.columnOrder ?? 0) });
    }
  });
  pairs.sort((a, b) => (b.score - a.score) || (b.inColumn - a.inColumn) || (a.pos - b.pos) || (a.ei - b.ei) || String(a.card.id).localeCompare(String(b.card.id)));
  const byExpected = new Map();
  const usedCards = new Set();
  for (const p of pairs) {
    if (byExpected.has(p.ei) || usedCards.has(p.card.id)) continue;
    byExpected.set(p.ei, p.card);
    usedCards.add(p.card.id);
  }
  return byExpected;
}

export function structureStatus(state) {
  const structure = getStorySettings(state.project).structure;
  const expected = STRUCTURE_BEATS[structure] || [];
  const columns = getColumnsForProject(state.project);
  const columnIndex = new Map(columns.map((c, i) => [c.id, i]));
  const colLabel = (id) => columns.find(c => c.id === id)?.label || "Unassigned";
  const beats = [...state.cards.values()].filter(c => c.type === "beat" && !c.archived);
  const scenes = [...state.cards.values()].filter(c => c.type === "scene" && !c.archived);

  const matched = assignMatches(expected, beats, columnIndex);
  // For still-missing beats, a scene whose title names the beat is a hint.
  const sceneHints = assignMatches(expected.map((e, i) => matched.has(i) ? { ...e, name: "\u0000", aliases: [] } : e), scenes, columnIndex);

  const items = expected.map((exp, i) => {
    const card = matched.get(i) || null;
    const cardIdx = card ? columnIndex.get(card.fields?.columnId) : undefined;
    const expIdx = columnIndex.get(exp.column);
    // Neighbouring columns are fine: several structures' columns are ranges
    // ("Catalyst → Break Into Two") and boundary beats legitimately sit at
    // either edge. Two or more columns away — or unplaced — is worth a note.
    const misplaced = !!card && (cardIdx === undefined || Math.abs(cardIdx - expIdx) >= 2);
    return {
      ...exp,
      columnLabel: colLabel(exp.column),
      card,
      placeholder: !!card?.fields?.placeholder,
      misplaced,
      cardColumnLabel: card ? colLabel(card.fields?.columnId) : "",
      sceneHint: card ? null : (sceneHints.get(i) || null)
    };
  });

  // Untouched placeholders that don't belong to this structure (left over
  // from a structure switch).
  const matchedIds = new Set(items.filter(i => i.card).map(i => i.card.id));
  const strayPlaceholders = beats.filter(b => b.fields?.placeholder && !matchedIds.has(b.id));

  // Pacing: scenes per main column vs the rough guide.
  const weights = COLUMN_WEIGHTS[structure] || null;
  const mainCols = columns.filter(c => c.isMain);
  const inMain = scenes.filter(s => mainCols.some(c => c.id === s.fields?.columnId));
  const total = inMain.length;
  const pacing = weights ? mainCols.map(c => {
    const count = inMain.filter(s => s.fields?.columnId === c.id).length;
    const share = total ? (count / total) * 100 : 0;
    const guide = weights[c.id] ?? 0;
    const expectedCount = (guide / 100) * total;
    let flag = "";
    if (total >= 6) {
      if (count === 0 && expectedCount >= 1.5) flag = "empty";
      else if (share - guide >= Math.max(20, guide * 0.6)) flag = "heavy";
      else if (count > 0 && share < guide * 0.4 && expectedCount >= 2) flag = "thin";
    }
    return { id: c.id, label: c.label, count, share, guide, flag };
  }) : [];

  const written = items.filter(i => i.card && !i.placeholder).length;
  const placeholders = items.filter(i => i.card && i.placeholder).length;
  return { structure, items, found: written + placeholders, written, placeholders, pacing, sceneTotal: total, strayPlaceholders };
}

// Whether the panel has anything for the writer to act on.
export function structureNeedsAttention(st) {
  return st.items.some(i => !i.card || i.placeholder || i.misplaced) || st.pacing.some(p => p.flag) || st.strayPlaceholders.length > 0;
}

// The Outline's checklist panel. Side effects are delegated to project.js.
// `open` is true/false, or null to decide from the contents.
export function renderStructurePanel(state, opts) {
  const { esc, open, busy, onToggle, onAddBeat, onAddAll, onOpenCard, onCheckAI, onDismissAI, onArchiveStray, aiResult, structureLabel } = opts;
  const st = structureStatus(state);
  const panel = document.createElement("details");
  panel.id = "structurePanel";
  panel.className = "structure-panel";

  if (!st.items.length) {
    panel.innerHTML = `<summary><strong>Structure checklist</strong> <span class="muted small">— pick a story structure in 📖 Story settings to get a beat checklist</span></summary>`;
    return panel;
  }
  const missing = st.items.filter(i => !i.card);
  if (open ?? structureNeedsAttention(st)) panel.open = true;
  const pct = (n) => `${Math.round(n)}%`;
  const dis = busy ? " disabled" : "";
  const ai = aiResult && aiResult.structure === st.structure ? aiResult : null;
  panel.innerHTML = `
    <summary>
      <strong>Structure checklist</strong>
      <span class="sp-count ${missing.length ? "sp-incomplete" : "sp-complete"}">${st.written} of ${st.items.length} beats${st.placeholders ? ` · ${st.placeholders} placeholder${st.placeholders === 1 ? "" : "s"}` : ""}</span>
      ${st.pacing.some(p => p.flag) ? `<span class="sp-count sp-incomplete">pacing</span>` : ""}
    </summary>
    <div class="sp-body">
      <div class="sp-beats">
        <ol class="sp-beat-list">
          ${st.items.map((it, i) => `
            <li class="sp-beat ${it.card ? (it.placeholder ? "sp-placeholder" : "sp-found") : "sp-missing"}">
              <span class="sp-mark" title="${it.card ? (it.placeholder ? "Placeholder — not written yet" : "Present") : "Missing"}">${it.card ? (it.placeholder ? "◌" : "✓") : "○"}</span>
              <div class="sp-beat-main">
                <div><strong>${esc(it.name)}</strong> <span class="muted small">~${it.at}% · ${esc(it.columnLabel)}</span></div>
                ${!it.card || it.placeholder ? `<div class="muted small">${esc(it.description)}</div>` : ""}
                ${it.card ? `<div class="small">→ <a href="#" class="sp-open" data-card="${esc(it.card.id)}">${esc(it.card.title)}</a>${it.placeholder ? ` <span class="muted small">placeholder — open it and write the beat</span>` : ""}${it.misplaced ? ` <span class="sp-warn">sits in ${esc(it.cardColumnLabel)} — usually ${esc(it.columnLabel)}</span>` : ""}</div>` : ""}
                ${it.sceneHint ? `<div class="small sp-hint">Scene <a href="#" class="sp-open" data-card="${esc(it.sceneHint.id)}">${esc(it.sceneHint.title)}</a> looks like this beat — "+ Add" will link it.</div>` : ""}
              </div>
              ${it.card ? "" : `<button type="button" class="ghost small sp-add" data-i="${i}"${dis}>+ Add</button>`}
            </li>`).join("")}
        </ol>
        ${missing.length > 1 ? `<button type="button" class="ghost small sp-add-all"${dis}>+ Add all ${missing.length} missing beats as placeholders</button>` : ""}
        ${st.strayPlaceholders.length ? `
          <p class="small sp-stray">${st.strayPlaceholders.length} untouched placeholder beat${st.strayPlaceholders.length === 1 ? "" : "s"} from another structure (${st.strayPlaceholders.slice(0, 4).map(b => esc(b.title)).join(", ")}${st.strayPlaceholders.length > 4 ? "…" : ""}).
          <button type="button" class="ghost small sp-archive-stray"${dis}>Archive them</button></p>` : ""}
      </div>
      <div class="sp-side">
        <h4>Pacing <span class="muted small">— scenes per act column</span></h4>
        ${st.sceneTotal ? `
          <ul class="sp-pacing">
            ${st.pacing.map(p => `
              <li class="${p.flag ? "sp-flag" : ""}">
                <span class="sp-pace-label">${esc(p.label)}</span>
                <span class="sp-bar"><span class="sp-bar-fill" style="width:${Math.min(100, p.share)}%"></span><span class="sp-bar-guide" style="left:${Math.min(100, p.guide)}%"></span></span>
                <span class="sp-pace-num">${p.count} · ${pct(p.share)}</span>
                ${p.flag ? `<span class="sp-warn">${p.flag}</span>` : ""}
              </li>`).join("")}
          </ul>
          <p class="muted small">Bar = your share of scenes · tick = a rough guide for this structure.${st.sceneTotal < 6 ? " Flags appear once 6+ scenes sit in the act columns." : ""}</p>
        ` : `<p class="muted small">No scenes in the act columns yet.</p>`}
        <button type="button" class="ghost small sp-ai"${dis}>✨ Check structure with AI</button>
        <div class="sp-ai-out">${ai ? renderAiResult(ai, esc, structureLabel) : ""}</div>
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
  panel.querySelector(".sp-archive-stray")?.addEventListener("click", e => { e.preventDefault(); onArchiveStray?.(st.strayPlaceholders); });
  panel.querySelectorAll(".sp-open").forEach(a => a.addEventListener("click", e => { e.preventDefault(); onOpenCard?.(a.dataset.card); }));
  panel.querySelector(".sp-ai")?.addEventListener("click", e => { e.preventDefault(); onCheckAI?.(); });
  panel.querySelector(".sp-ai-dismiss")?.addEventListener("click", e => { e.preventDefault(); onDismissAI?.(); });
  return panel;
}

function renderAiResult(r, esc, structureLabel) {
  const when = r.at ? new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  return `
    <div class="sp-ai-head muted small">Reviewed against ${esc(structureLabel?.(r.structure) || r.structure)}${when ? ` at ${esc(when)}` : ""}${r.changedSince ? " · the outline has changed since" : ""}
      <button type="button" class="ghost small sp-ai-dismiss">Dismiss</button></div>
    ${r.truncated ? `<p class="sp-warn">The AI's reply was cut off — this review may be incomplete.</p>` : ""}
    ${r.overall ? `<p class="sp-ai-overall">${esc(r.overall)}</p>` : ""}
    ${r.missingTurns.length ? `<h5>Missing or weak turns</h5><ul>${r.missingTurns.map(m => `<li>${m.beat ? `<strong>${esc(m.beat)}</strong> — ` : ""}${esc(m.why)}${m.suggestion ? `<div class="muted small">Try: ${esc(m.suggestion)}</div>` : ""}</li>`).join("")}</ul>` : ""}
    ${r.issues.length ? `<h5>Structure notes</h5><ul>${r.issues.map(m => `<li>${m.where ? `<strong>${esc(m.where)}:</strong> ` : ""}${esc(m.problem)}${m.suggestion ? `<div class="muted small">Try: ${esc(m.suggestion)}</div>` : ""}</li>`).join("")}</ul>` : ""}
    ${!r.missingTurns.length && !r.issues.length ? `<p class="muted small">No missing turns or structural problems flagged.</p>` : ""}
  `;
}

const STRUCTURE_REVIEW_SYSTEM = `You are a story editor reviewing an outline against its chosen story structure. You get the structure's expected beats (with rough positions), the writer's beat cards, and the scenes in story order (with each scene's goal / conflict / outcome / value shift where known).

Find:
1. Missing or weak turns — expected beats with no scene that actually performs them (a beat card that exists but no scene delivers it counts as weak).
2. Structural problems — turns in the wrong place, acts that run long or short, stretches of scenes where nothing changes (value shift "flat" or no clear outcome), a midpoint that doesn't raise the stakes, a climax the protagonist doesn't drive, etc.
Be specific: name scenes and beats. Base it on what's on the cards; do not invent events. Keep each note to one or two sentences, and give at most 8 missing turns and 8 notes — the most important first.

Return ONLY this JSON:
{
  "overall": "2-3 sentence assessment",
  "missingTurns": [ { "beat": "expected beat name", "why": "what's missing or weak", "suggestion": "a concrete idea drawn from the existing story" } ],
  "issues": [ { "where": "column or scene name", "problem": "...", "suggestion": "..." } ]
}`;

// Coerce the model's reply into { overall, missingTurns[], issues[] } with
// bounded sizes. Strings in the lists (a common model habit) become entries;
// a reply with nothing usable is an error, not "no problems found".
function normalizeStructureReview(res) {
  const text = (v, n) => {
    const s = typeof v === "string" ? v : (typeof v === "number" ? String(v) : "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s.trim();
  };
  const list = (v) => Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : []);
  const missingTurns = list(res?.missingTurns).map(m => typeof m === "string"
    ? { beat: "", why: text(m, 400), suggestion: "" }
    : { beat: text(m?.beat, 80), why: text(m?.why ?? m?.problem, 400), suggestion: text(m?.suggestion, 400) })
    .filter(m => m.beat || m.why).slice(0, 12);
  const issues = list(res?.issues).map(m => typeof m === "string"
    ? { where: "", problem: text(m, 400), suggestion: "" }
    : { where: text(m?.where, 80), problem: text(m?.problem ?? m?.why, 400), suggestion: text(m?.suggestion, 400) })
    .filter(m => m.problem).slice(0, 12);
  const overall = text(res?.overall, 1200);
  if (!overall && !missingTurns.length && !issues.length && !(Array.isArray(res?.missingTurns) && Array.isArray(res?.issues))) {
    throw new Error("The AI's reply wasn't in the expected format, so there's no review to show. Try again, or pick a different model in Settings.");
  }
  return { overall, missingTurns, issues };
}

export async function reviewStructure(state, { signal } = {}) {
  const st = structureStatus(state);
  const columns = getColumnsForProject(state.project);
  const label = (id) => columns.find(c => c.id === id)?.label || id || "(unplaced)";
  const scenes = sortScenesByOutline([...state.cards.values()].filter(c => c.type === "scene" && !c.archived), state.project);
  const charName = (id) => { const c = state.cards.get(id); return c && !c.archived ? c.title : ""; };
  const payload = {
    structure: st.structure,
    expectedBeats: st.items.map(i => ({ name: i.name, column: i.columnLabel, approxPercent: i.at, purpose: i.description, beatCard: i.card && !i.placeholder ? i.card.title : null })),
    beatCards: [...state.cards.values()].filter(c => c.type === "beat" && !c.archived && !c.fields?.placeholder)
      .map(b => ({ title: b.title, structurePosition: b.fields?.structurePosition || "", column: label(b.fields?.columnId), description: b.fields?.description || "" })),
    scenesInOrder: scenes.map(s => {
      const f = s.fields || {};
      const out = { title: s.title, column: label(f.columnId), summary: f.shortDescription || f.ragSummary || "" };
      const pov = charName(f.povCharacterId);
      if (pov) out.pov = pov;
      for (const k of ["goal", "conflict", "outcome", "change", "valueShift"]) if (f[k]) out[k] = f[k];
      return out;
    }),
    pacing: st.pacing.map(p => ({ column: p.label, scenes: p.count, guidePercent: p.guide }))
  };
  const res = await callLLMJson({
    system: buildProjectContext(state.project, { columns: false }) + STRUCTURE_REVIEW_SYSTEM,
    user: `Outline:\n${JSON.stringify(payload, null, 2)}\n\nReturn the JSON described in the system prompt.`,
    signal
  });
  return { ...normalizeStructureReview(res), structure: st.structure, at: Date.now(), truncated: wasTruncated(res) };
}
