# The Writer's Assistant — Story Bible v2

A living creative tool for writers who think deeply about their stories. HTML + Firebase + GitHub Pages, no build step.

This repo implements **M1 + M2 + M3 + M4 + M5** of the spec (`Story_Bible_App_Spec_v4.1_Audited.docx`) — the full milestone roadmap.

## Views

- `index.html` — Dashboard (project list + new project / idea dump)
- `project.html` — Open project with four tabs:
  - **Graph** — Cytoscape.js node-graph workspace, card editor, connections
  - **Outline** — Linear list of scene cards (drag-to-reorder lands in M3)
  - **Review** — Stub (M4)
  - **Archive** — Restore soft-deleted cards

## M1 scope (what works now)

- Google sign-in, per-user Firestore data
- Dashboard with project list + create-new flow
- Idea Dump capture (text only, no LLM yet — M2 adds extraction)
- Graph workspace with five card types: character, scene, theme, location, arc
- Manual card creation, editing (saves on blur), and connection drawing (Connect to… button)
- Soft-delete + Archive tab with restore
- Cytoscape.js layout (cose), color-coded nodes by type
- Multi-project (one open at a time)

## M2 scope (added)

- ⚙ Settings modal (top-right) — provider, API key/endpoint, model, temperature; stored in localStorage only
- Two providers: **Gemini API** and **Oobabooga local** (uses ooba's OpenAI-compatible `/v1/chat/completions` — start ooba with `--api`)
- **Idea-dump extraction**: after creating a new project, the LLM reads your dump and proposes characters, locations, themes, and connections
- **Extraction vs. inference labeling**: items the writer directly said are pre-checked; inferred items require explicit approval
- **Side panel parsing**: dump freeform thoughts → LLM proposes new cards, updates to existing cards, and new connections
- **Gap-analysis wizard**: after idea-dump extraction, sequential one-question-at-a-time pass with chip options for theme questions; answers flow back as bullets on the relevant cards

## M3 scope (added)

- **Audit trail** — every card/connection write appends an entry to `project.auditTrail` with timestamp, entity, field, old/new values. The "↻ Refresh" button badge shows the count since last refresh.
- **Stale tracking** — editing a character's role/traits/history marks `storyRoleSummaryStale`; editing a scene's long description marks `ragSummaryStale`. Graph nodes get a dashed amber border and a ⚠ prefix when stale; outline items and card editor show inline ⚠ stale tags.
- **Global Refresh** — top-right ↻ button. Regenerates character `storyRoleSummary`, scene `ragSummary`, and arc `summary` for everything currently stale (or missing). Audit-trail entries for each card are passed in as "recent changes" context; calls with >12 changes are batched.
- **Progress modal** — full-screen overlay with progress bar, locks editing during the run.
- **Conflict resolution** — if you manually edited a summary in the card editor and Refresh wants to overwrite it, a "Keep existing / Keep both / Use new" prompt fires.
- **Refresh-before-review nudge** — clicking the Review tab with 60+ changes since the last refresh triggers a prompt. Dismissed per session.
- **Outline drag-to-reorder** — drag-handle on outline items; drop above/below reorders the `order` field and logs to audit trail.

## M4 scope (added)

- **Review Panel** with four modes (top of the Review tab):
  - **Character Arc** — pick a character, get 2–4 paragraphs covering trajectory, turning points, and resolution
  - **Synopsis** — story-level 3–5 paragraph synopsis
  - **Arc Summaries** — list of arc cards with editable summaries; saving an arc runs a tension analysis that flags scenes now in conflict with the new summary
  - **Theme Coherence** — analyzes scenes + characters against theme pillars; surfaces what supports each theme vs. what feels disconnected
- **Scene generation via + buttons** in the Outline view — between every two scenes, plus one before the first and after the last. LLM proposes a bridging scene with title, short/long description, rationale, and suggested characters/locations. The proposal is editable before insertion.
- **Theme-driven trait suggestions** — "Suggest traits…" button in the character card editor. LLM proposes 3–5 traits/contradictions/relationships that explore the project's themes through that character, avoiding archetypes from other characters. Pick which to add via a checkbox modal.
- **Arc-edit → tension loop** — editing an arc summary in the Review Panel saves the summary and immediately analyzes which tagged scenes are now in tension, with concrete revision suggestions.
- **Arc-tagging on scenes** — the scene card editor now exposes Characters / Locations / Arcs tag pickers. Changing arc tags marks the corresponding arcs' summaries stale.

## M5 scope (added)

- **Kanban tab** alongside Graph / Outline / Review / Archive
- Five default stages: **Idea → Outlined → Drafted → Revised → Done**
- Scene cards appear in their current stage; drag a card between columns to change `kanbanStage` (writes through to Firestore and the audit trail)
- Clicking a card on the board jumps to its full editor in the Graph view
- Separate from the story bible workspace — no narrative-graph cards (characters, themes, etc.) appear here

## Stretch goals not implemented

The spec lists these as stretch goals (section 15) — not built:

- Creative timeline view of the audit trail
- Offline-capable mode
- Export to PDF / DOCX / Final Draft

## File layout

```
storybible2/
├── index.html
├── project.html
├── firebase-config.js   ← fill in with your Firebase web config
├── firestore.rules
├── js/
│   ├── shared.js
│   ├── dashboard.js
│   ├── project.js
│   ├── llm.js          ← provider abstraction (Gemini, Ooba)
│   ├── settings.js     ← settings modal
│   ├── extraction.js   ← extraction prompts, approval, wizard
│   ├── audit.js        ← audit-trail logger + stale-impact rules
│   ├── refresh.js      ← Global Refresh orchestrator + progress + conflict
│   └── review.js       ← Review Panel modes, scene-gen, trait-suggest, tension
├── css/
│   ├── shared.css
│   ├── dashboard.css
│   └── project.css
├── README.md
└── DEPLOY.md
```

## Running locally

The Firebase auth popup requires a real origin — `file://` won't work. From the project folder:

```
python -m http.server 8000
```

then open http://localhost:8000. Add `http://localhost` to Firebase Auth's Authorized Domains (it's usually there by default).

See `DEPLOY.md` for GitHub Pages deployment.
