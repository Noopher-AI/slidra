# Connect external agents via an ACP client, rather than building an agent runtime and authorization stack

> **This ADR has been revised to drop the premise that "the user has already installed and logged in."** The original text below assumed both of those were already handled by the user themselves: the adapter is already installed on the machine, and the CLI is already logged in. Neither is assumed anymore — **both adapters (`claude-code-acp`/`codex-acp`) are now npm dependencies of the server package, bundled and installed alongside the app** rather than requiring a separate `npm install -g`; **login state is now actively probed by `serve`** (`claude auth status --json` / `codex login status`) rather than simply assumed before sending a chat message. As a consequence, "no agent available" is no longer a reason for `serve` to fail to start: **`serve` always starts**; not having selected or logged into an agent only blocks chat itself (`POST /api/chat` returns 409), and nothing else is affected — a path the earlier implementation explicitly excluded ("no 'pick one anyway' and no 'chat disabled but serve runs'") is now the default behavior. The core positions of this ADR — "the external tool handles its own authorization and billing" and "the app does not implement its own agent" — are unaffected: probing login state just reads the result of an existing command, it isn't the app managing OAuth itself.
>
> **Partially revised.** "The editing contract sent at the start of a conversation is a plain user message, with no skill and no system prompt" becomes: **the editing contract is still a user message** (the reason — consistent behavior across providers — is unchanged) — but "no skill" no longer holds. Stable, long-lived guidance (long-standing conventions, the full command reference) and skills now go through a different path: a product-owned working directory that ships with the package and is re-laid-out on every `slidra serve` start, at a fixed location on the user's machine (`<SLIDRA_HOME>/agent`). The agent reads it with its own native file-reading capability, instead of it being resent inside a user message on every turn.
>
> **What still stands**: connecting via an ACP client rather than building an agent runtime or OAuth; the `session/prompt` content-block array as the native extension point for annotations; and ADR-0004's two layers of protection remaining the ACP client's responsibility.

The app ships with chat built in, but does not implement its own agent. The user has already installed and logged into Codex or Claude Code; those tools already handle authorization and billing themselves, and the app shouldn't redo OAuth, provider abstraction, and a tool-calling loop from scratch — nobody would choose this app for any of that.

The app is implemented as an **Agent Client Protocol (ACP) client** (JSON-RPC 2.0 over stdio), connecting to any agent through its existing adapter.

## Considered Options

- **Drive each vendor's CLI stream-json format directly**: every vendor needs its own parser, and the format is proprietary and can change at any time. Maintaining N fragile parsers isn't where this product's value lies.
- **Build a custom agent runtime**: requires implementing OAuth, token refresh, and a provider catalog from scratch. Zero relationship to product value, and the kind of engineering effort that's prone to spiraling out of control.

## Consequences

- Claude Code, Codex, Gemini CLI, and any other agent in the registry all work with zero integration code written for any one of them.
- The `session/prompt` prompt is a content-block array, so "attach a pending annotation to an outgoing message" is a native extension point of the protocol, not a workaround: what the user types is a text block, with the annotation following as a resource block.
- The **editing contract** sent at the start of a conversation is a plain user message, with no skill and no system prompt. The reason is that a user message behaves identically across every agent, so switching providers requires no changes.
- ADR-0004's two layers of protection (file methods, permission hook) are both the ACP client's responsibility, which is why this decision is the precondition that makes ADR-0004 work at all.
- Risk: the ACP spec is still evolving. But compared to parsing multiple proprietary formats ourselves, changes to a public spec come with discussion and a migration path, which is actually the lower-risk position.
