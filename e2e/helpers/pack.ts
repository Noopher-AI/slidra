// Re-exports the same `packDirectory` the deleted TypeScript engine package
// used to provide, now backed by `scripts/pack-directory.mjs` (plan section
// 2.6) — kept as its own file under `e2e/helpers/` only so the ~30 e2e files
// that import it change one import path, not their call sites.
export { packDirectory } from "../../scripts/pack-directory.mjs";
