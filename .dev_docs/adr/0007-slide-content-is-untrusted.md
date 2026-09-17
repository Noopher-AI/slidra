# ADR-0007 — Slide content is untrusted

*Status: in force.*

A deck is meant to be opened by people other than its author, and valid SVG can carry event
handlers. Run as first-party content, those scripts could reach the app's own interfaces and
exfiltrate the deck.

**Decision.** Slide content always renders inside a sandboxed frame from an opaque origin.
Scripts are enabled only for the app's own small reporting runtime, and same-origin is
**never** granted — the two together would let the content escape the sandbox entirely.

**Rejected.** Sanitising on the server and embedding as first-party content. Sanitiser bypass
is a well-known attack class; a browser sandbox hardened over many years is the better boundary.

**Consequences.**
- The server must refuse requests carrying an opaque origin. Enabling scripts and refusing
  those requests are two halves of one decision; doing only the first is worse than doing
  neither.
- Selection chrome drawn inside the untrusted document lives in a shadow root, because the
  slide's own styling could otherwise hide it.
- Anything the app needs to know about the content's geometry is reported out by that runtime,
  not computed by the parent.
- Third-party embeds cannot live inside the sandbox and are drawn by the parent over it.

*Which frame flags apply in which mode is in `docs/spec/rendering.md`.*
