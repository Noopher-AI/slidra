# ADR-0008 — Every element is framed in a transform group

*Status: in force.*

Editing needs four things: move, scale, rotate, group. Bare graphical primitives express
position four different ways and have nowhere at all to record rotation.

**Decision.** An element is a container wrapping one or more primitives. Position and rotation
live only on the container's transform; size stays on the primitives' own attributes.

**Rejected.**
- An explicit bounding box plus an angle. Easiest to compute with, closest to how other tools
  think — and it stores the same fact twice. When the two disagree nothing errors; the picture
  quietly moves. Rotation also becomes a custom attribute other tools ignore, so a rotated
  title renders upright everywhere else, breaking ADR-0001.
- No container, commands editing primitives directly. Cleanest markup, lowest cost — but
  rotation has nowhere to live and moving a group means rewriting every child.

Containers and transforms have been core syntax since the first SVG specification, so every
browser and vector tool renders them correctly, rotation included. That compatibility is the
main reason for the choice, not a side benefit.

**Consequences.**
- One wrapper per element is a real cost, paid in conversation tokens, for four capabilities
  and one operation vocabulary.
- Absolute position must be computed through nesting. The editor and the CLI must agree
  exactly, or the picture jumps when a gesture ends.
- Position and size attributes are excluded from the styling command, because the invariant
  "position is written in one place" needs a structural guard, not a convention.
- Non-conforming SVG cannot be edited until it is converted, and conversion is something a
  person asks for — never silent.

*Container shapes that are exceptions, such as charts and tables, are in
`docs/spec/slide-format.md`.*
