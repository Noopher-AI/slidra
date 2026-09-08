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

pub mod arrange;
pub mod edit;
pub mod group;
pub mod splice;
pub mod text;

use crate::slide::scan::{ScannedNode, attribute_value};

/// `data-comot-lock="true"` marks an element as a locked layout skeleton
/// piece (ADR-0013). Ported from `element-text.ts`'s `LOCK_ATTRIBUTE` —
/// that file is TS's single source of truth for this constant (every other
/// TS module imports it rather than redeclaring it), so unlike the four
/// splice helpers this is not "one of several duplicated copies to
/// consolidate" — it is simply this crate's one copy of what was always
/// one thing.
pub const LOCK_ATTRIBUTE: &str = "data-comot-lock";

/// The one guard every editing command that targets an *existing* element
/// checks before mutating it (ADR-0013): `element move`/`rotate`/`order`
/// here, plus `scale`/`resize`/`style set` (P4) and `text set`/`textbox
/// width` (P6) once they land. `element insert` never calls this (a
/// brand-new element cannot already be locked) and `element delete`/`cut`
/// deliberately never call it either (ADR-0013: a locked element may still
/// be deleted or cut, no `--force` required).
///
/// `force: true` is the one-time bypass `--force` asks for explicitly on
/// that single command; it never persists (the lock attribute stays
/// exactly as it was).
pub fn assert_not_locked(
    node: &ScannedNode,
    element_id: &str,
    force: bool,
) -> crate::errors::CoMotionResult<()> {
    if force {
        return Ok(());
    }
    if attribute_value(node, LOCK_ATTRIBUTE).as_deref() == Some("true") {
        return Err(crate::errors::CoMotionError::invalid(format!(
            "元素 {element_id} 是鎖定的版面骨架，一般命令不會改動它。確定要改請在同一條命令加上 --force。"
        )));
    }
    Ok(())
}
