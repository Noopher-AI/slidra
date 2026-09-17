# ADR-0015 — Rendering is its own service

*Status: in force.*

Export has always been a browser pointed at the editor's own page: the same bundle, the same
read-only routes, driven headlessly and captured. Once those routes belong to the deck server
(ADR-0015) and the bundle to the editor's service, the only thing export still owns is the
browser — and a browser is a heavy, slow-starting dependency that has nothing to do with
either.

**Decision.** Rendering is a service of its own. It holds the browser, points it at the
editor's service, reads through the deck server, and writes the result. It is the fourth
part, alongside the editor, the deck server and the agent runner.

**Rejected.**

- **Folding it into the editor's service.** Everyone who loads the editor would be served by
  something carrying a browser it never uses.
- **Folding it into the agent runner** — already the heavy one, so the cheapest place to hide
  it. It would tie exporting to the availability of something unrelated, and the first
  confusing incident is "exports stopped because agents did".
- **Keeping it a command that starts nothing.** Locally fine, and it leaves a hosted edition
  with nowhere to render, which is the same work again.

**Consequences.**
- Rendering holds a read-only credential (ADR-0015) and can hold nothing else. Export is
  therefore the first real user of the viewer kind, which stops it being untested.
- The private HTTP server export used to start disappears: there is always a deck server and
  an editor service to point at.
- A deployment that never exports can leave this part out entirely.
