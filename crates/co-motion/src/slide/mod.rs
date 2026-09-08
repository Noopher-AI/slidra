// `scan` landed in an earlier commit (NOOP-278's scan/svgnum/transform
// slice). `format`/`style`/`table_grid` landed in the F2 commit (the
// slide/format.ts + slide-style.ts + table/model.ts(partial) slice).
// `notes`/`transition`/`normalise`/`ops` land in this commit ([E4.T4]:
// container and slide commands).
pub mod format;
pub mod normalise;
pub mod notes;
pub mod ops;
pub mod scan;
pub mod style;
pub mod table_grid;
pub mod transition;
