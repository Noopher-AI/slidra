// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { ReactElement } from "react";
import type { SlideElement } from "../../slide-dom.js";
import type { CanvasController, CanvasState } from "../../canvas.js";
import { summarizeSelection, type StyleReadResult } from "../../style-attrs.js";
import { StyleField } from "./style/StyleField.js";
import { TableSection } from "./style/TableSection.js";
import { ChartSkeletonSection, ImageCaptionSkeletonSection, TableSkeletonSection } from "./style/SkeletonSections.js";

export interface StyleObjectPanelProps {
  state: CanvasState;
  controller: CanvasController | null;
}

/** §4.1: everything that isn't `text`/`group` counts as a shape for the panel's Shape section. */
const SHAPE_KINDS = new Set(["rect", "ellipse", "circle", "line", "path", "compound"]);

const ALIGN_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

const ANCHOR_TO_ALIGN: Record<string, "left" | "center" | "right"> = { start: "left", middle: "center", end: "right" };
const ALIGN_TO_ANCHOR: Record<string, string> = { left: "start", center: "middle", right: "end" };

/** `SlideElement.textAlign` is present (defaulting to "left") on every element, never `null` — so a text box's Align summary is never `"unset"`, only `"value"`/`"mixed"` (§4.1). */
function summarizeTextBoxAlign(elements: readonly SlideElement[]): StyleReadResult {
  const [first, ...rest] = elements.map((element) => element.textAlign);
  return rest.every((value) => value === first) ? { kind: "value", value: first } : { kind: "mixed" };
}

/** Maps a plain `<text>`'s `text-anchor` read result (start/middle/end, or unset/mixed) onto the panel's left/center/right display domain. */
function anchorResultAsAlign(result: StyleReadResult): StyleReadResult {
  if (result.kind !== "value") return result;
  const mapped = ANCHOR_TO_ALIGN[result.value];
  return mapped ? { kind: "value", value: mapped } : result;
}

/**
 * Style › Object (§4.1): segmented by the selection's element kind —
 * Text / Shape / Appearance (always) / Image caption, Table, Chart
 * (skeletons, always). Every field is one `element style set` / `textbox
 * align` call = one history entry (decision 8: no draft batching).
 */
export function StyleObjectPanel({ state, controller }: StyleObjectPanelProps) {
  const elements = state.selection.elements.filter((element): element is SlideElement => element !== null);
  const selectionKey = state.selection.ids.join(",");

  // §0(b): a single selected table renders `TableSection` instead
  // of the generic sections — every other selection shape falls through.
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

  if (elements.length === 0) {
    return (
      <div className="style-object-panel" role="tabpanel" aria-label="Style · Object">
        <p className="style-panel-empty">Select an element to view its style</p>
      </div>
    );
  }

  const hasGroup = elements.some((element) => element.kind === "group");
  const allText = elements.every((element) => element.kind === "text");
  const allShape = elements.every((element) => SHAPE_KINDS.has(element.kind));
  const mixedTypes = !hasGroup && !allText && !allShape;
  const hasMedia = elements.some((element) => element.media !== null);

  async function setStyle(attr: string, value: string): Promise<boolean> {
    return controller ? controller.setStyle(attr, value) : false;
  }

  function renderTextSection(): ReactElement | null {
    if (!allText) return null;
    const allBoxes = elements.every((element) => element.textWidth !== null);
    const allPlain = elements.every((element) => element.textWidth === null);
    const alignUnavailable = !allBoxes && !allPlain;
    const alignCurrent: StyleReadResult = allBoxes
      ? summarizeTextBoxAlign(elements)
      : anchorResultAsAlign(summarizeSelection(elements, "text-anchor"));

    async function commitAlign(value: string): Promise<boolean> {
      if (allBoxes) {
        return controller ? controller.setTextAlign(value as "left" | "center" | "right") : false;
      }
      return setStyle("text-anchor", ALIGN_TO_ANCHOR[value] ?? value);
    }

    return (
      <fieldset className="style-section" data-section="text">
        <legend>Text</legend>
        <StyleField
          attr="font-family"
          label="Font"
          control="text"
          disabled={hasGroup}
          current={summarizeSelection(elements, "font-family")}
          resetKey={`${selectionKey}:font-family`}
          onCommit={(value) => setStyle("font-family", value)}
        />
        <StyleField
          attr="font-size"
          label="Size"
          control="number"
          min={0}
          disabled={hasGroup}
          current={summarizeSelection(elements, "font-size")}
          resetKey={`${selectionKey}:font-size`}
          onCommit={(value) => setStyle("font-size", value)}
        />
        <StyleField
          attr="font-weight"
          label="Weight"
          control="text"
          disabled={hasGroup}
          current={summarizeSelection(elements, "font-weight")}
          resetKey={`${selectionKey}:font-weight`}
          onCommit={(value) => setStyle("font-weight", value)}
        />
        <StyleField
          attr="fill"
          label="Text color"
          control="text"
          disabled={hasGroup}
          current={summarizeSelection(elements, "fill")}
          resetKey={`${selectionKey}:text-fill`}
          onCommit={(value) => setStyle("fill", value)}
        />
        <StyleField
          attr="align"
          label="Align"
          control="select"
          options={ALIGN_OPTIONS}
          disabled={hasGroup || alignUnavailable}
          note={alignUnavailable ? "Selection mixes text boxes and plain text; alignment is unavailable" : null}
          current={alignCurrent}
          resetKey={`${selectionKey}:align`}
          onCommit={commitAlign}
        />
      </fieldset>
    );
  }

  function renderShapeSection(): ReactElement | null {
    if (!allShape) return null;
    return (
      <fieldset className="style-section" data-section="shape">
        <legend>Shape</legend>
        <StyleField
          attr="fill"
          label="Fill color"
          control="text"
          disabled={hasGroup}
          current={summarizeSelection(elements, "fill")}
          resetKey={`${selectionKey}:shape-fill`}
          onCommit={(value) => setStyle("fill", value)}
        />
        <StyleField
          attr="stroke"
          label="Stroke color"
          control="text"
          disabled={hasGroup}
          current={summarizeSelection(elements, "stroke")}
          resetKey={`${selectionKey}:stroke`}
          onCommit={(value) => setStyle("stroke", value)}
        />
        <StyleField
          attr="stroke-width"
          label="Stroke width"
          control="number"
          min={0}
          disabled={hasGroup}
          current={summarizeSelection(elements, "stroke-width")}
          resetKey={`${selectionKey}:stroke-width`}
          onCommit={(value) => setStyle("stroke-width", value)}
        />
      </fieldset>
    );
  }

  return (
    <div className="style-object-panel" role="tabpanel" aria-label="Style · Object">
      {hasGroup && <p className="style-panel-note">Groups have no elements to apply style to</p>}
      {mixedTypes && <p className="style-panel-note">Selection mixes multiple element types; only shared properties are shown</p>}
      {renderTextSection()}
      {renderShapeSection()}
      <fieldset className="style-section" data-section="appearance">
        <legend>Appearance</legend>
        <StyleField
          attr="opacity"
          label="Opacity"
          control="number"
          min={0}
          max={1}
          disabled={hasGroup}
          current={summarizeSelection(elements, "opacity")}
          resetKey={`${selectionKey}:opacity`}
          onCommit={(value) => setStyle("opacity", value)}
        />
      </fieldset>
      <ImageCaptionSkeletonSection visible={hasMedia} />
      <TableSkeletonSection />
      <ChartSkeletonSection />
    </div>
  );
}
