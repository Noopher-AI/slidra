import type { CanvasController, CanvasState } from "../../canvas.js";
import { TableSection } from "./style/TableSection.js";

export interface StyleObjectPanelProps {
  state: CanvasState;
  controller: CanvasController | null;
}

/**
 * 樣式 › Object. Empty container except for exactly one case (E2.T14, plan
 * §0(b)): a single selected table renders `TableSection` instead — every
 * other selection shape (nothing selected, a non-table element, multiple
 * elements) keeps the original empty-container behaviour unchanged.
 */
export function StyleObjectPanel({ state, controller }: StyleObjectPanelProps) {
  const elements = state.selection.elements;
  const single = state.selection.ids.length === 1 ? elements[0] : null;

  if (single && single.kind === "table" && single.table !== null) {
    return (
      <TableSection
        state={state}
        controller={controller}
        elementId={state.selection.ids[0]}
        theme={single.table.theme}
        header={single.table.header}
        source={single.table.source}
      />
    );
  }

  return <div className="style-object-panel" role="tabpanel" aria-label="樣式 · Object" />;
}
