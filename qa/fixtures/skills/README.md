# Main-scenario skill acceptance fixtures

This directory holds three decks, each verifying one of the three main-scenario skills in `.agents/skills/slidra-{plan,reshape,validate}/SKILL.md`. Each deck directory is an unpacked presentation (`project.json` + `slides/00N.svg`, with `outline-deck` additionally containing `INPUT.md`), each paired with an `EXPECTED.md` describing what the deck should look like after running that skill.

## How to pack and open a deck

```bash
npm run build
mkdir -p .scratch && export SLIDRA_HOME="$PWD/.scratch/home"
node scripts/pack-directory.mjs qa/fixtures/skills/check-deck .scratch/check.slidra
./target/release/slidra open ./.scratch/check.slidra     # note the returned id
./target/release/slidra ls <id> slides
./target/release/slidra comment list <id>
./target/release/slidra cat <id> slides/001.svg
```

Swap `check-deck` for `outline-deck` or `reshape-deck` to pack and open the other two.

## Which skill each fixture verifies

| Directory | Skill verified | Description |
|---|---|---|
| `outline-deck/` | `/slidra-plan` then `/slidra-build` | `INPUT.md` is a 5-section outline; `EXPECTED.md` describes the 5 slides that should result |
| `reshape-deck/` | `/slidra-reshape` | 3 pages, 5 pre-seeded comments (3 actionable, 2 not), `EXPECTED.md` lists the expected outcome per comment |
| `check-deck/` | `/slidra-validate` | 5 pages, no plan file, 6 classes of structural issues planted (one each), `EXPECTED.md` lists the (page, target) pairs the read-through step should pin |

## Where acceptance records go

After a real agent (Claude Code, Codex) actually runs a given (agent, skill) combination, save the conversation transcript and the resulting deck to `qa/fixtures/skills/records/<claude|codex>-<skill>/` (e.g. `qa/fixtures/skills/records/claude-outline/`). **Do not create this directory without having actually run it** — an empty or hand-written record file is fake evidence.
