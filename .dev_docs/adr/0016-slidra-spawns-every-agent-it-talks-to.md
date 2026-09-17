# ADR-0016 — Slidra spawns every agent it talks to

*Status: in force.*

A policy that says what an agent may reach is worth nothing unless the agent runs
inside something that enforces it. Enforcement comes from the operating system, and the
operating system can only be asked at the moment a process is created.

**Decision.** Slidra starts every agent it talks to, inside a box built from that workbench's
policy. Any agent qualifies — the ones that ship and any executable a person names — provided
it speaks the published protocol over its standard streams (ADR-0004). **Slidra will never
attach to an agent that is already running.**

**Rejected.** Attaching to a running agent, reached at an address. It is the obvious way to
let people run their agent however they like, and it is the only shape in which an unboxed
agent can exist: a process Slidra did not create cannot be confined afterwards. Removing the
shape removes the class of failure, rather than warning about it.

**Consequences.**
- "Bring your own agent" is not narrowed by this. What a third party supplies is an
  executable, and it needs no code written for Slidra.
- The box's rules must be data, not paths named after the agents that ship today, or the first
  third-party agent either breaks or is granted more than it needs.
- **Confinement is best-effort.** Where the operating system offers nothing, the box does
  nothing, and the product has to say so where a person will see it — a log line is not
  saying so.
- An agent's vendor-hosted tools run on the vendor's machines and are outside every policy.
  Closing a workbench means disabling those too, at the agent's own configuration.
