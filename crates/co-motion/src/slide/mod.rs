// `scan` landed in an earlier commit (NOOP-278's scan/svgnum/transform
// slice). `format`/`style`/`table_grid` land in this commit (the
// slide/format.ts + slide-style.ts + table/model.ts(partial) slice).
pub mod format;
pub mod scan;
pub mod style;
pub mod table_grid;
pub mod transition;
