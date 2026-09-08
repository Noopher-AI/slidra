//! The pure `svgContent: string -> string` mutation layer this ticket
//! ports from `packages/core/src/element-edit.ts`, `element-group.ts`,
//! `element-arrange.ts`, and `element-clipboard.ts` (plan section 1.1).
//! Every function here takes and returns plain SVG text, never touches the
//! filesystem, and reports every failure as `CoMotionError` — the CLI argv
//! layer lives one level up, in `crate::commands::element` (a different
//! module tree with a similar name; see that module's own doc comment for
//! why the two are not merged).
//!
//! `splice` is the one module this ticket's four TS sources genuinely
//! share a single Rust copy of (plan section 7, decision D6) — see its doc
//! comment for the UTF-16-offset contract every other submodule here must
//! follow when it lands.

pub mod splice;
