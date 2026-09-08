//! Crate root — wires together the modules ported from `packages/core`
//! (NOOP-278). Nothing here previously declared any of these as part of the
//! compiled crate (this file was a bare placeholder comment), so `errors`,
//! `id`, `result`, and `fallback` were dead files until this change, along
//! with the two new modules this ticket adds (`history`, `workspace`).
//!
//! `geometry`, `slide`, and `svgnum` are a separate slice of the same
//! NOOP-278 port (scan.ts / svg-number.ts / geometry/transform.ts); each
//! `mod.rs` under `geometry/` and `slide/` only declares the one submodule
//! this slice owns (`transform` and `scan` respectively) — sibling
//! submodules (`geometry::bbox`, `slide::format`, `slide::style`,
//! `slide::table_grid`, ...) are separate, later commits' responsibility.
pub mod argv;
pub mod base64;
pub mod commands;
pub mod container;
pub mod effects;
pub mod errors;
pub mod fallback;
pub mod geometry;
pub mod history;
pub mod id;
pub mod presentation;
pub mod presentation_canvas;
pub mod result;
pub mod slide;
pub mod splice;
pub mod svgnum;
pub mod text;
pub mod workspace;
