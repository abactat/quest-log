# quest-log

A live, game-style quest log for Claude Code `/goal` runs and plans, shown in a side pane: steps, goals sized and paid in XP, a d20 that rolls at each goal check, a 5e Ranger level track, usage-limit hearts, parked questions and an animated ranger hero. It only watches: it never calls the model or adds context, so it costs no tokens. Everything resets each chat.

## Install

```
claude plugin marketplace add abactat/quest-log
claude plugin install quest-log@quest-mods --scope user
```

Or, inside Claude Code: `/plugin marketplace add abactat/quest-log`, then `/plugin install quest-log@quest-mods`.

Then `/reload-plugins` in any chat that is already open. At user scope it loads in every repo and app on the machine.

Closed the pane? Type `/quest` to open it again (no tokens).

## The hero

A green-cloaked ranger, cut from the sheet in `assets/ranger-pack/source/` by `tools/cut-ranger.py`. He walks while Claude works, strikes with his sword when a step is cleared, thrusts when a milestone lands, plays the slash combo on a level up, lowers his sword on guard while a decision waits on you, breathes at ease when resting or after a win, and turns away to rest at 0 session hearts. Terminals get the same frames as colour pixel art.

## Two views

📜 **Quest**: the goal, its progress, runs, decisions, the goal check, road ahead, steps, earlier quests. 🐉 **Adventure**: the hero's 5e character sheet, the encounter (the guardian's SRD 5.1 stat block, matched by challenge rating to the goal's size), the d20, the spoils, and class choices. Creature stats: 5e SRD 5.1, Wizards of the Coast, CC BY 4.0.

## ⚖️ Goal sizes, XP and the d20

Every goal is sized from what it asks (mostly how many parts its "complete when …" names; its stages and the length of its brief add a little) and grows if the work shows it is bigger (12+ milestones or 6+ hours). Plans are sized by their steps.

| Size | Worth | On its own, about |
|---|---|---|
| Trivial | 1,300 XP | Lv 5 |
| Small | 4,600 XP | Lv 7 |
| Medium | 12,800 XP | Lv 10 |
| Large | 24,000 XP | Lv 13 |
| Epic | 33,000 XP | Lv 15 |

XP comes from goals, not busywork: 60% as the finish-line parts are met (each part shows its XP in Road ahead, paid when the goal check counts it met), 2% per milestone (up to 12), and the rest when the goal passes; the guardian adds a tenth (a quarter more if it is a Favored Enemy). A plan pays per planned step. Measured on real long-running research chats: a passed sub-stage goal ends the chat at Lv 13–15, a long unmet one around Lv 8, and a chat with several big goals reaches 20.

The d20 rolls while Claude works and lands at each goal check: higher the more is met, never a 20 until the goal passes — then it lands on the natural 20. A stalled goal loop is a natural 1. The Trophies tab is gone: the level, the class and the goals now carry that.

## ⏱️ Runs

When Claude starts something long — a command still going after a few seconds, a command sent to the background, a helper agent — a "Running now" card shows it, how long it has run, and how much is likely left. The estimate comes from, in order: the run's own progress in its output (pytest's `[ 45%]`, a progress bar, "epoch 3/10"; the log reads the output file every few seconds, for free), how long the same run took earlier in this chat ("usually 6m, from 2 earlier runs"), and what Claude said when it started it ("it takes about 6 minutes"). Helpers with nothing else to go on are timed against the other helpers in the chat. A run past its usual time says so. When Claude is resting until a run ends, the heartbeat says that instead of "idle", and the status line counts the runs going.

## Bad guys

Every new goal or plan gets a guardian that walks in from the right, roars, and waits by the flag: a Dragon Whelp or Lizardfolk for a plan or short goal, a Medusa or Jinn for a goal, a Demon or Dragon for a big goal (a finish line of three or more, or a long brief). Through a long run the hero just walks and it idles; its health bar is the work still left. A milestone wounds it, a "not met" goal check makes it strike back, and winning the quest fells it for a bounty (40/80/120 XP by size, +25% if it is one of your Favored Enemies in the Class tab: dragons, humanoids, monstrosities, elementals, fiends). The terminal shows its emoji at the end of the track, and a skull once it falls.

The monsters are CraftPix's free Pixel Art RPG Monster Sprites (`assets/foes-pack/source/`, cut by `tools/cut-foes.py`), shared under OGA-BY 3.0: see Credits.

## 🎓 Class tab

Your hero is a 5e Ranger (dnd5e.wikidot.com/ranger, official rules). Nothing is chosen for you: as you level, the choices wait in the Class tab (its button shows ❗ and a count) — Favored Enemy and Natural Explorer at 1, Fighting Style at 2, your conclave at 3 (Hunter, Beast Master, Gloom Stalker, Horizon Walker, Monster Slayer, Fey Wanderer, Swarmkeeper, Drakewarden), Ability Score Improvements at 4/8/12/16/19, more enemies and lands at 6/10/14, and your conclave's own choices (Hunter's Prey, companion, swarm, drake essence…). Any choice can be changed; changing the conclave takes back its own choices. A track shows levels 1–20 and where the choices are. Choices are per chat and cost no tokens.

## Long /goal runs

- Goals that arrive mid-quest: a /goal (or one Claude proposes) set while a plan or task list runs takes that quest over and keeps its steps; the same goal reworded updates the quest in place (finish-line items already met stay met); a different goal starts a new quest and the old one is set aside. A bigger goal brings a bigger guardian.

- 🗺️ Road ahead, from the moment the goal starts: the goal's finish line (its "complete when …" terms, ticked as the goal check counts them met), the stages it names in order ("C1 -> C2 -> C3"), and what Claude last said comes next ("Next: A, then B").
- With no plan, each git commit closes a 🏁 milestone named by its commit message; the commands since the last commit fold under it.
- Progress is the goal check's own list ("4 parts still to do"), not a count of steps.
- 🔁 Standoff: Claude stopped working and the goal check keeps sending it back. ⛔ Goal loop stopped: Claude Code ended it. Either way: reply to carry on, or `/goal clear`.
- ⚠️ If Claude Code's goal check hasn't run at two or more stops, the pane says so: the goal isn't sending Claude back, so only a finishing background job or your reply starts it again.
- A numbered reply ("1. … 2. fix it everywhere") answers Claude's numbered decisions by number; an answer that asks back leaves its decision open.
- A question back to Claude settles no parked decision; a reply that names one (e.g. "D-9: …") or a plain yes/no does.
- A compaction is not a verdict: Claude Code re-posts the goal's marker after one, and the log no longer reads that as the goal passing. If the goal check does send Claude back after a win, the win is undone: the finish-line ticks, the natural 20, the XP and the guardian's fall.

## Files

- `hooks/register.tsx` – hooks and the pane
- `hooks/game.ts` – pure game logic
- `hooks/describe.ts` – plain-English action lines
- `hooks/ranger.ts` – the 5e Ranger: level table, choices and the eight official conclaves
- `hooks/sprite.ts` – the hero poses and the d20 (drawn in code); `hooks/runner-frames.ts` (PNG frames) and `hooks/runner-pixels.ts` (colour pixel art for terminals) are generated
- `assets/ranger-pack/` – the ranger sheet and its cut frames (`preview.png` shows them all); `tools/cut-ranger.py` cuts the sheet, `tools/make-frames.py` rebuilds the two generated files
- `hooks/runs.ts` – runs: tracking, progress from output, estimates
- `hooks/foes.ts` – the guardians: who, how big, when they act; `hooks/foe-frames.ts` is generated
- `assets/foes-pack/` – the monster previews and their cut frames (`preview.png`); `tools/cut-foes.py` cuts them
- `quest.test.tsx` – tests (`claude plugin test .`)
- `tools/replay.py` – plays a real chat transcript through the mod and prints the pane at each stop: `python3 -I tools/replay.py <chat.jsonl> --every-stop [--view quest|adventure] [--grep REGEX]`

## Credits

- **Monsters** (Lizardfolk, Dragon Whelp, Medusa, Jinn, Demon, Dragon): [Pixel Art RPG Monster Sprites](https://opengameart.org/content/pixel-art-rpg-monster-sprites) by [CraftPix.net](https://craftpix.net), licensed [OGA-BY 3.0](https://static.opengameart.org/OGA-BY-3.0.txt). The frames in `assets/foes-pack/frames/` and `hooks/foe-frames.ts` are cut, trimmed and mirrored from their animated previews.
- **Ranger hero**: sprite sheet supplied by the repo owner, Alex Bactat (`assets/ranger-pack/source/ranger-sheet.webp`), cut by `tools/cut-ranger.py`.
- **d20**: original, drawn in code in `hooks/sprite.ts`.
- **Monster statistics**: the System Reference Document 5.1 by Wizards of the Coast LLC, available at https://dnd.wizards.com/resources/systems-reference-document, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
- **Ranger levels and choices**: summarised in this mod's own words from the D&D 5e Ranger class; Dungeons & Dragons is a trademark of Wizards of the Coast. This mod is unofficial and not affiliated with or endorsed by Wizards of the Coast.

## License

The code is MIT (see `LICENSE`). The art keeps its own licence, listed under Credits.

