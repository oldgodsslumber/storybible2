# Narrative types: novel, film, TV series, video game

Status: Phase 1 built 2026-11-18 (logic tested in Node; not yet clicked
through in a browser). Phases 2–3 not started.

## Decisions (from the writer, 2026-11-18)

- **TV:** one project holds the whole series, with seasons inside it.
- **Games:** support all three shapes — linear, branch-and-bottleneck (choices
  diverge and converge back on shared decision points), and fully branching
  multi-path stories. Games also get a **feature** card type for detailing
  mechanics and systems.
- **Existing projects:** ask once per project which medium it is, and update it.
- **Order:** foundation + novel/film, then TV, then games.
- **Drafting** (writing the actual prose or script) stays out of scope. The app plans.

## Core design

- `storySettings.medium` = `novel` | `film` | `tv` | `game`. Unset = today's
  behaviour, and the project is asked once to pick.
- `js/medium.js` holds one **profile** per medium as data: label, structures it
  offers, default structure, framing-column labels, length unit and default
  target, extra scene fields, AI guidance paragraph, synopsis style. Code reads
  the profile rather than branching on the medium.
- **"Scene" stays the atomic unit in every medium.** Media add containers above
  it (chapters, episodes, quests) instead of renaming it.
- Every AI prompt already goes through `buildProjectContext`, so the medium's
  guidance reaches all of them from one place. Prompts that need a different
  output (synopsis) get a per-medium note from the profile.

## Phase 1 — foundation, novel, film

- Medium profiles; picker on the new-project form; medium badge on the dashboard.
- Story settings: medium, target length (words for a novel, pages for a film),
  structures listed per medium.
- One-time "What kind of project is this?" ask on opening an unmarked project.
- AI context: medium line + guidance + target length.
- Novel: optional **chapter** on each scene; Outline shows chapter dividers and
  warns when the POV changes inside a chapter. New structure: 7-Point.
- Film: **INT/EXT + time of day** on each scene (sets up a later script
  export). Framing columns are "Prologue / Cold Open" and "Epilogue /
  Post-credits". New structure: 8-Sequence.
- Both: **estimated length** per scene; pacing by length when estimates exist;
  the checklist shows where each beat should land (page or word count).
- Synopsis: novel → one-page submission synopsis; film → logline + treatment.
- The default structure's column guidance no longer says "film" regardless of medium.

## Phase 2 — TV series

- New card type **episode**: season, number, title, logline, per-plotline
  summary, status.
- Scenes get `episodeId` + `plotline` (A / B / C / runner). Arcs get a scope
  (series / season / episode).
- Two-level Outline: **Season board** (columns = episodes, season-arc beats in
  them) and **Episode board** (columns from the episode format: teaser, acts,
  tag; scenes coloured by plotline) with an episode picker.
- Episode formats: network hour (teaser + 5 acts), streaming hour (3–4 acts),
  half-hour comedy (cold open, 2 acts, tag), limited series.
- AI: break an episode (logline + season arc → A/B/C beats per act); season-arc
  check; act-out check; plot balance per episode; series pitch as the synopsis.
- Kanban per episode: Broken → Outlined → Scripted → Revised → Locked.
- Episode-scoped prompts send that episode + a season summary, not the series.
- Switching an existing project to TV puts everything into S1E1.

## Phase 3 — video games

- New card type **quest** (main / side / companion; objective, region,
  prerequisites, rewards). Scenes belong to a quest.
- New card type **feature** (mechanic, system, ability, item, UI, mode):
  description, how it's taught (tutorial scene), narrative justification,
  themes it expresses, quests that use it.
- Project setting **story shape**: linear / branch-and-bottleneck / branching.
  It sets the guidance and which checks run; the data model is the same.
- Scene fields: delivery (cutscene / in-gameplay / dialogue / environmental /
  collectible), player objective, gameplay activity, **choices**
  `[{ option, consequence, setsFlag, leadsToSceneId }]`, and a
  **bottleneck** flag marking where branches converge.
- Characters: playable / companion / NPC / enemy, faction.
- Outline: columns = critical-path chapters; an Optional lane for side content;
  framing columns Tutorial / Post-game. Canvas gains directed leads-to / choice
  links as a branch map.
- Checks: choice audit (choices with no payoff, flags set but never read,
  branches that never reach the next bottleneck, unreachable scenes/endings);
  feature check (used before it's taught, no narrative justification);
  cutscene-vs-play pacing; critical lore only in optional content.
- Dialogue-tree writing stays out of scope (Twine / Yarn / articy territory).
- Switching an existing project to game puts everything into one main quest.
