import {
  auth, db, onAuthChange, renderUserArea, show, hide, blankFieldsForType, CARD_TYPES, KANBAN_STAGES, openBusyOverlay
} from "./shared.js";
import {
  doc, getDoc, getDocs, collection, addDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { isConfigured, getSettings } from "./llm.js";
import { openSettingsModal } from "./settings.js?v=20260530";
import {
  extractFromIdeaDump, parseSidePanelNote, runGapAnalysis,
  openApprovalModal, openWizardModal
} from "./extraction.js";
import { logAudit, staleImpact, changesSinceLastRefresh } from "./audit.js";
import { runGlobalRefresh, provideStateRef } from "./refresh.js";
import {
  renderReviewPanel, generateScene, insertGeneratedScene,
  suggestTraits, applyTraitSuggestions, openTraitSuggestModal,
  openSceneProposalModal
} from "./review.js";
import { renderOracle } from "./oracle.js?v=20260603a";
import { openStorySettingsModal, getColumnsForProject, defaultColumnId } from "./story-settings.js";
import { provideExtractionStateRef } from "./extraction.js";
import { mountLlmConfigBanner } from "./settings.js?v=20260530";

const REFRESH_NUDGE_THRESHOLD = 60;

const params = new URLSearchParams(location.search);
const projectId = params.get("id");
const isNewProject = params.get("isNew") === "1";

const els = {
  loading: document.getElementById("loading"),
  userArea: document.getElementById("userArea"),
  projectTitle: document.getElementById("projectTitle"),
  graphView: document.getElementById("graphView"),
  outlineView: document.getElementById("outlineView"),
  reviewView: document.getElementById("reviewView"),
  archiveView: document.getElementById("archiveView"),
  notePanel: document.getElementById("notePanel"),
  parseNoteBtn: document.getElementById("parseNoteBtn"),
  clearNoteBtn: document.getElementById("clearNoteBtn"),
  rerunExtractBtn: document.getElementById("rerunExtractBtn"),
  llmStatus: document.getElementById("llmStatus"),
  outlineList: document.getElementById("outlineList"),
  outlineEmpty: document.getElementById("outlineEmpty"),
  archiveList: document.getElementById("archiveList"),
  archiveEmpty: document.getElementById("archiveEmpty"),
  kanbanView: document.getElementById("kanbanView"),
  kanbanBoard: document.getElementById("kanbanBoard"),
  oracleView: document.getElementById("oracleView"),
  cardEditor: document.getElementById("cardEditor"),
  refreshBtn: document.getElementById("refreshBtn"),
  refreshBadge: document.getElementById("refreshBadge"),
  recenterBtn: document.getElementById("recenterBtn"),
  storySettingsBtn: document.getElementById("storySettingsBtn"),
  captureView: document.getElementById("captureView"),
  captureNotePanel: document.getElementById("captureNotePanel"),
  captureProcessBtn: document.getElementById("captureProcessBtn"),
  captureClearBtn: document.getElementById("captureClearBtn"),
  captureRerunExtractBtn: document.getElementById("captureRerunExtractBtn"),
  mobileTabs: document.querySelectorAll(".mobile-tab"),
  mobileMoreBtn: document.getElementById("mobileMoreBtn"),
  mobileMoreSheet: document.getElementById("mobileMoreSheet"),
  mobileMoreClose: document.getElementById("mobileMoreClose"),
  mobileMoreList: document.querySelector(".mobile-more-list"),
  tabs: document.querySelectorAll(".tab"),
  cardTypeButtons: document.querySelectorAll(".card-type-buttons button"),
};

const state = {
  user: null,
  project: null,
  cards: new Map(),
  connections: new Map(),
  cy: null,
  selectedCardId: null,
  connectMode: false,
  connectFrom: null,
};

if (!projectId) {
  location.href = "./index.html";
}

onAuthChange(async user => {
  if (!user) {
    location.href = "./index.html";
    return;
  }
  state.user = user;
  renderUserArea(els.userArea, user);
  if (projectLoaded) {
    console.log("[init] auth changed but project already loaded; skipping reload");
    return;
  }
  projectLoaded = true;
  mountLlmConfigBanner();
  await loadProject();
});

els.tabs.forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));
els.cardTypeButtons.forEach(b => b.addEventListener("click", () => createCard(b.dataset.type)));
els.parseNoteBtn?.addEventListener("click", parseNoteHandler);
els.clearNoteBtn?.addEventListener("click", () => { els.notePanel.value = ""; });

// Capture view (mobile-primary) — same handler as the desktop side panel,
// just reading from the bigger textarea.
els.captureProcessBtn?.addEventListener("click", () => {
  if (!els.notePanel || !els.captureNotePanel) return;
  els.notePanel.value = els.captureNotePanel.value;
  parseNoteHandler().finally(() => {
    // parseNoteHandler clears els.notePanel after approval; mirror back.
    if (els.notePanel.value === "") els.captureNotePanel.value = "";
  });
});
els.captureClearBtn?.addEventListener("click", () => { if (els.captureNotePanel) els.captureNotePanel.value = ""; });
els.captureRerunExtractBtn?.addEventListener("click", () => runIdeaDumpExtractionNow());

// Mobile bottom tab bar — top-level views: capture, outline, review.
els.mobileTabs?.forEach(btn => {
  const target = btn.dataset.mobileTab;
  if (!target) return; // "More" handled separately
  btn.addEventListener("click", () => {
    switchView(target);
    setMobileTabActive(target);
  });
});

// Mobile More sheet
els.mobileMoreBtn?.addEventListener("click", () => openMobileMoreSheet());
els.mobileMoreClose?.addEventListener("click", () => closeMobileMoreSheet());
els.mobileMoreSheet?.querySelector(".mobile-more-backdrop")?.addEventListener("click", closeMobileMoreSheet);
els.mobileMoreList?.querySelectorAll("button[data-mobile-action]").forEach(btn => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.mobileAction;
    closeMobileMoreSheet();
    switch (action) {
      case "story-settings":
        openStorySettingsModal(state, projectId, { onSaved: () => {} });
        break;
      case "refresh":
        handleRefresh();
        break;
      case "settings":
        openSettingsModal();
        break;
      case "back-dashboard":
        window.location.href = "./index.html";
        break;
      case "kanban":
      case "oracle":
      case "archive":
        switchView(action);
        setMobileTabActive(null);
        break;
    }
  });
});

function openMobileMoreSheet() {
  if (!els.mobileMoreSheet) return;
  els.mobileMoreSheet.classList.remove("hidden");
}
function closeMobileMoreSheet() {
  if (!els.mobileMoreSheet) return;
  els.mobileMoreSheet.classList.add("hidden");
}
function setMobileTabActive(target) {
  els.mobileTabs?.forEach(b => b.classList.toggle("active", b.dataset.mobileTab === target));
}

function isMobileViewport() {
  return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
}
els.refreshBtn?.addEventListener("click", handleRefresh);
els.rerunExtractBtn?.addEventListener("click", () => runIdeaDumpExtractionNow());
els.recenterBtn?.addEventListener("click", () => {
  if (!state.cy) return;
  state.cy.resize();
  state.cy.fit(undefined, 40);
});
els.storySettingsBtn?.addEventListener("click", () => {
  openStorySettingsModal(state, projectId, {
    onSaved: () => {
      console.log("[story-settings] saved");
      // Re-render whichever view is active so a structure change shows up
      // immediately (especially relevant after a remap).
      if (els.outlineView && !els.outlineView.classList.contains("hidden")) {
        renderOutline();
      }
    }
  });
});

provideStateRef(state);
provideExtractionStateRef(state);

// Unified wrapper for every LLM-driven action. Guarantees the user sees a
// busy overlay (with cancel), a console trace, and an alert on failure.
// Use this for every LLM call site so behavior is consistent.
async function runLLMAction(label, fn) {
  console.log("[llm-action] start:", label);
  const busy = openBusyOverlay(label);
  try {
    const result = await fn(busy);
    console.log("[llm-action] ok:", label, result);
    busy.close();
    return { ok: true, result };
  } catch (err) {
    busy.close();
    console.error("[llm-action] failed:", label, err);
    if (err?.name === "AbortError") {
      console.log("[llm-action] cancelled by user:", label);
      return { ok: false, error: err, cancelled: true };
    }
    alert(label + " failed:\n\n" + (err?.message || String(err)));
    return { ok: false, error: err };
  }
}

console.log("[init] project.js wiring", {
  projectId,
  isNewProject,
  hasParseNoteBtn: !!els.parseNoteBtn,
  hasRerunExtractBtn: !!els.rerunExtractBtn,
  hasRefreshBtn: !!els.refreshBtn,
  tabs: els.tabs.length,
  cardTypeButtons: els.cardTypeButtons.length
});

// Guard against onAuthStateChanged firing twice (token refresh etc.)
let projectLoaded = false;

async function handleRefresh() {
  if (document.body.classList.contains("refresh-locked")) return;
  await runGlobalRefresh({
    state,
    projectId,
    onChanged: () => {
      rebuildGraphElements();
      if (state.selectedCardId) openCardEditor(state.selectedCardId);
      updateRefreshNudge();
    }
  });
}

function maybeShowRefreshNudge() {
  const n = changesSinceLastRefresh(state.project).length;
  if (n < REFRESH_NUDGE_THRESHOLD) return;
  if (sessionStorage.getItem("nudge.dismissed." + projectId)) return;
  const ok = confirm(`You have ${n} unsynced changes since your last Global Refresh.\n\nWe recommend a Global Refresh before reviewing — your summaries may be out of date.\n\nRun it now?`);
  if (ok) {
    handleRefresh();
  } else {
    sessionStorage.setItem("nudge.dismissed." + projectId, "1");
  }
}

function updateRefreshNudge() {
  const changes = changesSinceLastRefresh(state.project);
  const n = changes.length;
  if (els.refreshBadge) {
    if (n > 0) {
      els.refreshBadge.textContent = String(n);
      els.refreshBadge.classList.remove("hidden");
    } else {
      els.refreshBadge.classList.add("hidden");
    }
    els.refreshBadge.classList.toggle("warn", n >= REFRESH_NUDGE_THRESHOLD);
  }
}

async function loadProject() {
  const projectRef = doc(db, "users", state.user.uid, "projects", projectId);
  const projectSnap = await getDoc(projectRef);
  if (!projectSnap.exists()) {
    alert("Project not found.");
    location.href = "./index.html";
    return;
  }
  state.project = { id: projectSnap.id, ...projectSnap.data() };
  els.projectTitle.textContent = state.project.title || "(untitled)";
  document.title = `${state.project.title} — The Writer's Assistant`;

  const cardsSnap = await getDocs(collection(db, "users", state.user.uid, "projects", projectId, "cards"));
  cardsSnap.forEach(d => state.cards.set(d.id, { id: d.id, ...d.data() }));

  const connSnap = await getDocs(collection(db, "users", state.user.uid, "projects", projectId, "connections"));
  connSnap.forEach(d => state.connections.set(d.id, { id: d.id, ...d.data() }));

  // Backward-compat: any scene/beat without a columnId gets dropped into the
  // first main column of the current structure. Persist to Firestore once so
  // future loads don't need to keep migrating.
  await migrateUnassignedColumns();

  hide(els.loading);
  // On mobile, default to Capture; canvas is desktop-only.
  switchView(isMobileViewport() ? "capture" : "graph");
  setMobileTabActive(isMobileViewport() ? "capture" : null);
  updateRefreshNudge();
  if (els.rerunExtractBtn) {
    els.rerunExtractBtn.classList.remove("hidden");
    const hasText = !!(state.project.themeText || "").trim();
    if (!hasText) {
      els.rerunExtractBtn.title = "This project has no idea-dump text.";
    }
  }
  if (els.captureRerunExtractBtn) {
    const hasText = !!(state.project.themeText || "").trim();
    els.captureRerunExtractBtn.classList.toggle("hidden", !hasText);
  }
  console.log("[project] loaded", {
    cards: state.cards.size,
    connections: state.connections.size,
    themeTextChars: (state.project.themeText || "").length,
    auditEntries: (state.project.auditTrail || []).length
  });
  if (isNewProject) {
    history.replaceState({}, "", `./project.html?id=${encodeURIComponent(projectId)}`);
    await maybeRunIdeaDumpExtraction();
  }
}

async function maybeRunIdeaDumpExtraction() {
  console.log("[idea-dump] auto-trigger on new project");
  const themeText = (state.project.themeText || "").trim();
  if (!themeText) {
    console.log("[idea-dump] aborted: project has no themeText");
    return;
  }
  if (!isConfigured()) {
    console.log("[idea-dump] aborted: no LLM provider configured");
    const wantConfigure = confirm("You have an idea dump but no LLM provider is configured.\n\nConfigure one now to extract characters, locations, and themes?\n\nCancel = work manually for now (you can run extraction later from the side panel.)");
    if (wantConfigure) openSettingsModal();
    return;
  }
  await runIdeaDumpExtractionNow(themeText);
}

async function runIdeaDumpExtractionNow(themeText) {
  console.log("[idea-dump] runIdeaDumpExtractionNow called", { providedText: !!themeText });
  if (!themeText) themeText = (state.project.themeText || "").trim();
  if (!themeText) {
    alert("This project has no idea-dump text to extract from. Create a new project from the dashboard and type your idea dump in the big text field.");
    return;
  }
  if (!isConfigured()) {
    alert("No LLM provider configured. Open ⚙ Settings to set one up.");
    return;
  }
  const { ok, result: parsed } = await runLLMAction(
    "Extracting entities from your idea dump",
    () => extractFromIdeaDump(themeText)
  );
  if (!ok) return;
  if (!parsed || typeof parsed !== "object") {
    alert("Extraction returned an unexpected shape. Check the browser console for details.");
    console.error("[idea-dump] parsed is not an object", parsed);
    return;
  }

  openApprovalModal(parsed, {
    title: "Review what the LLM found in your idea dump",
    onApprove: async (approved) => {
      try {
        await applyApprovedItems(approved);
      } catch (err) {
        console.error("[idea-dump] applyApprovedItems failed", err);
        alert("Saving approved items failed: " + (err.message || err));
        return;
      }
      const { ok: gapOk, result: gap } = await runLLMAction(
        "Looking for narrative gaps to fill",
        () => runGapAnalysis(themeText, parsed)
      );
      if (!gapOk) return;
      const questions = gap?.questions || [];
      if (questions.length === 0) {
        console.log("[idea-dump] no gap questions returned");
        return;
      }
      openWizardModal(questions, {
        onComplete: async ({ answers }) => {
          try {
            await applyWizardAnswers(answers);
          } catch (err) {
            console.error("[idea-dump] applyWizardAnswers failed", err);
            alert("Saving wizard answers failed: " + (err.message || err));
          }
        }
      });
    }
  });
}

async function parseNoteHandler() {
  console.log("[parse-note] button clicked");
  const text = els.notePanel.value.trim();
  if (!text) {
    alert("Type something into the note panel first, then click Process.");
    return;
  }
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) openSettingsModal();
    return;
  }
  const { ok, result: parsed } = await runLLMAction(
    "Parsing note",
    () => parseSidePanelNote(text, existingEntitySummaries())
  );
  if (!ok) return;
  if (!parsed || typeof parsed !== "object") {
    alert("Parsing returned an unexpected shape. Check the browser console for details.");
    console.error("[parse-note] parsed is not an object", parsed);
    return;
  }
  openApprovalModal(parsed, {
    title: "Review what the LLM found in your note",
    onApprove: async (approved) => {
      try {
        await applyApprovedItems(approved);
        els.notePanel.value = "";
      } catch (err) {
        console.error("[parse-note] applyApprovedItems failed", err);
        alert("Saving approved items failed: " + (err.message || err));
        return;
      }
      // After approval, run gap analysis on the same note so the LLM can
      // ask clarifying questions and surface what the extraction missed.
      const { ok: gapOk, result: gap } = await runLLMAction(
        "Looking for follow-up questions",
        () => runGapAnalysis(text, parsed)
      );
      if (!gapOk) return;
      const questions = gap?.questions || [];
      if (questions.length === 0) {
        console.log("[parse-note] no follow-up questions returned");
        return;
      }
      openWizardModal(questions, {
        onComplete: async ({ answers }) => {
          try {
            await applyWizardAnswers(answers);
          } catch (err) {
            console.error("[parse-note] applyWizardAnswers failed", err);
            alert("Saving wizard answers failed: " + (err.message || err));
          }
        }
      });
    }
  });
}

function existingEntitySummaries() {
  const out = [];
  for (const c of state.cards.values()) {
    if (c.archived) continue;
    out.push({ type: c.type, title: c.title, role: c.fields?.role || "" });
  }
  return out;
}

function setLlmStatus(msg) {
  if (els.llmStatus) els.llmStatus.textContent = msg || "";
}

// --- Apply approved items to Firestore + state ---

async function applyApprovedItems(approved) {
  console.log("[apply] approved input", {
    characters: approved?.characters?.length || 0,
    locations:  approved?.locations?.length  || 0,
    themes:     approved?.themes?.length     || 0,
    updates:    approved?.updates?.length    || 0,
    connections:approved?.connections?.length|| 0
  });
  const nameToCardId = new Map();
  for (const c of state.cards.values()) {
    if (!c.archived) nameToCardId.set(c.title.toLowerCase(), c.id);
  }

  const cardsCol = collection(db, "users", state.user.uid, "projects", projectId, "cards");
  const connCol  = collection(db, "users", state.user.uid, "projects", projectId, "connections");
  const auditBatch = [];
  let added = 0;

  for (const ch of approved.characters || []) {
    if (!ch.name) { console.warn("[apply] skipped character with no name", ch); continue; }
    const data = {
      type: "character",
      title: ch.name,
      archived: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      order: 0,
      fields: {
        ...blankFieldsForType("character"),
        role: ch.role || "",
        traits: ch.traits || [],
        history: ch.history || []
      }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(ch.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "character", title: ch.name, source: ch.source } });
    added++;
    console.log("[apply] added character", { id: ref.id, name: ch.name });
  }
  for (const l of approved.locations || []) {
    if (!l.name) { console.warn("[apply] skipped location with no name", l); continue; }
    const data = {
      type: "location", title: l.name, archived: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), order: 0,
      fields: { ...blankFieldsForType("location"), description: l.description || "" }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(l.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "location", title: l.name, source: l.source } });
    added++;
    console.log("[apply] added location", { id: ref.id, name: l.name });
  }
  for (const t of approved.themes || []) {
    if (!t.name) { console.warn("[apply] skipped theme with no name", t); continue; }
    const data = {
      type: "theme", title: t.name, archived: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), order: 0,
      fields: { ...blankFieldsForType("theme"), description: t.description || "" }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(t.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "theme", title: t.name, source: t.source } });
    added++;
    console.log("[apply] added theme", { id: ref.id, name: t.name });
  }
  // Resolve column hints for scenes and beats. The LLM might return a
  // column ID, a label, or nonsense — fall back to the default main column
  // when no valid match. columnOrder is max+1 within the chosen column so
  // newly-added cards land at the bottom of the stack.
  const projectColumns = getColumnsForProject(state.project);
  const validColumnIds = new Set(projectColumns.map(c => c.id));
  const fallbackColumnId = defaultColumnId(state.project);
  const resolveColumn = (hint) => {
    if (!hint) return fallbackColumnId;
    const h = String(hint).trim().toLowerCase();
    if (validColumnIds.has(h)) return h;
    // Allow label match: "Act 1: Exposition" → act-1
    const byLabel = projectColumns.find(c => c.label.toLowerCase() === h);
    if (byLabel) return byLabel.id;
    // Allow short label match: "act 1" → act-1
    const byShort = projectColumns.find(c => c.label.toLowerCase().startsWith(h));
    if (byShort) return byShort.id;
    console.warn("[apply] columnHint did not match any column; falling back to default", { hint, fallbackColumnId });
    return fallbackColumnId;
  };
  const columnOrderCounters = {}; // colId -> next columnOrder to use
  const initCounter = (colId) => {
    if (columnOrderCounters[colId] != null) return;
    const max = [...state.cards.values()]
      .filter(c => !c.archived && (c.type === "scene" || c.type === "beat") && c.fields?.columnId === colId)
      .reduce((m, c) => Math.max(m, c.fields?.columnOrder ?? -1), -1);
    columnOrderCounters[colId] = max + 1;
  };

  for (const b of approved.beats || []) {
    if (!b.name) { console.warn("[apply] skipped beat with no name", b); continue; }
    const colId = resolveColumn(b.columnHint);
    initCounter(colId);
    const data = {
      type: "beat", title: b.name, archived: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), order: 0,
      fields: {
        ...blankFieldsForType("beat"),
        description: b.description || "",
        structurePosition: b.structurePosition || "",
        columnId: colId,
        columnOrder: columnOrderCounters[colId]++
      }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(b.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "beat", title: b.name, columnId: colId, source: b.source } });
    added++;
    console.log("[apply] added beat", { id: ref.id, name: b.name, columnId: colId });
  }

  for (const s of approved.scenes || []) {
    if (!s.name) { console.warn("[apply] skipped scene with no name", s); continue; }
    const colId = resolveColumn(s.columnHint);
    initCounter(colId);
    const data = {
      type: "scene", title: s.name, archived: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), order: 0,
      fields: {
        ...blankFieldsForType("scene"),
        shortDescription: s.shortDescription || "",
        longDescription:  s.longDescription  || "",
        ragSummary:       s.shortDescription || null,
        ragSummaryStale:  !!s.longDescription,
        columnId: colId,
        columnOrder: columnOrderCounters[colId]++
      }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(s.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "scene", title: s.name, columnId: colId, source: s.source } });
    added++;
    console.log("[apply] added scene", { id: ref.id, name: s.name, columnId: colId });
  }

  for (const u of approved.updates || []) {
    const targetId = nameToCardId.get((u.entityName || "").toLowerCase());
    if (!targetId) continue;
    const card = state.cards.get(targetId);
    if (!card) continue;
    card.fields = card.fields || {};
    const f = u.field;
    if (f === "traits" || f === "history") {
      const arr = Array.isArray(card.fields[f]) ? card.fields[f].slice() : [];
      arr.push(u.addValue);
      card.fields[f] = arr;
    } else if (f === "role" || f === "description") {
      card.fields[f] = card.fields[f] ? (card.fields[f] + "\n" + u.addValue) : u.addValue;
    } else {
      card.fields[f] = u.addValue;
    }
    // Stale impact for updates from LLM parsing
    const impact = staleImpact("card-" + card.type, f);
    const extra = {};
    if (impact?.self) {
      card.fields[impact.self.field] = impact.self.value;
      extra[`fields.${impact.self.field}`] = impact.self.value;
    }
    await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", targetId), {
      [`fields.${f}`]: card.fields[f],
      ...extra,
      updatedAt: serverTimestamp()
    });
    auditBatch.push({ entityType: "card", entityId: targetId, field: f, oldValue: null, newValue: u.addValue });
  }

  for (const c of approved.connections || []) {
    const fromId = nameToCardId.get((c.from || "").toLowerCase());
    const toId   = nameToCardId.get((c.to   || "").toLowerCase());
    if (!fromId || !toId) continue;
    const data = {
      fromCardId: fromId, toCardId: toId,
      label: c.label || "", createdAt: serverTimestamp()
    };
    const ref = await addDoc(connCol, data);
    state.connections.set(ref.id, { id: ref.id, ...data });
    auditBatch.push({ entityType: "connection", entityId: ref.id, field: "created", oldValue: null, newValue: { fromCardId: fromId, toCardId: toId, label: data.label } });
  }

  // Story Settings — merge into project.storySettings if anything approved.
  const ssApproved = approved.storySettings || [];
  if (ssApproved.length) {
    const current = { ...(state.project.storySettings || {}) };
    if (!Array.isArray(current.anchorConcepts)) current.anchorConcepts = [];
    let ssChanged = false;
    for (const item of ssApproved) {
      if (item._ssField === "genre" && item.value) {
        if (current.genre !== item.value) { current.genre = item.value; ssChanged = true; }
      } else if (item._ssField === "premise" && item.value) {
        if (current.premise !== item.value) { current.premise = item.value; ssChanged = true; }
      } else if (item._ssField === "anchor" && item.term) {
        const existing = current.anchorConcepts.find(a => a.term.toLowerCase() === item.term.toLowerCase());
        if (existing) {
          if (existing.definition !== item.definition && item.definition) {
            existing.definition = item.definition;
            ssChanged = true;
          }
        } else {
          current.anchorConcepts.push({ term: item.term, definition: item.definition || "" });
          ssChanged = true;
        }
      }
    }
    if (ssChanged) {
      state.project.storySettings = current;
      await updateDoc(doc(db, "users", state.user.uid, "projects", projectId), {
        storySettings: current,
        updatedAt: serverTimestamp()
      });
      auditBatch.push({ entityType: "project", entityId: projectId, field: "storySettings", oldValue: null, newValue: current });
      console.log("[apply] storySettings merged", current);
    }
  }

  if (auditBatch.length) {
    await logAudit(state.user.uid, projectId, auditBatch, state.project);
  }
  await touchProject();
  console.log("[apply] complete", { added, totalCardsNow: state.cards.size });
  rebuildGraphElements();
  updateRefreshNudge();
}

async function applyWizardAnswers(answers) {
  if (!answers || answers.length === 0) return;

  // Convert the structured Q+A into a "note" the same way the user would
  // type one, then run it through parseSidePanelNote so the LLM:
  //   - turns prose answers into clean trait/history bullets
  //   - proposes updates to the right cards (matched by question target)
  //   - surfaces any new entities the writer revealed in their answer
  //   - shows everything in the approval modal so the writer keeps control
  // Previously we just appended each answer string verbatim — which gave
  // raw prose dumps in fields meant for tight bullets.
  if (isConfigured()) {
    const noteLines = ["Follow-up answers from the clarification wizard. Use these to update the right cards with clean bullets, not raw prose:"];
    for (const a of answers) {
      if (!a.answer) continue;
      noteLines.push("");
      const target = a.targetEntityName ? ` (about: ${a.targetEntityName})` : "";
      noteLines.push(`Q${target}: ${a.question}`);
      noteLines.push(`A: ${a.answer}`);
    }
    const noteText = noteLines.join("\n");
    const { ok, result: parsed } = await runLLMAction(
      "Processing wizard answers",
      () => parseSidePanelNote(noteText, existingEntitySummaries())
    );
    if (ok && parsed && typeof parsed === "object") {
      openApprovalModal(parsed, {
        title: "Review what the LLM extracted from your wizard answers",
        onApprove: async (approved) => {
          try {
            await applyApprovedItems(approved);
          } catch (err) {
            console.error("[wizard-answers] applyApprovedItems failed", err);
            alert("Saving approved items failed: " + (err.message || err));
          }
        }
      });
      return;
    }
    // If the LLM call failed (alert already shown by runLLMAction), fall
    // through to the raw-append path below so the writer's answers aren't lost.
    console.warn("[wizard-answers] LLM processing failed; falling back to raw append so answers aren't lost");
  }

  // Fallback: append raw answers to target fields. Same behavior as before.
  const nameToCardId = new Map();
  for (const c of state.cards.values()) {
    if (!c.archived) nameToCardId.set(c.title.toLowerCase(), c.id);
  }

  for (const a of answers) {
    if (!a.answer) continue;
    // Project-level fields
    if (a.targetEntityType === "project") {
      const patch = {};
      if (a.targetField === "pillars") {
        const arr = Array.isArray(state.project.pillars) ? state.project.pillars.slice() : [];
        arr.push(a.answer);
        state.project.pillars = arr;
        patch.pillars = arr;
      } else if (a.targetField === "logline") {
        state.project.logline = a.answer;
        patch.logline = a.answer;
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = serverTimestamp();
        await updateDoc(doc(db, "users", state.user.uid, "projects", projectId), patch);
      }
      continue;
    }
    // Card-level
    const targetId = a.targetEntityName ? nameToCardId.get(a.targetEntityName.toLowerCase()) : null;
    if (!targetId) continue;
    const card = state.cards.get(targetId);
    if (!card) continue;
    card.fields = card.fields || {};
    const f = a.targetField;
    if (!f) continue;
    if (f === "traits" || f === "history") {
      const arr = Array.isArray(card.fields[f]) ? card.fields[f].slice() : [];
      arr.push(a.answer);
      card.fields[f] = arr;
    } else {
      card.fields[f] = card.fields[f] ? (card.fields[f] + "\n" + a.answer) : a.answer;
    }
    const impact = staleImpact("card-" + card.type, f);
    const extra = {};
    if (impact?.self) {
      card.fields[impact.self.field] = impact.self.value;
      extra[`fields.${impact.self.field}`] = impact.self.value;
    }
    await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", targetId), {
      [`fields.${f}`]: card.fields[f],
      ...extra,
      updatedAt: serverTimestamp()
    });
    await logAudit(state.user.uid, projectId, [{
      entityType: "card", entityId: targetId, field: f, oldValue: null, newValue: a.answer
    }], state.project);
  }

  await touchProject();
  rebuildGraphElements();
  updateRefreshNudge();
}

function switchView(name) {
  els.tabs.forEach(t => t.classList.toggle("active", t.dataset.view === name));
  hide(els.graphView);
  hide(els.outlineView);
  hide(els.reviewView);
  hide(els.archiveView);
  hide(els.kanbanView);
  hide(els.oracleView);
  hide(els.captureView);
  hideCardEditor();

  // Strip outline-only chrome (beat spine, prologue/epilogue sections) when
  // switching to any view other than outline. Otherwise they shadow other views.
  if (name !== "outline") {
    document.getElementById("beatSpine")?.remove();
    document.getElementById("prologueSection")?.remove();
    document.getElementById("epilogueSection")?.remove();
  }

  if (name === "capture") {
    show(els.captureView);
    setMobileTabActive("capture");
  } else if (name === "graph") {
    show(els.graphView);
    initOrRefreshGraph();
    setMobileTabActive(null);
  } else if (name === "outline") {
    show(els.outlineView);
    renderOutline();
  } else if (name === "review") {
    show(els.reviewView);
    maybeShowRefreshNudge();
    renderReviewPanel(els.reviewView, state, projectId, {
      onChanged: () => { rebuildGraphElements(); updateRefreshNudge(); }
    });
  } else if (name === "kanban") {
    show(els.kanbanView);
    renderKanban();
  } else if (name === "oracle") {
    show(els.oracleView);
    renderOracle(els.oracleView);
  } else if (name === "archive") {
    show(els.archiveView);
    renderArchive();
  }
}

// --- Kanban ---

function renderKanban() {
  els.kanbanBoard.innerHTML = "";
  const scenes = [...state.cards.values()]
    .filter(c => c.type === "scene" && !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const stage of KANBAN_STAGES) {
    const col = document.createElement("div");
    col.className = "kanban-col";
    col.dataset.stage = stage.id;
    const inThisStage = scenes.filter(s => (s.fields?.kanbanStage || "idea") === stage.id);
    col.innerHTML = `
      <header class="kanban-col-head">
        <h3>${esc(stage.label)}</h3>
        <span class="muted small">${inThisStage.length}</span>
      </header>
      <div class="kanban-col-body"></div>
    `;
    const bodyEl = col.querySelector(".kanban-col-body");
    for (const s of inThisStage) {
      bodyEl.appendChild(makeKanbanCard(s));
    }
    col.addEventListener("dragover", e => {
      e.preventDefault();
      col.classList.add("drop-target");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop-target"));
    col.addEventListener("drop", async e => {
      e.preventDefault();
      col.classList.remove("drop-target");
      const cardId = e.dataTransfer.getData("text/plain");
      if (!cardId) return;
      await setKanbanStage(cardId, stage.id);
      renderKanban();
    });
    els.kanbanBoard.appendChild(col);
  }
}

function makeKanbanCard(scene) {
  const div = document.createElement("article");
  div.className = "kanban-card";
  div.draggable = true;
  div.dataset.cardId = scene.id;
  const stale = scene.fields?.ragSummaryStale ? '<span class="stale-icon">⚠</span>' : "";
  div.innerHTML = `
    <h4>${esc(scene.title)} ${stale}</h4>
    <p class="muted small">${esc(scene.fields?.shortDescription || scene.fields?.ragSummary || "")}</p>
  `;
  div.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/plain", scene.id);
    e.dataTransfer.effectAllowed = "move";
    div.classList.add("dragging");
  });
  div.addEventListener("dragend", () => div.classList.remove("dragging"));
  div.addEventListener("click", () => {
    switchView("graph");
    openCardEditor(scene.id);
  });
  return div;
}

async function setKanbanStage(cardId, newStage) {
  const card = state.cards.get(cardId);
  if (!card || card.type !== "scene") return;
  const oldStage = card.fields?.kanbanStage || "idea";
  if (oldStage === newStage) return;
  card.fields = card.fields || {};
  card.fields.kanbanStage = newStage;
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId), {
    "fields.kanbanStage": newStage,
    updatedAt: serverTimestamp()
  });
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: "kanbanStage", oldValue: oldStage, newValue: newStage
  }], state.project);
  await touchProject();
  updateRefreshNudge();
}

// --- Graph ---

function initOrRefreshGraph() {
  if (!state.cy) {
    state.cy = cytoscape({
      container: document.getElementById("cy"),
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#3a3a4a",
            "label": "data(label)",
            "color": "#e8e8e8",
            "text-valign": "center",
            "text-halign": "center",
            "text-wrap": "wrap",
            "text-max-width": "120px",
            "font-size": 12,
            "width": 140,
            "height": 60,
            "shape": "round-rectangle",
            "border-width": 2,
            "border-color": "#555",
            "padding": 8
          }
        },
        { selector: "node[type='character']", style: { "background-color": "#3b5278", "border-color": "#5a7fb8" } },
        { selector: "node[type='scene']",     style: { "background-color": "#5a3b78", "border-color": "#8a5fb8" } },
        { selector: "node[type='beat']",      style: { "background-color": "#7a652e", "border-color": "#e0b95a", "shape": "diamond", "width": 160, "height": 80 } },
        { selector: "node[type='theme']",     style: { "background-color": "#785a3b", "border-color": "#b88a5f" } },
        { selector: "node[type='location']",  style: { "background-color": "#3b7860", "border-color": "#5fb890" } },
        { selector: "node[type='arc']",       style: { "background-color": "#78443b", "border-color": "#b8685f" } },
        {
          selector: "edge",
          style: {
            "width": 2,
            "line-color": "#666",
            "target-arrow-color": "#666",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "label": "data(label)",
            "font-size": 10,
            "color": "#bbb",
            "text-background-color": "#1c1c22",
            "text-background-opacity": 1,
            "text-background-padding": 2
          }
        },
        { selector: ".connect-source", style: { "border-color": "#ffd45a", "border-width": 4 } },
        { selector: "node[stale='1']", style: { "border-style": "dashed", "border-color": "#e0b95a" } }
      ],
      layout: { name: "cose", animate: false }
    });

    state.cy.on("tap", "node", evt => {
      const id = evt.target.id();
      if (state.connectMode) {
        handleConnectTap(id);
      } else {
        openCardEditor(id);
      }
    });
    state.cy.on("tap", "edge", evt => {
      const id = evt.target.id();
      openConnectionEditor(id);
    });
    state.cy.on("tap", evt => {
      if (evt.target === state.cy) {
        if (state.connectMode) cancelConnectMode();
        hideCardEditor();
        hideConnectionEditor();
      }
    });
  }
  rebuildGraphElements();
}

// Cards visible on the Canvas. Scenes are excluded — they live exclusively
// in the Outline. Beats stay on Canvas too (they're structural anchors that
// can have relationships) but their primary home is Outline.
const CANVAS_CARD_TYPES = new Set(["character", "location", "theme", "arc", "beat"]);

function rebuildGraphElements() {
  if (!state.cy) {
    console.warn("[graph] rebuildGraphElements: state.cy is not initialized yet");
    return;
  }

  // Capture current positions of existing nodes BEFORE we remove anything.
  // We'll re-apply them when nodes are re-added so the user's hand-arranged
  // graph doesn't shuffle every time they add a card from a note.
  const existingPositions = new Map();
  state.cy.nodes().forEach(n => {
    existingPositions.set(n.id(), { ...n.position() });
  });
  const isFirstRender = existingPositions.size === 0;

  state.cy.elements().remove();
  const nodes = [];
  for (const card of state.cards.values()) {
    if (card.archived) continue;
    if (!CANVAS_CARD_TYPES.has(card.type)) continue;
    const f = card.fields || {};
    const stale = !!(f.storyRoleSummaryStale || f.ragSummaryStale || f.summaryStale);
    const node = {
      data: {
        id: card.id,
        label: (stale ? "⚠ " : "") + (card.title || `(untitled ${card.type})`),
        type: card.type,
        stale: stale ? "1" : "0"
      }
    };
    // If this node existed before, preset its position so it stays put.
    if (existingPositions.has(card.id)) {
      node.position = existingPositions.get(card.id);
    }
    nodes.push(node);
  }
  const edges = [];
  const activeIds = new Set(nodes.map(n => n.data.id));
  for (const c of state.connections.values()) {
    if (!activeIds.has(c.fromCardId) || !activeIds.has(c.toCardId)) continue;
    edges.push({
      data: {
        id: c.id,
        source: c.fromCardId,
        target: c.toCardId,
        label: c.label || ""
      }
    });
  }
  const newNodeIds = nodes.filter(n => !existingPositions.has(n.data.id)).map(n => n.data.id);
  const container = state.cy.container();
  console.log("[graph] rebuilding", {
    nodes: nodes.length,
    edges: edges.length,
    newNodes: newNodeIds.length,
    isFirstRender,
    containerVisible: !els.graphView.classList.contains("hidden"),
    containerSize: container ? { w: container.clientWidth, h: container.clientHeight } : null
  });
  state.cy.add([...nodes, ...edges]);

  // Defer layout to next animation frame so the browser has finished any
  // pending DOM reflow (modal close, view switch, etc.) before Cytoscape
  // measures the container.
  requestAnimationFrame(() => {
    state.cy.resize();

    if (isFirstRender) {
      // No prior layout — run a fresh auto-layout and fit to view.
      const layout = chooseLayout(nodes.length, edges.length);
      console.log("[graph] first-render layout:", layout.name);
      state.cy.layout(layout).run();
      state.cy.fit(undefined, 40);
      return;
    }

    if (newNodeIds.length === 0) {
      // Pure relabel / restyle — no nodes added, no nodes moved.
      // Don't call fit(); the user's pan/zoom is intentional.
      console.log("[graph] no new nodes — skipping layout");
      return;
    }

    // Some existing, some new: keep existing positions, place new ones near
    // the current viewport center with a small spiral spacing so they don't
    // overlap each other or the existing graph too aggressively.
    placeNewNodesNearViewport(newNodeIds);
    console.log("[graph] placed", newNodeIds.length, "new node(s) near viewport center");
  });
}

// Position new nodes in a small spiral around the current viewport center
// so they're immediately visible to the user without disturbing the
// hand-arranged positions of existing nodes.
function placeNewNodesNearViewport(newIds) {
  if (!state.cy || newIds.length === 0) return;
  const ext = state.cy.extent(); // graph coords currently visible
  const cx = (ext.x1 + ext.x2) / 2;
  const cy = (ext.y1 + ext.y2) / 2;
  newIds.forEach((id, i) => {
    const node = state.cy.getElementById(id);
    if (!node || !node.length) return;
    // Spiral: angle grows with i, radius grows slowly so we don't fly off-screen
    const angle = i * 0.9;
    const radius = 80 + i * 28;
    node.position({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    });
  });
}

// Cose looks great when there are real edges to pull nodes together, but
// clumps badly when most nodes are isolated (typical early story bible).
// Pick a layout that suits the current shape of the graph.
function chooseLayout(nodeCount, edgeCount) {
  if (nodeCount === 0) return { name: "preset" };
  // No edges → a grid is the cleanest "I can see everything" view.
  if (edgeCount === 0) {
    return { name: "grid", padding: 30, avoidOverlap: true, avoidOverlapPadding: 24 };
  }
  // Few edges relative to nodes → concentric so isolated nodes get their own ring.
  if (edgeCount < nodeCount / 3) {
    return {
      name: "concentric",
      padding: 30,
      minNodeSpacing: 60,
      avoidOverlap: true,
      concentric: n => n.degree(),
      levelWidth: () => 1
    };
  }
  // Connected graph → cose with generous spacing so nodes don't pile up.
  return {
    name: "cose",
    animate: false,
    padding: 30,
    nodeRepulsion: () => 50000,
    idealEdgeLength: () => 140,
    edgeElasticity: () => 80,
    gravity: 0.15,
    numIter: 2000,
    nodeOverlap: 20,
    randomize: false
  };
}

// --- Card CRUD ---

async function createCard(type) {
  if (!CARD_TYPES.includes(type)) return;
  const title = prompt(`New ${type} card — title:`);
  if (title === null) return;
  const trimmed = title.trim();
  if (!trimmed) return;

  const data = {
    type,
    title: trimmed,
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    order: type === "scene" ? nextSceneOrder() : 0,
    fields: blankFieldsForType(type)
  };
  const ref = await addDoc(collection(db, "users", state.user.uid, "projects", projectId, "cards"), data);
  state.cards.set(ref.id, { id: ref.id, ...data });
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type, title: trimmed }
  }], state.project);
  await touchProject();
  rebuildGraphElements();
  updateRefreshNudge();
  openCardEditor(ref.id);
}

function nextSceneOrder() {
  let max = -1;
  for (const c of state.cards.values()) {
    if (c.type === "scene" && !c.archived && typeof c.order === "number" && c.order > max) {
      max = c.order;
    }
  }
  return max + 1;
}

function openCardEditor(cardId) {
  const card = state.cards.get(cardId);
  if (!card) return;
  state.selectedCardId = cardId;
  els.cardEditor.innerHTML = renderEditor(card);
  show(els.cardEditor);
  wireEditor(card);
}

function hideCardEditor() {
  hide(els.cardEditor);
  els.cardEditor.innerHTML = "";
  state.selectedCardId = null;
}

// --- Connection editor (click an edge on the canvas to edit/delete) ---

function openConnectionEditor(connId) {
  const conn = state.connections.get(connId);
  if (!conn) return;
  const editor = document.getElementById("connectionEditor");
  if (!editor) return;
  const from = state.cards.get(conn.fromCardId);
  const to = state.cards.get(conn.toCardId);
  const fromTitle = from?.title || "(unknown)";
  const toTitle = to?.title || "(unknown)";
  editor.innerHTML = `
    <div class="editor-header">
      <span class="badge">connection</span>
      <button class="ghost small close-conn-editor" aria-label="Close">✕</button>
    </div>
    <p class="muted small"><strong>${esc(fromTitle)}</strong> → <strong>${esc(toTitle)}</strong></p>
    <label>Label
      <input type="text" id="connLabelInput" value="${attr(conn.label || "")}" placeholder="e.g. appears in, conflicts with, mentors" />
    </label>
    <div class="editor-actions">
      <button class="primary small save-conn">Save label</button>
      <button class="danger small delete-conn">Delete connection</button>
    </div>
  `;
  show(editor);
  hideCardEditor();
  editor.querySelector(".close-conn-editor").addEventListener("click", hideConnectionEditor);
  editor.querySelector(".save-conn").addEventListener("click", () => saveConnectionLabel(connId));
  editor.querySelector(".delete-conn").addEventListener("click", () => deleteConnection(connId));
  // Enter to save
  editor.querySelector("#connLabelInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); saveConnectionLabel(connId); }
  });
  // Focus the label input so user can type immediately
  setTimeout(() => editor.querySelector("#connLabelInput")?.focus(), 0);
}

function hideConnectionEditor() {
  const editor = document.getElementById("connectionEditor");
  if (!editor) return;
  hide(editor);
  editor.innerHTML = "";
}

async function saveConnectionLabel(connId) {
  const conn = state.connections.get(connId);
  if (!conn) return;
  const editor = document.getElementById("connectionEditor");
  const input = editor?.querySelector("#connLabelInput");
  if (!input) return;
  const newLabel = input.value.trim();
  const oldLabel = conn.label || "";
  if (newLabel === oldLabel) { hideConnectionEditor(); return; }
  conn.label = newLabel;
  await updateDoc(
    doc(db, "users", state.user.uid, "projects", projectId, "connections", connId),
    { label: newLabel }
  );
  await logAudit(state.user.uid, projectId, [{
    entityType: "connection", entityId: connId, field: "label", oldValue: oldLabel, newValue: newLabel
  }], state.project);
  hideConnectionEditor();
  rebuildGraphElements();
  await touchProject();
  updateRefreshNudge();
}

async function deleteConnection(connId) {
  const conn = state.connections.get(connId);
  if (!conn) return;
  const from = state.cards.get(conn.fromCardId);
  const to = state.cards.get(conn.toCardId);
  const label = conn.label || "(no label)";
  if (!confirm(`Delete connection "${label}" from "${from?.title || "?"}" → "${to?.title || "?"}"?`)) return;
  await deleteDoc(doc(db, "users", state.user.uid, "projects", projectId, "connections", connId));
  state.connections.delete(connId);
  await logAudit(state.user.uid, projectId, [{
    entityType: "connection", entityId: connId, field: "deleted", oldValue: { ...conn }, newValue: null
  }], state.project);
  hideConnectionEditor();
  rebuildGraphElements();
  await touchProject();
  updateRefreshNudge();
}

function renderEditor(card) {
  const f = card.fields || {};
  let typeSpecific = "";
  let summarySection = "";
  if (card.type === "character") {
    summarySection = renderSummaryBlock(card, "storyRoleSummary", "Story Role Summary", f.storyRoleSummaryStale);
  } else if (card.type === "scene") {
    summarySection = renderSummaryBlock(card, "ragSummary", "RAG Summary", f.ragSummaryStale);
  }
  if (card.type === "character") {
    typeSpecific = `
      <label>Role <input data-field="role" value="${attr(f.role)}" /></label>
      <label>Age <input data-field="age" value="${attr(f.age)}" /></label>
      <label>Physical Description <textarea data-field="physicalDescription" rows="2">${esc(f.physicalDescription)}</textarea></label>
      <label>History (one bullet per line) <textarea data-field="history" data-list="1" rows="3">${esc((f.history||[]).join("\n"))}</textarea></label>
      <label>Traits (one bullet per line) <textarea data-field="traits" data-list="1" rows="3">${esc((f.traits||[]).join("\n"))}</textarea></label>
    `;
  } else if (card.type === "scene") {
    typeSpecific = `
      <label>Short Description <textarea data-field="shortDescription" rows="2">${esc(f.shortDescription)}</textarea></label>
      <label>Long Description <textarea data-field="longDescription" rows="5">${esc(f.longDescription)}</textarea></label>
      ${renderBeatPickerForScene(card)}
      ${renderMultiTagPicker(card, "characterIds", "Characters", "character")}
      ${renderMultiTagPicker(card, "locationIds",  "Locations",  "location")}
      ${renderMultiTagPicker(card, "arcIds",       "Arcs",       "arc")}
    `;
  } else if (card.type === "theme" || card.type === "location") {
    typeSpecific = `<label>Description <textarea data-field="description" rows="3">${esc(f.description)}</textarea></label>`;
  } else if (card.type === "arc") {
    const staleTag = f.summaryStale ? ' <span class="stale-icon" title="Stale — re-run Refresh">⚠ stale</span>' : "";
    typeSpecific = `<label>Summary${staleTag} <textarea data-field="summary" rows="4">${esc(f.summary)}</textarea></label>`;
  } else if (card.type === "beat") {
    const staleTag = f.summaryStale ? ' <span class="stale-icon" title="Stale — re-run Refresh">⚠ stale</span>' : "";
    typeSpecific = `
      <label>Description <textarea data-field="description" rows="3">${esc(f.description)}</textarea></label>
      <label>Structure position <input data-field="structurePosition" value="${attr(f.structurePosition)}" placeholder="e.g. Inciting Incident, Midpoint, Act 2 Turn, Catalyst" /></label>
      <label>Order along the story <input data-field="order" data-top="1" type="number" value="${attr(card.order ?? 0)}" /></label>
      <label>Summary${staleTag} <textarea data-field="summary" rows="3">${esc(f.summary)}</textarea></label>
      ${renderMultiTagPicker(card, "relatedSceneIds", "Scenes that implement this beat", "scene")}
      ${renderMultiTagPicker(card, "relatedArcIds",  "Arcs this beat advances",         "arc")}
    `;
  }
  return `
    <div class="editor-header">
      <span class="badge ${card.type}">${card.type}</span>
      <button class="ghost small close-editor">Close</button>
    </div>
    <label>Title <input data-field="title" data-top="1" value="${attr(card.title)}" /></label>
    ${typeSpecific}
    ${summarySection}
    <div class="editor-actions">
      <button class="ghost small toggle-connect">Connect to…</button>
      ${card.type === "character" ? `<button class="ghost small suggest-traits">Suggest traits…</button>` : ""}
      <button class="ghost small merge-into" title="Merge this card into another of the same type">Merge into…</button>
      <button class="danger small archive-card">Archive</button>
    </div>
    <p class="muted small">Changes save on blur.</p>
  `;
}

function renderBeatPickerForScene(scene) {
  const beats = [...state.cards.values()]
    .filter(c => c.type === "beat" && !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (beats.length === 0) {
    return `<div class="muted small">No beats yet. Add a Beat card to organize scenes under structural moments.</div>`;
  }
  let currentBeatId = "";
  for (const b of beats) {
    if ((b.fields?.relatedSceneIds || []).includes(scene.id)) {
      currentBeatId = b.id;
      break;
    }
  }
  return `
    <label>Beat
      <select data-beat-picker="${scene.id}">
        <option value=""${currentBeatId === "" ? " selected" : ""}>— No beat —</option>
        ${beats.map(b => `<option value="${b.id}"${currentBeatId === b.id ? " selected" : ""}>${esc(b.title)}${b.fields?.structurePosition ? ` (${esc(b.fields.structurePosition)})` : ""}</option>`).join("")}
      </select>
    </label>
  `;
}

function renderMultiTagPicker(card, fieldName, label, targetType) {
  const f = card.fields || {};
  const selected = new Set(f[fieldName] || []);
  const opts = [...state.cards.values()]
    .filter(c => c.type === targetType && !c.archived)
    .map(c => c.id);
  if (opts.length === 0) {
    return `<div class="muted small">No ${esc(targetType)} cards to tag yet.</div>`;
  }
  return `
    <label>${esc(label)}
      <div class="tag-picker" data-field="${fieldName}">
        ${opts.map(id => {
          const c = state.cards.get(id);
          const checked = selected.has(id) ? "checked" : "";
          return `<label class="tag-chip"><input type="checkbox" data-tag-id="${id}" ${checked} /> ${esc(c.title)}</label>`;
        }).join("")}
      </div>
    </label>
  `;
}

function renderSummaryBlock(card, field, label, isStale) {
  const f = card.fields || {};
  const val = f[field] || "";
  if (!val && !isStale) {
    return `<div class="summary-block"><div class="summary-label">${esc(label)} <span class="muted small">— not generated yet</span></div></div>`;
  }
  const staleIcon = isStale ? `<span class="stale-icon" title="Stale — re-run Refresh">⚠ stale</span>` : "";
  return `
    <div class="summary-block ${isStale ? "is-stale" : ""}">
      <div class="summary-label">${esc(label)} ${staleIcon}</div>
      <label><textarea data-field="${field}" rows="3">${esc(val)}</textarea></label>
    </div>
  `;
}

function wireEditor(card) {
  els.cardEditor.querySelectorAll("input[data-field], textarea[data-field]").forEach(input => {
    input.addEventListener("blur", () => saveField(card.id, input));
  });
  els.cardEditor.querySelectorAll(".tag-picker").forEach(picker => {
    picker.addEventListener("change", () => saveTagPicker(card.id, picker));
  });
  const beatPicker = els.cardEditor.querySelector("[data-beat-picker]");
  beatPicker?.addEventListener("change", async () => {
    await setSceneBeat(card.id, beatPicker.value);
    rebuildGraphElements();
  });
  els.cardEditor.querySelector(".close-editor").addEventListener("click", hideCardEditor);
  els.cardEditor.querySelector(".archive-card").addEventListener("click", () => archiveCard(card.id));
  els.cardEditor.querySelector(".toggle-connect").addEventListener("click", () => startConnectMode(card.id));
  els.cardEditor.querySelector(".suggest-traits")?.addEventListener("click", () => handleSuggestTraits(card.id));
  els.cardEditor.querySelector(".merge-into")?.addEventListener("click", () => openMergePicker(card.id));
}

async function saveTagPicker(cardId, picker) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const fieldName = picker.dataset.field;
  const ids = [...picker.querySelectorAll("input[type=checkbox]")]
    .filter(x => x.checked)
    .map(x => x.dataset.tagId);
  const old = (card.fields?.[fieldName] || []).slice();
  card.fields = card.fields || {};
  card.fields[fieldName] = ids;
  const updates = {
    [`fields.${fieldName}`]: ids,
    updatedAt: serverTimestamp()
  };
  // Scene-arc linkage: if arcIds changed, mark those arcs' summaries stale.
  if (card.type === "scene" && fieldName === "arcIds") {
    const affected = new Set([...old, ...ids]);
    for (const arcId of affected) {
      const arc = state.cards.get(arcId);
      if (arc && arc.type === "arc") {
        arc.fields = arc.fields || {};
        arc.fields.summaryStale = true;
        await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", arcId), {
          "fields.summaryStale": true,
          updatedAt: serverTimestamp()
        });
      }
    }
  }
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId), updates);
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: fieldName, oldValue: old, newValue: ids
  }], state.project);
  updateRefreshNudge();
  rebuildGraphElements();
}

async function handleSuggestTraits(cardId) {
  console.log("[suggest-traits] clicked", { cardId });
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) openSettingsModal();
    return;
  }
  const { ok, result: r } = await runLLMAction(
    "Generating trait suggestions",
    () => suggestTraits(state, cardId)
  );
  if (!ok) return;
  if (!r || !r.suggestions || r.suggestions.length === 0) {
    alert("No trait suggestions came back. Check the console for what the LLM returned.");
    return;
  }
  openTraitSuggestModal(r.suggestions, {
    onApply: async (picked) => {
      if (!picked || picked.length === 0) return;
      await applyTraitSuggestions(state, projectId, cardId, picked);
      if (state.selectedCardId === cardId) openCardEditor(cardId);
      rebuildGraphElements();
      updateRefreshNudge();
    }
  });
}

async function saveField(cardId, input) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const fieldName = input.dataset.field;
  const isList = input.dataset.list === "1";
  const isTop = input.dataset.top === "1";
  let value = input.value;
  if (isList) {
    value = value.split("\n").map(s => s.trim()).filter(Boolean);
  }
  const updates = { updatedAt: serverTimestamp() };
  const oldValue = isTop ? card[fieldName] : card.fields?.[fieldName];
  if (isTop) {
    card[fieldName] = value;
    updates[fieldName] = value;
    if (fieldName === "title") {
      const node = state.cy?.getElementById(cardId);
      if (node) node.data("label", value);
    }
  } else {
    card.fields = card.fields || {};
    card.fields[fieldName] = value;
    updates[`fields.${fieldName}`] = value;
  }

  // Stale impact
  const impact = staleImpact("card-" + card.type, fieldName);
  if (impact?.self) {
    card.fields = card.fields || {};
    card.fields[impact.self.field] = impact.self.value;
    updates[`fields.${impact.self.field}`] = impact.self.value;
  }

  // If the user is directly editing a summary field, track that
  if (["storyRoleSummary", "ragSummary", "summary"].includes(fieldName)) {
    const flag = fieldName + "_userEdited";
    card.fields = card.fields || {};
    card.fields[flag] = true;
    updates[`fields.${flag}`] = true;
  }

  const ref = doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId);
  await updateDoc(ref, updates);
  await logAudit(state.user.uid, projectId, [{
    entityType: "card",
    entityId: cardId,
    field: fieldName,
    oldValue,
    newValue: value
  }], state.project);
  updateRefreshNudge();
}

// Merge this card INTO another card of the same type. The other card stays
// (becomes the canonical entry); this card's content is folded in, then
// this card is archived. All connections referencing this card are
// retargeted to the canonical card so the graph stays correct.
function openMergePicker(sourceId) {
  const source = state.cards.get(sourceId);
  if (!source) return;
  const candidates = [...state.cards.values()]
    .filter(c => c.type === source.type && c.id !== source.id && !c.archived)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (candidates.length === 0) {
    alert(`No other ${source.type} cards to merge with.`);
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal merge-picker-modal">
      <div class="modal-header">
        <h2>Merge "${esc(source.title)}" into…</h2>
        <button class="ghost small close-modal">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted small">Pick the card you want to keep. "${esc(source.title)}" will be archived and its content (description, traits, history, tags, connections) folded into the one you pick. Cannot be undone via UI, but the archived card stays in the Archive tab.</p>
        <ul class="merge-candidate-list">
          ${candidates.map(c => `
            <li><button type="button" class="merge-pick" data-id="${attr(c.id)}">
              <strong>${esc(c.title)}</strong>
              ${c.fields?.role ? `<span class="muted small"> — ${esc(c.fields.role)}</span>` : ""}
            </button></li>
          `).join("")}
        </ul>
      </div>
      <div class="modal-actions">
        <button class="ghost cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".close-modal").addEventListener("click", close);
  overlay.querySelector(".cancel").addEventListener("click", close);
  overlay.querySelectorAll(".merge-pick").forEach(btn => {
    btn.addEventListener("click", async () => {
      close();
      await mergeCards(sourceId, btn.dataset.id);
    });
  });
}

async function mergeCards(sourceId, targetId) {
  const source = state.cards.get(sourceId);
  const target = state.cards.get(targetId);
  if (!source || !target) return;
  if (source.type !== target.type) {
    alert("Can only merge cards of the same type.");
    return;
  }

  // Merge field-by-field. Arrays union (dedup case-insensitively); strings
  // concatenate with a separator if both non-empty; primitives prefer target.
  const tgtFields = target.fields = target.fields || {};
  const srcFields = source.fields || {};
  const audits = [];
  const stringFields = ["role", "physicalDescription", "age", "description", "summary", "shortDescription", "longDescription", "structurePosition", "storyRoleSummary", "ragSummary"];
  const arrayFields = ["history", "traits", "characterIds", "locationIds", "arcIds", "relatedSceneIds", "relatedArcIds"];

  const updates = {};
  for (const f of stringFields) {
    const src = (srcFields[f] || "").trim();
    if (!src) continue;
    const tgt = (tgtFields[f] || "").trim();
    if (!tgt) {
      tgtFields[f] = src;
      updates[`fields.${f}`] = src;
    } else if (!tgt.includes(src)) {
      tgtFields[f] = tgt + "\n" + src;
      updates[`fields.${f}`] = tgtFields[f];
    }
  }
  for (const f of arrayFields) {
    const src = Array.isArray(srcFields[f]) ? srcFields[f] : [];
    if (src.length === 0) continue;
    const tgt = Array.isArray(tgtFields[f]) ? tgtFields[f].slice() : [];
    let changed = false;
    const seenLower = new Set(tgt.map(v => String(v).toLowerCase()));
    for (const v of src) {
      const key = String(v).toLowerCase();
      if (!seenLower.has(key)) {
        tgt.push(v);
        seenLower.add(key);
        changed = true;
      }
    }
    if (changed) {
      tgtFields[f] = tgt;
      updates[`fields.${f}`] = tgt;
    }
  }
  // Mark target's summary stale since content changed
  if (Object.keys(updates).length > 0) {
    if (target.type === "character") { tgtFields.storyRoleSummaryStale = true; updates["fields.storyRoleSummaryStale"] = true; }
    if (target.type === "scene")     { tgtFields.ragSummaryStale       = true; updates["fields.ragSummaryStale"]       = true; }
    if (target.type === "arc" || target.type === "beat") {
      tgtFields.summaryStale = true; updates["fields.summaryStale"] = true;
    }
    updates.updatedAt = serverTimestamp();
    await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", targetId), updates);
    audits.push({ entityType: "card", entityId: targetId, field: "merged-from", oldValue: null, newValue: { sourceId, sourceTitle: source.title } });
  }

  // Retarget connections that point to/from source → target
  for (const conn of [...state.connections.values()]) {
    let changed = false;
    const patch = {};
    if (conn.fromCardId === sourceId) { patch.fromCardId = targetId; conn.fromCardId = targetId; changed = true; }
    if (conn.toCardId === sourceId)   { patch.toCardId   = targetId; conn.toCardId   = targetId; changed = true; }
    if (changed) {
      // Avoid creating a self-loop on the target
      if (conn.fromCardId === conn.toCardId) {
        await deleteDoc(doc(db, "users", state.user.uid, "projects", projectId, "connections", conn.id));
        state.connections.delete(conn.id);
        audits.push({ entityType: "connection", entityId: conn.id, field: "deleted-during-merge", oldValue: null, newValue: null });
      } else {
        await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "connections", conn.id), patch);
        audits.push({ entityType: "connection", entityId: conn.id, field: "retargeted-during-merge", oldValue: { from: source.id }, newValue: { from: target.id } });
      }
    }
  }

  // Archive the source card (don't hard-delete — preserves history and audit)
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", sourceId), {
    archived: true,
    "fields.mergedIntoId": targetId,
    updatedAt: serverTimestamp()
  });
  source.archived = true;
  source.fields = source.fields || {};
  source.fields.mergedIntoId = targetId;
  audits.push({ entityType: "card", entityId: sourceId, field: "merged-into", oldValue: null, newValue: targetId });

  await logAudit(state.user.uid, projectId, audits, state.project);
  await touchProject();
  hideCardEditor();
  rebuildGraphElements();
  updateRefreshNudge();
  alert(`Merged "${source.title}" into "${target.title}". The merged card is in the Archive tab if you need it back.`);
  openCardEditor(targetId);
}

async function archiveCard(cardId) {
  if (!confirm("Archive this card? You can restore it from the Archive tab.")) return;
  const ref = doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId);
  await updateDoc(ref, { archived: true, updatedAt: serverTimestamp() });
  const card = state.cards.get(cardId);
  if (card) card.archived = true;
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: "archived", oldValue: false, newValue: true
  }], state.project);
  await touchProject();
  hideCardEditor();
  rebuildGraphElements();
  updateRefreshNudge();
}

async function restoreCard(cardId) {
  const ref = doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId);
  await updateDoc(ref, { archived: false, updatedAt: serverTimestamp() });
  const card = state.cards.get(cardId);
  if (card) card.archived = false;
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: "archived", oldValue: true, newValue: false
  }], state.project);
  await touchProject();
  renderArchive();
  updateRefreshNudge();
}

// --- Connections ---

function startConnectMode(cardId) {
  state.connectMode = true;
  state.connectFrom = cardId;
  hideCardEditor();
  state.cy.nodes().removeClass("connect-source");
  state.cy.getElementById(cardId).addClass("connect-source");
  flashStatus(`Pick another card to connect to "${state.cards.get(cardId)?.title}". Click background to cancel.`);
}

function cancelConnectMode() {
  state.connectMode = false;
  state.connectFrom = null;
  state.cy?.nodes().removeClass("connect-source");
  clearStatus();
}

async function handleConnectTap(toId) {
  if (toId === state.connectFrom) {
    cancelConnectMode();
    return;
  }
  const label = prompt("Connection label (e.g. 'appears in', 'conflicts with'):", "");
  const fromId = state.connectFrom;
  cancelConnectMode();
  if (label === null) return;
  const data = {
    fromCardId: fromId,
    toCardId: toId,
    label: label.trim(),
    createdAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "users", state.user.uid, "projects", projectId, "connections"), data);
  state.connections.set(ref.id, { id: ref.id, ...data });
  await logAudit(state.user.uid, projectId, [{
    entityType: "connection", entityId: ref.id, field: "created", oldValue: null,
    newValue: { fromCardId: fromId, toCardId: toId, label: data.label }
  }], state.project);
  await touchProject();
  rebuildGraphElements();
  updateRefreshNudge();
}

// --- Outline (Trello-style columns) ---

function renderOutline() {
  // Tear down any previous outline DOM
  els.outlineList.innerHTML = "";
  document.getElementById("beatSpine")?.remove();
  document.getElementById("outlineBoard")?.remove();

  const columns = getColumnsForProject(state.project);

  // Build a board container that holds all columns horizontally.
  const board = document.createElement("div");
  board.id = "outlineBoard";
  board.className = "outline-board";
  els.outlineList.parentNode.insertBefore(board, els.outlineList);

  // Cards (scenes + beats) for the outline, grouped by column.
  const cardsByColumn = new Map(); // columnId -> [cards]
  const orphaned = []; // cards whose columnId doesn't match any column
  const validColumnIds = new Set(columns.map(c => c.id));

  for (const c of state.cards.values()) {
    if (c.archived) continue;
    if (c.type !== "scene" && c.type !== "beat") continue;
    const colId = c.fields?.columnId || "";
    if (!validColumnIds.has(colId)) {
      orphaned.push(c);
      continue;
    }
    if (!cardsByColumn.has(colId)) cardsByColumn.set(colId, []);
    cardsByColumn.get(colId).push(c);
  }
  for (const arr of cardsByColumn.values()) {
    arr.sort((a, b) => (a.fields?.columnOrder ?? 0) - (b.fields?.columnOrder ?? 0));
  }

  for (const col of columns) {
    board.appendChild(renderColumn(col, cardsByColumn.get(col.id) || []));
  }
  if (orphaned.length) {
    const unassigned = { id: "__unassigned__", label: "Unassigned (from old structure)", isMain: false };
    board.appendChild(renderColumn(unassigned, orphaned));
  }

  // The original <ol id="outlineList"> is now empty and not used as the main
  // surface — but keep it for the (hidden) outlineEmpty fallback.
  hide(els.outlineEmpty);
}

function renderColumn(col, cards) {
  const colEl = document.createElement("section");
  colEl.className = "outline-column";
  colEl.dataset.colId = col.id;
  if (col.isPrologue) colEl.classList.add("col-prologue");
  if (col.isEpilogue) colEl.classList.add("col-epilogue");

  const head = document.createElement("header");
  head.className = "outline-col-head";
  const hasGuidance = (col.description && col.description.length > 0) || (Array.isArray(col.guidance) && col.guidance.length > 0);
  head.innerHTML = `
    <div class="outline-col-head-top">
      <h3>${esc(col.label)}</h3>
      ${hasGuidance ? `<button class="outline-col-help-btn ghost small" type="button" title="Show writing guidance" aria-expanded="false">?</button>` : ""}
      <span class="muted small outline-col-count">${cards.length} card${cards.length === 1 ? "" : "s"}</span>
    </div>
    ${hasGuidance ? `
      <div class="outline-col-help hidden">
        ${col.description ? `<p class="outline-col-desc">${esc(col.description)}</p>` : ""}
        ${Array.isArray(col.guidance) && col.guidance.length ? `
          <ul class="outline-col-guidance">
            ${col.guidance.map(g => `<li>${esc(g)}</li>`).join("")}
          </ul>` : ""}
      </div>` : ""}
  `;
  if (hasGuidance) {
    const btn = head.querySelector(".outline-col-help-btn");
    const panel = head.querySelector(".outline-col-help");
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      panel.classList.toggle("hidden", expanded);
      btn.textContent = expanded ? "?" : "✕";
    });
  }
  colEl.appendChild(head);

  const body = document.createElement("div");
  body.className = "outline-col-body";
  colEl.appendChild(body);

  // Drop zone covering the whole column, for cross-column drops at the END.
  colEl.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    colEl.classList.add("drop-target");
  });
  colEl.addEventListener("dragleave", e => {
    if (!colEl.contains(e.relatedTarget)) colEl.classList.remove("drop-target");
  });
  colEl.addEventListener("drop", async e => {
    e.preventDefault();
    colEl.classList.remove("drop-target");
    const cardId = e.dataTransfer.getData("text/plain");
    if (!cardId) return;
    // If the drop happened on a specific card slot it'll be handled there.
    // Falling through to here means: drop at the end of this column.
    if (e.target.closest(".outline-card")) return;
    await moveCardToColumn(cardId, col.id, /*beforeCardId*/ null);
    renderOutline();
  });

  for (const card of cards) {
    body.appendChild(renderOutlineCard(card, col));
  }

  const addRow = document.createElement("div");
  addRow.className = "outline-col-actions";
  addRow.innerHTML = `
    <button class="ghost small add-scene">+ Scene</button>
    <button class="ghost small add-beat">+ Beat</button>
    <button class="ghost small suggest-scene" title="Have the LLM propose a bridging scene at the end of this column">🎲 Suggest scene</button>
  `;
  addRow.querySelector(".add-scene").addEventListener("click", () => createCardInColumn("scene", col.id));
  addRow.querySelector(".add-beat").addEventListener("click", () => createCardInColumn("beat", col.id));
  addRow.querySelector(".suggest-scene").addEventListener("click", () => {
    const lastSceneId = [...cards].reverse().find(c => c.type === "scene")?.id || null;
    handleScenePlus(lastSceneId, null, col.id);
  });
  colEl.appendChild(addRow);

  return colEl;
}

function renderOutlineCard(card, col) {
  const el = document.createElement("article");
  el.className = "outline-card outline-card-" + card.type;
  el.draggable = true;
  el.dataset.cardId = card.id;
  const f = card.fields || {};
  const stale = (f.ragSummaryStale || f.summaryStale)
    ? '<span class="stale-icon" title="Summary needs refresh">⚠</span>'
    : "";
  const sub = card.type === "beat"
    ? (f.structurePosition || f.description || f.summary || "")
    : (f.shortDescription || f.ragSummary || "");
  el.innerHTML = `
    <div class="outline-card-head">
      <span class="badge ${esc(card.type)}">${esc(card.type)}</span>
      <span class="outline-card-title">${esc(card.title)}</span>
      ${stale}
    </div>
    ${sub ? `<p class="outline-card-sub muted small">${esc(sub)}</p>` : ""}
  `;
  el.addEventListener("click", e => {
    if (e.target.closest(".drag-handle")) return;
    openCardEditor(card.id);
  });
  el.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/plain", card.id);
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  el.addEventListener("dragover", e => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    el.classList.toggle("drop-before", before);
    el.classList.toggle("drop-after", !before);
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("drop-before", "drop-after");
  });
  el.addEventListener("drop", async e => {
    e.preventDefault();
    e.stopPropagation();
    const droppedId = e.dataTransfer.getData("text/plain");
    el.classList.remove("drop-before", "drop-after");
    if (!droppedId || droppedId === card.id) return;
    const rect = el.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    await moveCardToColumn(droppedId, col.id, before ? card.id : nextCardIdAfter(card.id, col.id));
    renderOutline();
  });
  return el;
}

function nextCardIdAfter(cardId, colId) {
  const cards = [...state.cards.values()]
    .filter(c => !c.archived && (c.type === "scene" || c.type === "beat") && c.fields?.columnId === colId)
    .sort((a, b) => (a.fields?.columnOrder ?? 0) - (b.fields?.columnOrder ?? 0));
  const idx = cards.findIndex(c => c.id === cardId);
  return idx >= 0 && idx + 1 < cards.length ? cards[idx + 1].id : null;
}

// Move a card to a given column at a position determined by beforeCardId
// (null = append to the end). Reassigns columnOrder for affected cards.
async function moveCardToColumn(cardId, newColId, beforeCardId) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const oldColId = card.fields?.columnId || "";
  const audits = [];

  // Build the new column's ordering with the dragged card inserted in place.
  const colCards = [...state.cards.values()]
    .filter(c => !c.archived && c.id !== cardId && (c.type === "scene" || c.type === "beat") && c.fields?.columnId === newColId)
    .sort((a, b) => (a.fields?.columnOrder ?? 0) - (b.fields?.columnOrder ?? 0));
  const insertAt = beforeCardId ? colCards.findIndex(c => c.id === beforeCardId) : colCards.length;
  const at = insertAt < 0 ? colCards.length : insertAt;
  colCards.splice(at, 0, card);

  // Reassign columnOrder 0..N and persist any that changed.
  for (let i = 0; i < colCards.length; i++) {
    const c = colCards[i];
    const updates = {};
    if ((c.fields?.columnOrder ?? -1) !== i) {
      c.fields = c.fields || {};
      c.fields.columnOrder = i;
      updates["fields.columnOrder"] = i;
    }
    if (c.id === cardId && oldColId !== newColId) {
      c.fields.columnId = newColId;
      updates["fields.columnId"] = newColId;
    }
    if (Object.keys(updates).length === 0) continue;
    updates.updatedAt = serverTimestamp();
    await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", c.id), updates);
    if (c.id === cardId && oldColId !== newColId) {
      audits.push({ entityType: "card", entityId: c.id, field: "columnId", oldValue: oldColId, newValue: newColId });
    }
  }
  if (audits.length) await logAudit(state.user.uid, projectId, audits, state.project);
  await touchProject();
  updateRefreshNudge();
}

async function createCardInColumn(type, colId) {
  if (type !== "scene" && type !== "beat") return;
  const title = prompt(`New ${type} title:`);
  if (!title || !title.trim()) return;
  const trimmed = title.trim();
  // Determine columnOrder = max+1 in that column.
  const existing = [...state.cards.values()]
    .filter(c => !c.archived && (c.type === "scene" || c.type === "beat") && c.fields?.columnId === colId);
  const maxOrder = existing.reduce((m, c) => Math.max(m, c.fields?.columnOrder ?? -1), -1);
  const data = {
    type,
    title: trimmed,
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    order: 0,
    fields: {
      ...blankFieldsForType(type),
      columnId: colId,
      columnOrder: maxOrder + 1
    }
  };
  const ref = await addDoc(collection(db, "users", state.user.uid, "projects", projectId, "cards"), data);
  state.cards.set(ref.id, { id: ref.id, ...data });
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type, title: trimmed, columnId: colId }
  }], state.project);
  await touchProject();
  renderOutline();
  rebuildGraphElements();
  updateRefreshNudge();
  openCardEditor(ref.id);
}

// One-time migration: any scene/beat without a columnId gets assigned to the
// first main-story column of the current structure.
async function migrateUnassignedColumns() {
  const defaultId = defaultColumnId(state.project);
  let migrated = 0;
  for (const card of state.cards.values()) {
    if (card.archived) continue;
    if (card.type !== "scene" && card.type !== "beat") continue;
    if (card.fields?.columnId) continue;
    card.fields = card.fields || {};
    card.fields.columnId = defaultId;
    if (card.fields.columnOrder == null) card.fields.columnOrder = migrated;
    await updateDoc(
      doc(db, "users", state.user.uid, "projects", projectId, "cards", card.id),
      { "fields.columnId": card.fields.columnId, "fields.columnOrder": card.fields.columnOrder, updatedAt: serverTimestamp() }
    );
    migrated++;
  }
  if (migrated) console.log(`[outline] migrated ${migrated} cards into column "${defaultId}"`);
}

function renderPrologueSection() {
  removeFramingSection("prologueSection");
  const ss = state.project?.storySettings || {};
  const wrapper = makeFramingSection({
    id: "prologueSection",
    label: "Prologue / backstory",
    helpText: "Diegetic to the world but outside the main story arc. The LLM uses this as context.",
    value: ss.prologue || "",
    onSave: async (text) => saveFramingField("prologue", text)
  });
  els.outlineList.parentNode.insertBefore(wrapper, document.getElementById("beatSpine") || els.outlineList);
}

function renderEpilogueSection() {
  removeFramingSection("epilogueSection");
  const ss = state.project?.storySettings || {};
  const wrapper = makeFramingSection({
    id: "epilogueSection",
    label: "Epilogue / aftermath",
    helpText: "What happens after the main story. Treated as world context only — not part of the arc structure.",
    value: ss.epilogue || "",
    onSave: async (text) => saveFramingField("epilogue", text)
  });
  els.outlineView.appendChild(wrapper);
}

function makeFramingSection({ id, label, helpText, value, onSave }) {
  const details = document.createElement("details");
  details.id = id;
  details.className = "framing-section";
  if (value) details.open = true;
  details.innerHTML = `
    <summary>
      <span class="framing-label">${esc(label)}</span>
      ${value ? `<span class="muted small">${value.length} chars</span>` : `<span class="muted small">empty</span>`}
    </summary>
    <p class="muted small">${esc(helpText)}</p>
    <textarea class="framing-text" rows="6" placeholder="Type or paste…">${esc(value)}</textarea>
    <p class="muted small framing-save-status"></p>
  `;
  const ta = details.querySelector(".framing-text");
  const status = details.querySelector(".framing-save-status");
  let saveTimer = null;
  const triggerSave = () => {
    clearTimeout(saveTimer);
    status.textContent = "Saving…";
    saveTimer = setTimeout(async () => {
      try {
        await onSave(ta.value);
        status.textContent = "Saved.";
        setTimeout(() => { status.textContent = ""; }, 1500);
      } catch (err) {
        status.textContent = "Save failed: " + (err.message || err);
      }
    }, 600);
  };
  ta.addEventListener("input", triggerSave);
  ta.addEventListener("blur", triggerSave);
  return details;
}

function removeFramingSection(id) {
  document.getElementById(id)?.remove();
}

async function saveFramingField(field, value) {
  state.project.storySettings = state.project.storySettings || {};
  state.project.storySettings[field] = value;
  await updateDoc(
    doc(db, "users", state.user.uid, "projects", projectId),
    { [`storySettings.${field}`]: value, updatedAt: serverTimestamp() }
  );
  await logAudit(state.user.uid, projectId, [{
    entityType: "project", entityId: projectId, field: `storySettings.${field}`, oldValue: null, newValue: value
  }], state.project);
  updateRefreshNudge();
}

// Beat spine and beat-grouped outline groups have been replaced by the
// Trello-style column layout. The functions below are unused but kept as
// safe no-ops in case any legacy call site sneaks back in.
function renderBeatSpine() {}
function renderOutlineGroup_unused(beat, scenes) {
  const header = document.createElement("li");
  header.className = "outline-group-header";
  header.dataset.beatGroup = beat ? beat.id : "unassigned";
  if (beat) {
    const stale = beat.fields?.summaryStale ? '<span class="stale-icon" title="Beat summary needs refresh">⚠</span>' : "";
    header.innerHTML = `
      <div class="outline-group-title">
        <span class="badge beat">beat</span>
        <strong>${esc(beat.title)}</strong>
        ${beat.fields?.structurePosition ? `<span class="muted small">— ${esc(beat.fields.structurePosition)}</span>` : ""}
        ${stale}
      </div>
      ${beat.fields?.summary || beat.fields?.description ? `<p class="muted small">${esc(beat.fields.summary || beat.fields.description)}</p>` : ""}
    `;
    header.addEventListener("click", e => {
      if (e.target.closest(".drag-handle")) return;
      switchView("graph");
      openCardEditor(beat.id);
    });
  } else {
    header.innerHTML = `<div class="outline-group-title muted small">Unassigned to any beat</div>`;
  }
  els.outlineList.appendChild(header);

  // Drop zone for cross-beat assignment (covers the group)
  const dropZone = document.createElement("li");
  dropZone.className = "outline-group-dropzone";
  dropZone.dataset.beatTarget = beat ? beat.id : "";
  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    dropZone.classList.add("drop-target");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drop-target"));
  dropZone.addEventListener("drop", async e => {
    e.preventDefault();
    dropZone.classList.remove("drop-target");
    if (!dragSourceId) return;
    await setSceneBeat(dragSourceId, beat ? beat.id : "");
    renderOutline();
  });
  els.outlineList.appendChild(dropZone);

  if (scenes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "outline-group-empty muted small";
    empty.textContent = beat
      ? "No scenes assigned here yet — drag a scene's handle to drop it under this beat, or use the Beat dropdown in a scene editor."
      : "All scenes are assigned to a beat.";
    els.outlineList.appendChild(empty);
    return;
  }

  els.outlineList.appendChild(makePlusButton(null, scenes[0].id, beat ? beat.id : null));
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const li = document.createElement("li");
    li.className = "outline-item";
    li.draggable = true;
    li.dataset.cardId = s.id;
    const stale = s.fields?.ragSummaryStale ? '<span class="stale-icon" title="Summary needs refresh">⚠</span>' : "";
    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true">⋮⋮</span>
      <div class="outline-body">
        <h4>${esc(s.title)} ${stale}</h4>
        <p class="muted">${esc(s.fields?.shortDescription || s.fields?.ragSummary || "")}</p>
      </div>
    `;
    li.addEventListener("dragstart", outlineDragStart);
    li.addEventListener("dragover", outlineDragOver);
    li.addEventListener("drop", outlineDrop);
    li.addEventListener("dragend", outlineDragEnd);
    li.addEventListener("click", e => {
      if (e.target.closest(".drag-handle")) return;
      switchView("graph");
      openCardEditor(s.id);
    });
    els.outlineList.appendChild(li);
    const nextId = scenes[i + 1]?.id || null;
    els.outlineList.appendChild(makePlusButton(s.id, nextId, beat ? beat.id : null));
  }
}

// Set or clear a scene's parent beat. Removes from any previous beat first,
// then adds to the new one. Marks both beats' summaries stale because their
// contents changed.
async function setSceneBeat(sceneId, newBeatId) {
  const audits = [];
  const allBeats = [...state.cards.values()].filter(c => c.type === "beat" && !c.archived);
  for (const beat of allBeats) {
    const ids = beat.fields?.relatedSceneIds || [];
    if (ids.includes(sceneId) && beat.id !== newBeatId) {
      const newIds = ids.filter(id => id !== sceneId);
      beat.fields.relatedSceneIds = newIds;
      beat.fields.summaryStale = true;
      await updateDoc(
        doc(db, "users", state.user.uid, "projects", projectId, "cards", beat.id),
        {
          "fields.relatedSceneIds": newIds,
          "fields.summaryStale": true,
          updatedAt: serverTimestamp()
        }
      );
      audits.push({ entityType: "card", entityId: beat.id, field: "relatedSceneIds", oldValue: ids, newValue: newIds });
    }
  }
  if (newBeatId) {
    const newBeat = state.cards.get(newBeatId);
    if (newBeat && newBeat.type === "beat") {
      const ids = newBeat.fields?.relatedSceneIds || [];
      if (!ids.includes(sceneId)) {
        const newIds = [...ids, sceneId];
        newBeat.fields.relatedSceneIds = newIds;
        newBeat.fields.summaryStale = true;
        await updateDoc(
          doc(db, "users", state.user.uid, "projects", projectId, "cards", newBeatId),
          {
            "fields.relatedSceneIds": newIds,
            "fields.summaryStale": true,
            updatedAt: serverTimestamp()
          }
        );
        audits.push({ entityType: "card", entityId: newBeatId, field: "relatedSceneIds", oldValue: ids, newValue: newIds });
      }
    }
  }
  if (audits.length) await logAudit(state.user.uid, projectId, audits, state.project);
  await touchProject();
  updateRefreshNudge();
}

function makePlusButton(beforeSceneId, afterSceneId, beatId) {
  const wrap = document.createElement("li");
  wrap.className = "outline-plus";
  const btn = document.createElement("button");
  btn.className = "ghost small";
  btn.textContent = "+ Suggest scene here";
  btn.addEventListener("click", () => handleScenePlus(beforeSceneId, afterSceneId, beatId));
  wrap.appendChild(btn);
  return wrap;
}

async function handleScenePlus(beforeSceneId, afterSceneId, beatId) {
  console.log("[scene-plus] clicked", { beforeSceneId, afterSceneId, beatId });
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) openSettingsModal();
    return;
  }
  const { ok, result: gen } = await runLLMAction(
    "Generating scene proposal",
    () => generateScene(state, { beforeSceneId, afterSceneId })
  );
  if (!ok || !gen) return;
  openSceneProposalModal(gen, {
    onAccept: async (edited) => {
      const position = beforeSceneId ? { afterId: beforeSceneId } : (afterSceneId ? { beforeId: afterSceneId } : null);
      const newId = await insertGeneratedScene(state, projectId, edited, position);
      // Inherit the beat group the user dropped the + button under
      if (beatId) await setSceneBeat(newId, beatId);
      await touchProject();
      renderOutline();
      rebuildGraphElements();
      updateRefreshNudge();
      switchView("graph");
      openCardEditor(newId);
    }
  });
}

let dragSourceId = null;
function outlineDragStart(e) {
  dragSourceId = e.currentTarget.dataset.cardId;
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}
function outlineDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const target = e.currentTarget;
  if (target.dataset.cardId === dragSourceId) return;
  const rect = target.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  target.classList.toggle("drop-before", before);
  target.classList.toggle("drop-after", !before);
}
function outlineDragEnd() {
  document.querySelectorAll(".outline-item").forEach(li => {
    li.classList.remove("dragging", "drop-before", "drop-after");
  });
  dragSourceId = null;
}
async function outlineDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  const targetId = target.dataset.cardId;
  if (!dragSourceId || targetId === dragSourceId) { outlineDragEnd(); return; }
  const rect = target.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  await reorderScenes(dragSourceId, targetId, before);
  outlineDragEnd();
  renderOutline();
}
async function reorderScenes(movingId, targetId, before) {
  const ordered = [...state.cards.values()]
    .filter(c => c.type === "scene" && !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const moving = ordered.find(c => c.id === movingId);
  if (!moving) return;
  const without = ordered.filter(c => c.id !== movingId);
  const targetIdx = without.findIndex(c => c.id === targetId);
  if (targetIdx < 0) return;
  const insertAt = before ? targetIdx : targetIdx + 1;
  without.splice(insertAt, 0, moving);
  // Reassign sequential order
  const audit = [];
  for (let i = 0; i < without.length; i++) {
    const card = without[i];
    if (card.order !== i) {
      const old = card.order;
      card.order = i;
      await updateDoc(
        doc(db, "users", state.user.uid, "projects", projectId, "cards", card.id),
        { order: i, updatedAt: serverTimestamp() }
      );
      audit.push({ entityType: "card", entityId: card.id, field: "order", oldValue: old, newValue: i });
    }
  }
  if (audit.length) await logAudit(state.user.uid, projectId, audit, state.project);
  await touchProject();
  updateRefreshNudge();
}

// --- Archive ---

function renderArchive() {
  els.archiveList.innerHTML = "";
  const archived = [...state.cards.values()].filter(c => c.archived);
  if (archived.length === 0) {
    show(els.archiveEmpty);
    return;
  }
  hide(els.archiveEmpty);
  for (const c of archived) {
    const li = document.createElement("li");
    li.className = "archive-item";
    li.innerHTML = `
      <span class="badge ${c.type}">${c.type}</span>
      <span class="title">${esc(c.title)}</span>
      <button class="ghost small restore">Restore</button>
    `;
    li.querySelector(".restore").addEventListener("click", () => restoreCard(c.id));
    els.archiveList.appendChild(li);
  }
}

// --- Helpers ---

async function touchProject() {
  const ref = doc(db, "users", state.user.uid, "projects", projectId);
  await updateDoc(ref, { updatedAt: serverTimestamp() });
}

function flashStatus(msg) {
  let bar = document.getElementById("statusBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "statusBar";
    bar.className = "status-bar";
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
  show(bar);
}
function clearStatus() {
  const bar = document.getElementById("statusBar");
  if (bar) hide(bar);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function attr(s) { return esc(s); }
