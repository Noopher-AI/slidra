# 08 · Known Gaps and Suggested Roadmap

## What the prototype deliberately leaves out or simulates
| Item | Current state | Suggestion |
|---|---|---|
| Open / Save / Export | Simulated with a toast | Wire up to the §04 REST + job progress |
| Agent replies | Chat only sends the user's message; outline drafting is a 1.4s simulation | WebSocket event stream; command-card state driven by the backend |
| Paste / Cut / Copy | Not provided (at the keyboard level) | System clipboard + cross-page paste |
| Slide number, legacy Transitions | Already removed | — |
| Media other than images | Placeholder box (shows the filename) | Real `<video>/<audio>` with playback controls |
| Text box | Single line, no auto-wrap | Multi-line, auto height, rich text (bold/italic, lists) |
| Style panel | Values are read-only display (except tables) | Editable font size/color/alignment, shape fill and stroke |
| Templates dialog | Rename/Delete not wired up | Full template CRUD |
| Playback | No Fullscreen API, no presenter view | Fullscreen API; dual-screen presenter view (notes + next slide) |
| Responsiveness | Minimum 1280px | Collapsible right rail; toolbar degrades to icons at narrow widths |
| Accessibility | Has aria-labels; focus order not specially tuned | Keyboard-reachable menus, focus traps, screen-reader testing |
| History | Page size not in history; comments not in history | Unify these |
| Groups | No group-level position/size property; no whole-group proportional resize | Group bbox resize should cascade to members |
| Animation | Entrance only; no emphasis/exit; no auto-trigger (After is sequence-only) | Emphasis/Exit; timeline view; motion paths |
| Charts | Single y-axis, no fine control over negative-value ticks | Dual axis, stacking, CSV data import |

## Suggested next steps (by impact)
1. **Agent diff preview with Accept/Reject**: show the agent's changes as side-by-side thumbnails that can be accepted item by item — this is the core of trust in human-agent collaboration.
2. **Closing the pin loop**: open → read → in progress → resolved; agent replies attach under the pin.
3. **Editable style panel** + rich text.
4. **Land the backend contract** (§04) and use the BDD spec (§05) as acceptance tests.
5. Presenter view and export (By-frame PDF).
