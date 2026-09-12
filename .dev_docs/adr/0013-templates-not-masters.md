# Templates and locking replace masters; a template is dead once used

PowerPoint and Keynote use a two-level hierarchy to keep a whole deck looking consistent: a layout decides where placeholders sit, and a master decides background and color scheme — change the master and every slide changes with it. That model requires that a slide **not own** its own background — it references the master, and the two are composited at display time. This directly conflicts with ADR-0001 (SVG is the artifact), ADR-0003, and ADR-0008 (a slide is self-contained): opening a single slide on its own would be missing its background and colors.

This project uses a single layer instead, called a **template**.

A template is just an SVG, living inside the `.slidra`; a presentation can have several (one for a cover, one for content pages, one for section dividers). Creating a new slide picks one and **copies it wholesale** to become the new slide — from that moment on, the slide owns everything itself and has no further relationship to the template. **A template is dead.**

Every element in a template carries a **lock** marker that travels with it into the copy and stays in effect. Backgrounds, color bars, logos, footers, and page numbers are locked; titles and body text are not. The point of locking **isn't synchronization — it's protecting the layout skeleton** from being accidentally dragged out of shape by a person or an agent.

## Why not inheritance, master-style

The genuinely hard part of a master model isn't compositing — it's **overrides**. If a user manually changes page 5's background to solid black, should updating the master overwrite that? Answering that requires tracking, attribute by attribute, "did this come from the master, or did the user change it" — a whole inheritance-and-override mechanism, and the hardest part of this feature area to test and the hardest bugs to reproduce — and when it goes wrong, the symptom is "the user's edit mysteriously disappeared," which is the most trust-damaging kind of bug there is.

Templates plus locking eliminate this problem **at the root**: a locked element can never be modified by anyone, so there is never a conflict that needs adjudicating.

And the value a master provides is, in this product, mostly carried by the agent instead. PowerPoint has to have masters because its users only have a mouse — changing the background on 30 pages by hand is 30 repetitions of the same work. This product's users have an agent — that's one sentence, thirty commands, one undo step. **Buying, with a whole inheritance mechanism, something the agent already gives you for free is a bad trade.**

## What locking blocks, and how far

- **People**: locked elements are completely untouchable in the editor — can't be selected, dragged, or deleted. The frontend never sends a flag that would break the lock.
- **Agents**: a normal command touching a locked element is refused, with an error explaining that it's a fixed element from the template and pointing to how to proceed; adding `--force` if the change is genuinely intended.

This is the third application of ADR-0004's "refuse, and point the way" pattern. It makes "I'm intentionally changing something that was locked" explicit, rather than something that happens ambiguously.

## Considered Options

- **A real master, composited at display time**: closest to PowerPoint, smallest files. But opening a single slide on its own would be missing its background — overturning ADR-0001, this project's very first decision.
- **A master exists, but changes are baked into every page**: same experience as PowerPoint, files stay self-contained. The cost is the attribute-by-attribute inheritance-and-override mechanism described above.
- **Detach on touch** (an element that's been moved auto-detaches from the template): a one-sentence rule, but coarse-grained and implicit — the user just nudged something two centimeters, and from then on it no longer follows the template, with no indication that happened.
- **Master mode plus semi-read-only placeholders** (content editable, appearance and position locked): this was the direct predecessor to the final decision. The only difference from the final approach is "is the template alive or dead" — once the template is dead, the whole tangle of placeholders, baking, detaching, and escape hatches disappears with it.

## Consequences

- **Changing a template doesn't change slides already made from it.** Swapping a logo or updating a footer year means asking the agent to sweep every page with `--force`, bundled as one undo step. **No sync mechanism is provided** — the one drawback of that approach (lots of repeated actions) is exactly the kind of drawback an agent is built to eliminate.
- **No template-switching is provided.** Choosing a template when a slide is created is final; switching means asking the agent to move the content over. A full template-swap feature needs a "slot" concept to map old placeholders to new ones, which is a separate decision.
- **A template can be edited with the ordinary editing commands**, because it's just a slide. No second format or second command set is needed for templates.
- **Locking is a single boolean flag, not a mechanism.** The implementation only has two guard points: the frontend's interaction layer, and the command entry point.
- A locked element on a slide can be deleted (it belongs to that page now) — deleting it doesn't affect the template, and doesn't affect any other slide.
