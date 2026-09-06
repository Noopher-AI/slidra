import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateProjectJson } from "./project-json.js";
import { setSlideTransition, slideHasTransitionMetadata } from "./slide/transition.js";

/**
 * The legacy presentation-wide `"fade"` transition's actual runtime
 * behaviour (canvas.ts's now-removed T6 code, `PAGE_FADE_MS`): a forward
 * page change faded the new page in over 400ms, and nothing else ever
 * animated. §4.3's migration preserves that exact behaviour as an
 * equivalent per-page `enter`, rather than inventing a new default.
 */
const LEGACY_FADE_ENTER_DURATION = 0.4;

/**
 * `formatVersion` 2 → 3 ([E2.T11]): moves a `.comot`'s presentation-wide
 * `project.json.transition` onto each slide's own `<comot:transition>`,
 * then removes the field for good. Runs once, from `container.ts`'s
 * `unpackContainer`, on every `open`/`reopen` — never lazily from a later
 * write (see `presentation.ts`'s `FORMAT_VERSION` doc comment for why).
 *
 * `workDir` is the hidden work directory `unpackContainer` just unzipped
 * into: no `writePresentationFile`/history-group machinery is available
 * yet (this runs before the presentation is registered), so every write
 * here goes straight through `node:fs` — same posture `container.ts`
 * itself already takes for this same directory.
 */
export async function migrateLegacyTransition(workDir: string): Promise<void> {
  const projectPath = path.join(workDir, "project.json");
  const raw = await readFile(projectPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const project = validateProjectJson(parsed);

  if (project.formatVersion >= 3) return;

  // §4.3 决定: only the literal "fade" carries any slide-level meaning
  // forward. Every other value — undefined, "none", "", or an unknown
  // future string — already read as "none" on the old read side
  // (canvas.ts's removed comment said as much), so migrating them would
  // hand every such presentation an exit animation nobody ever asked for.
  if (project.transition === "fade") {
    for (const slidePath of project.slides) {
      const slideFsPath = path.join(workDir, slidePath);
      const svgContent = await readFile(slideFsPath, "utf-8");
      if (slideHasTransitionMetadata(svgContent)) continue;
      const updated = setSlideTransition(svgContent, {
        enter: { effect: "fade", duration: LEGACY_FADE_ENTER_DURATION },
        exit: { effect: "none", duration: 0.5 },
      });
      await writeFile(slideFsPath, updated, "utf-8");
    }
  }

  // Every other field's bytes are left exactly as parsed — only
  // `formatVersion` changes value (in place) and `transition` disappears.
  const next: Record<string, unknown> = { ...parsed, formatVersion: 3 };
  delete next.transition;
  await writeFile(projectPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}
