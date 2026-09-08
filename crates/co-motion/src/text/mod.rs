//! Barrel for the text-layout engine (NOOP-278), ported from
//! `packages/core/src/text/` and `packages/core/src/text-metrics.ts`.
//! Mirrors `packages/core/src/text/index.ts`'s re-export surface, plus
//! `font`/`metrics` (which the TS side keeps in a top-level
//! `text-metrics.ts` instead of under `text/`) and `escape` (ported out of
//! `element-text.ts` — see `escape.rs`'s own header comment for why).

pub mod escape;
pub mod font;
pub mod list;
pub mod metrics;
pub mod render;
pub mod runs;
pub mod wrap;

pub use escape::{escape_xml_attr, escape_xml_text, unescape_xml_text};
pub use font::{parse_font, FontMetrics, ParsedFont, DEFAULT_FONT_BYTES, DEFAULT_FONT_FAMILY};
pub use list::{list_indents, parse_list_tokens, ListKind, LIST_INDENT_EM};
pub use metrics::measure_text_width;
pub use render::render_text_box_content;
pub use runs::{apply_run_style, read_text_box_runs, utf16_offset_to_byte_offset, RunStyleUpdate, TextRun};
pub use wrap::{break_allowed_between, no_break_after, no_break_before, wrap_text, Align, WrapOptions, WrappedLine, WrappedText};
