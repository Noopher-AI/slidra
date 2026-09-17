# ADR-0004 — Agents attach through a published protocol

*Status: in force.*

Chat is part of the product, but authorization, token refresh and provider catalogues are
not things anyone would choose this product for.

**Decision.** The app is a client of a published agent protocol. It does not implement an
agent, and it does not own the person's relationship with their agent vendor.

**Rejected.**
- Driving each vendor's own streaming format: N fragile parsers, each proprietary and free to
  change without notice.
- Building an agent runtime: OAuth, refresh, provider catalogue — unbounded work, unrelated
  to the product's value.

**Consequences.**
- Any agent with an existing adapter works without integration code written for it.
- Attaching pending annotations to an outgoing message is native to the protocol's content
  model, not a workaround.
- The protocol is still evolving, but a public specification changes through discussion with
  a migration path, which is a safer place to stand than several private formats.
