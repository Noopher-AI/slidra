# Security policy

A `.slidra` deck is meant to be opened by people other than its author, so the readers in this repository treat every deck as hostile (format §17): the container bytes, the slide SVG, and every id, attribute and text in it.

## Reporting a vulnerability

Report it privately through **GitHub's private vulnerability reporting**: the *Security* tab of this repository → *Report a vulnerability*. Please do not open a public issue.

Include a deck, or the steps, that shows the problem, and what an attacker gains from it. We will confirm receipt, work on a fix with you, and credit you in the advisory unless you prefer otherwise.

## In scope

- **Sandbox escapes**: script from a slide that runs in the viewer's own origin; a slide that reads or changes the viewer page, another slide or another deck; bypasses of the slide frame's `sandbox` attribute or its Content-Security-Policy.
- **Network leaks**: a deck that makes the viewer, the `<slidra-player>` element or `/embed` contact the network without the viewer's consent (format §13), or that makes the server's link-preview renderer (`/api/og`) read a server file or fetch a URL.
- **Unsafe links**: a `data-slidra-link` or `<a href>` that runs script, navigates the viewer away, or opens a page with a reference back to the viewer.
- **Reader robustness**: a deck file that crashes or hangs the SQLite or ZIP reader, bypasses its size limits, or escapes the deck's entry paths (format §1.4).
- **Presenter channel**: a page that can drive or read a presenter-view session it did not open.

## Out of scope

- A deck that only looks misleading (spoofed content). Slides are pictures, and they can show anything.
- Denial of service from decks within the documented limits (1 GB per deck, 256 MB per entry, 50,000 entries).
- Decks a server operator chose to trust with `SLIDRA_ALLOW_REMOTE=1`.

## Supported versions

Security fixes land on `main`. The live demo is deployed from `main`.
