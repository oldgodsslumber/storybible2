// Oracle tab — themed categories, collapsible cards, roll-from-collapsed.
// Data lives in oracle-data.js (auto-generated).

import { ORACLE } from "./oracle-data.js?v=20260603";

const HISTORY_LIMIT = 30;
let history = [];          // {tableName, result, ts}
const lastRollByTableKey = new Map(); // tableKey -> { result, detail }

function tableKey(t) { return `${t.sectionId}|${t.name}`; }

// ----- Category metadata -----
// Maps tables to thematic categories. Each table appears in exactly one
// category. Tables without an explicit mapping fall into "Other".

const COUNTRIES = [
  "United States", "Mexico", "United Kingdom", "Brazil", "India",
  "Nigeria", "Japan", "Germany", "France", "China",
  "Russia", "South Korea", "Italy", "Australia", "Argentina",
  "Philippines", "Egypt", "Pakistan", "Colombia", "Poland"
];

const CATEGORIES = [
  {
    id: "names",
    title: "Names by Nation",
    description: "First and last names for 20 nations. Pick a nation to see all four name tables together.",
    match: (t) => t.sectionId === "4" || t.sectionId === "4b",
    layout: "byNation"
  },
  {
    id: "jobs",
    title: "Jobs & Industry",
    description: "Master industry table plus the d20 sub-tables for each industry's specific jobs.",
    match: (t) => t.sectionId === "1" || t.sectionId === "1b"
  },
  {
    id: "businesses",
    title: "Businesses & Megacorps",
    description: "Small business and megacorp generators, plus dossier tables for fleshing them out.",
    match: (t) => ["8", "13", "13b"].includes(t.sectionId)
  },
  {
    id: "food-drink",
    title: "Food & Drink Establishments",
    description: "Fast food, value meals, dive bars, upscale bars, and pretentious drinks.",
    match: (t) => ["7", "7b", "10", "10b", "10c"].includes(t.sectionId)
  },
  {
    id: "religion-community",
    title: "Religion & Community",
    description: "Church and congregation name generators.",
    match: (t) => ["11"].includes(t.sectionId)
  },
  {
    id: "media",
    title: "Media Names",
    description: "Newspapers and news networks.",
    match: (t) => ["5", "6"].includes(t.sectionId)
  },
  {
    id: "education",
    title: "Education & Colleges",
    description: "College name generators, degree focus, and university dossier tables.",
    match: (t) => ["15b", "15c", "15d"].includes(t.sectionId)
  },
  {
    id: "civic",
    title: "Civic & Public",
    description: "Local officials and other public roles.",
    match: (t) => ["12"].includes(t.sectionId)
  },
  {
    id: "places",
    title: "Places & Locations",
    description: "Location types by region/density, plus street name generator.",
    match: (t) => ["2", "9"].includes(t.sectionId)
  },
  {
    id: "backstory",
    title: "Character Backstory",
    description: "Snapshot details: vehicle, possessions, education, living situation, income, childhood trauma.",
    match: (t) => ["16", "17", "18", "19", "20", "21"].includes(t.sectionId)
  },
  {
    id: "antagonist",
    title: "Antagonist & Crime",
    description: "Villain motivations, gang names, drug street names, criminal records.",
    match: (t) => ["3", "14", "15", "22"].includes(t.sectionId)
  },
  {
    id: "other",
    title: "Other",
    description: "Tables that don't fit anywhere else.",
    match: () => true // catch-all
  }
];

// ----- Render entry point -----

export function renderOracle(container) {
  const categoriesEl = container.querySelector("#oracleCategories");
  const searchEl = container.querySelector("#oracleSearch");
  const historyEl = container.querySelector("#oracleHistory");

  function render(filter) {
    const q = (filter || "").trim().toLowerCase();
    categoriesEl.innerHTML = "";

    // Bucket tables into categories (first match wins).
    const buckets = new Map(CATEGORIES.map(c => [c.id, []]));
    for (const t of ORACLE.tables) {
      for (const c of CATEGORIES) {
        if (c.match(t)) { buckets.get(c.id).push(t); break; }
      }
    }

    let anyVisible = false;
    for (const cat of CATEGORIES) {
      const tables = buckets.get(cat.id);
      if (!tables || tables.length === 0) continue;

      // Apply search filter (skip if no match within this category)
      const matched = q ? tables.filter(t =>
        t.name.toLowerCase().includes(q) ||
        cat.title.toLowerCase().includes(q) ||
        t.section.toLowerCase().includes(q)
      ) : tables;
      if (matched.length === 0) continue;
      anyVisible = true;

      const catEl = document.createElement("details");
      catEl.className = "oracle-category";
      // Open the category if there's an active search match; otherwise closed.
      if (q) catEl.open = true;
      catEl.innerHTML = `
        <summary class="oracle-cat-summary">
          <span class="oracle-cat-caret">▶</span>
          <span class="oracle-cat-title">${esc(cat.title)}</span>
          <span class="oracle-cat-count muted small">${matched.length} table${matched.length === 1 ? "" : "s"}</span>
        </summary>
        <div class="oracle-cat-body">
          ${cat.description ? `<p class="muted small oracle-cat-desc">${esc(cat.description)}</p>` : ""}
        </div>
      `;
      const body = catEl.querySelector(".oracle-cat-body");

      if (cat.layout === "byNation") {
        renderNationsLayout(body, matched, q);
      } else {
        renderTablesWithGroups(body, matched, q);
      }
      categoriesEl.appendChild(catEl);
    }

    if (!anyVisible) {
      categoriesEl.innerHTML = `<p class="muted">No tables match "${esc(q)}".</p>`;
    }
  }

  // Render tables in a category, grouping any that share a `combineGroup`
  // under a parent collapsible with a "Roll combined" button. Tables
  // without a combineGroup render standalone, same as before.
  function renderTablesWithGroups(body, tables, q) {
    const groups = new Map(); // combineGroup → [tables]
    const standalone = [];
    for (const t of tables) {
      if (t.combineGroup) {
        if (!groups.has(t.combineGroup)) groups.set(t.combineGroup, []);
        groups.get(t.combineGroup).push(t);
      } else {
        standalone.push(t);
      }
    }
    // Render combine groups first
    for (const [groupId, groupTables] of groups) {
      groupTables.sort((a, b) => (a.combineOrder || 0) - (b.combineOrder || 0));
      body.appendChild(renderCombineGroup(groupId, groupTables, q));
    }
    // Then standalone tables
    for (const t of standalone) body.appendChild(renderTableCard(t));
  }

  function renderCombineGroup(groupId, groupTables, q) {
    const groupName = groupTables[0]?.section || groupId;
    const groupKey = `combine:${groupId}`;
    const groupLast = lastRollByTableKey.get(groupKey);
    const wrap = document.createElement("details");
    wrap.className = "oracle-combine-group";
    if (q) wrap.open = true;
    wrap.innerHTML = `
      <summary class="oracle-combine-summary">
        <span class="oracle-combine-caret">▶</span>
        <div class="oracle-combine-info">
          <span class="oracle-combine-title">${esc(groupName)}</span>
          <span class="oracle-combine-meta muted small">${groupTables.length} sub-tables · combined roll available</span>
          <span class="oracle-combine-last muted small" data-combine-last>${groupLast ? `last: <strong>${esc(groupLast.result)}</strong>` : ""}</span>
        </div>
        <button class="oracle-combine-roll primary small" type="button">🎲 Roll combined</button>
      </summary>
      <div class="oracle-combine-body"></div>
    `;
    const cbody = wrap.querySelector(".oracle-combine-body");
    for (const t of groupTables) cbody.appendChild(renderTableCard(t, /*compactLabel*/ true, groupName + " — "));

    wrap.querySelector(".oracle-combine-roll").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rolls = [];
      const details = [];
      for (const t of groupTables) {
        const r = rollSilently(t);
        rolls.push({ label: t.name, value: r.value });
        details.push(r.detail);
      }

      // Dossier-style groups (Megacorp Dossier, College Dossier) have many
      // sub-tables with long item+notes entries. Concatenating them all
      // into a single line is unreadable. Detect dossier groups by either
      // an explicit "-dossier" suffix or by long average entry length, and
      // render as a multi-line profile with one label-prefixed line per
      // sub-table.
      const isDossier = /-dossier$/i.test(groupId)
        || (rolls.length >= 4 && rolls.every(r => (r.value || "").length > 24));

      let combined, htmlPreview;
      if (isDossier) {
        const linesPlain = rolls.map(r => `${r.label}: ${r.value}`);
        combined = linesPlain.join("\n");
        htmlPreview = rolls.map(r =>
          `<div class="oracle-dossier-line"><span class="oracle-dossier-label">${esc(r.label)}:</span> ${esc(r.value)}</div>`
        ).join("");
      } else {
        // Name-generator groups (Megacorp Name, News Network, Small Business,
        // Childhood Trauma, Villain Motivation) — concatenate with a good
        // separator based on token length.
        const values = rolls.map(r => r.value);
        const hasLong = values.some(v => (v || "").length > 24);
        combined = values.join(hasLong ? " · " : " ");
        htmlPreview = esc(combined);
      }

      lastRollByTableKey.set(groupKey, { result: combined, detail: details.join("  +  ") });
      const lastEl = wrap.querySelector("[data-combine-last]");
      if (lastEl) {
        lastEl.innerHTML = isDossier
          ? `<div class="oracle-dossier-result"><div class="muted small">last roll:</div>${htmlPreview}</div>`
          : `last: <strong>${htmlPreview}</strong>`;
      }
      recordRoll(groupName, groupName, combined, details.join("  +  "));
      // Floating toast: show first line for dossiers (otherwise it'd be huge)
      const toastText = isDossier
        ? `${groupName} — ${rolls.length} fields rolled (see card or news feed)`
        : `${groupName}: ${combined}`;
      showFloatingResult(toastText);
    });
    return wrap;
  }

  function renderNationsLayout(body, nameTables, q) {
    // Group by nation. Each country gets a nested collapsible with its four
    // name tables grouped together (combined first, female, male, last).
    const byNation = new Map();
    for (const t of nameTables) {
      const country = COUNTRIES.find(c => t.name.startsWith(c + " "));
      if (!country) continue;
      if (!byNation.has(country)) byNation.set(country, []);
      byNation.get(country).push(t);
    }
    // Render countries in the canonical roll order
    for (const country of COUNTRIES) {
      const tables = byNation.get(country);
      if (!tables || tables.length === 0) continue;
      // Sort: First Names → Female First Names → Male First Names → Last Names
      const order = ["First Names", "Female First Names", "Male First Names", "Last Names"];
      tables.sort((a, b) => {
        const an = a.name.replace(country + " — ", "");
        const bn = b.name.replace(country + " — ", "");
        return order.indexOf(an) - order.indexOf(bn);
      });
      const nationEl = document.createElement("details");
      nationEl.className = "oracle-nation";
      if (q) nationEl.open = true;
      // Find the combined first names and last names tables for the "Full name" quick roll
      const combinedFirst = tables.find(t => t.name.endsWith("— First Names"));
      const lastNames = tables.find(t => t.name.endsWith("— Last Names"));
      const hasFullName = combinedFirst && lastNames;
      const nationKey = `nation:${country}`;
      const nationLast = lastRollByTableKey.get(nationKey);
      nationEl.innerHTML = `
        <summary class="oracle-nation-summary">
          <span class="oracle-nation-caret">▶</span>
          <div class="oracle-nation-info">
            <span class="oracle-nation-title">${esc(country)}</span>
            <span class="oracle-nation-last muted small" data-nation-last>${nationLast ? `last full name: <strong>${esc(nationLast.result)}</strong>` : ""}</span>
          </div>
          ${hasFullName ? `<button class="oracle-nation-fullname primary small" type="button">🎲 Full name</button>` : ""}
        </summary>
        <div class="oracle-nation-body"></div>
      `;
      const nbody = nationEl.querySelector(".oracle-nation-body");
      for (const t of tables) nbody.appendChild(renderTableCard(t, /*compactLabel*/ true, country));

      if (hasFullName) {
        nationEl.querySelector(".oracle-nation-fullname").addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const first = rollSilently(combinedFirst);
          const last  = rollSilently(lastNames);
          // Strip "(F)/(M)" tag from first name
          const firstClean = (first.value || "").replace(/\s*\([FM]\)\s*$/, "");
          const full = `${firstClean} ${last.value}`;
          // Persist the result on the nation so it stays visible inline,
          // matching the per-table-card "last: X" pattern.
          lastRollByTableKey.set(nationKey, { result: full, detail: `${first.detail}  +  ${last.detail}` });
          const lastEl = nationEl.querySelector("[data-nation-last]");
          if (lastEl) lastEl.innerHTML = `last full name: <strong>${esc(full)}</strong>`;
          recordRoll(`${country} — Full Name`, country, full, `${first.detail}  +  ${last.detail}`);
          showFloatingResult(`${country}: ${full}`);
        });
      }
      body.appendChild(nationEl);
    }
  }

  function renderTableCard(t, compactLabel = false, stripPrefix = "") {
    const card = document.createElement("details");
    card.className = "oracle-table-card";
    const tk = tableKey(t);
    const last = lastRollByTableKey.get(tk);
    const displayName = compactLabel && stripPrefix
      ? t.name.replace(`${stripPrefix} — `, "")
      : t.name;
    card.innerHTML = `
      <summary class="oracle-card-summary">
        <span class="oracle-card-caret">▶</span>
        <div class="oracle-card-info">
          <span class="oracle-card-name">${esc(displayName)}</span>
          <span class="oracle-card-dice muted small">${esc(t.dice)} · ${t.entries.length} entries</span>
          ${last ? `<span class="oracle-card-last muted small">last: <strong>${esc(last.result)}</strong></span>` : ""}
        </div>
        <button class="oracle-card-roll primary small" type="button" title="Roll">🎲</button>
      </summary>
      <div class="oracle-card-body">
        <ol class="oracle-entry-list">
          ${t.entries.map(row => `<li>${esc(renderEntryText(row))}</li>`).join("")}
        </ol>
      </div>
    `;
    card.querySelector(".oracle-card-roll").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = rollSilently(t);
      lastRollByTableKey.set(tk, r);
      // Update the "last" line in this card's summary without rerendering everything
      const info = card.querySelector(".oracle-card-info");
      let lastEl = info.querySelector(".oracle-card-last");
      if (!lastEl) {
        lastEl = document.createElement("span");
        lastEl.className = "oracle-card-last muted small";
        info.appendChild(lastEl);
      }
      lastEl.innerHTML = `last: <strong>${esc(r.result)}</strong>`;
      recordRoll(t.name, t.section, r.result, r.detail);
      showFloatingResult(`${displayName}: ${r.result}`);
    });
    return card;
  }

  // Roll on a table; returns { result, detail } without touching the UI/history.
  function rollSilently(t) {
    const sides = parseInt((t.dice.match(/d(\d+)/) || ["", "20"])[1], 10);
    const cols = t.columns || 1;
    const rolledValues = [];
    const rolledIndices = [];
    for (let c = 0; c < cols; c++) {
      const r = 1 + Math.floor(Math.random() * Math.min(sides, t.entries.length));
      rolledIndices.push(r);
      const row = t.entries[r - 1];
      if (row && row[c] !== undefined) rolledValues.push(row[c]);
      else if (row) rolledValues.push(row[0] ?? "");
    }
    const combined = cols > 1 ? rolledValues.join(" ") : rolledValues[0];
    const detail = cols > 1
      ? rolledIndices.map((r, c) => `${r}: ${rolledValues[c]}`).join("  +  ")
      : `${rolledIndices[0]}: ${rolledValues[0]}`;
    return { value: combined, result: combined, detail };
  }

  function recordRoll(tableName, section, result, detail) {
    history.unshift({ tableName, section, result, detail, ts: Date.now() });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    renderHistory();
  }

  function renderHistory() {
    historyEl.innerHTML = `<h4>Recent rolls ${history.length > 0 ? `<button class="ghost small clear-rolls" type="button">Clear</button>` : ""}</h4>`;
    if (history.length === 0) {
      const empty = document.createElement("p");
      empty.className = "oracle-history-empty";
      empty.textContent = "Roll on any table — results stream here, newest first.";
      historyEl.appendChild(empty);
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "oracle-history-list";
    for (const h of history) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="oracle-history-main">${esc(h.result)}</div>
        <div class="oracle-history-meta">
          ${esc(h.tableName)} · ${esc(h.detail)} · <span class="oracle-history-time" data-ts="${h.ts}">${esc(relativeTime(h.ts))}</span>
        </div>
      `;
      ul.appendChild(li);
    }
    historyEl.appendChild(ul);
    historyEl.querySelector(".clear-rolls")?.addEventListener("click", () => {
      history = [];
      renderHistory();
    });
  }

  // Update timestamps every 30 seconds so the news feed feels live
  // ("just now" → "1m ago" → "5m ago", etc.) without re-rendering the whole list.
  setInterval(() => {
    historyEl.querySelectorAll(".oracle-history-time").forEach(el => {
      const ts = parseInt(el.dataset.ts, 10);
      if (!Number.isNaN(ts)) el.textContent = relativeTime(ts);
    });
  }, 30000);

  // Floating toast at the top of the panel so the user sees the roll
  // result without having to scroll to the history.
  let toastTimer = null;
  function showFloatingResult(text) {
    let toast = container.querySelector(".oracle-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "oracle-toast";
      container.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  searchEl.addEventListener("input", () => render(searchEl.value));
  render("");
  renderHistory();
}

function renderEntryText(row) {
  if (!Array.isArray(row)) return String(row || "");
  return row.filter(Boolean).join(" — ");
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 30000) return "just now";
  if (diff < 60000) return "less than a minute ago";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
