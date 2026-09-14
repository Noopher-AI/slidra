// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useState, type ChangeEvent, type DragEvent } from "react";
import type { CanvasController } from "../../../canvas.js";
import { embedUrlFor } from "../../../embed.js";
import { embedInsertInput, mediaInsertInput, shouldAutoPlayOnClick, type MediaAssetKind, type MediaInsertInput } from "./media-insert.js";

export interface VideoPanelProps {
  onClose(): void;
  controller: CanvasController | null;
  /** The presentation's own canvas size — `mediaInsertInput`'s geometry is a percentage of THIS, never a hard-coded 1280×720. `null` before it has loaded, which disables Insert. */
  canvasSize: { width: number; height: number } | null;
  /** `null` before a slide has loaded, which disables Insert. */
  slidePath: string | null;
}

/** This panel's own identity — used as the empty-placeholder kind when Insert is pressed with neither a file nor a URL (plan §4.2). */
const PANEL_KIND: MediaAssetKind = "video";

/**
 * Video insert panel. Same as `ImagePanel`: file/URL are mutually exclusive,
 * leaving both empty inserts a placeholder box, caption lands as
 * `element name set`. The actual format is always decided by `asset.kind`
 * (byte-sniffed), never by which panel was used — picking a PNG in the
 * Video panel legitimately inserts an image (D9/ADR-0015).
 */
export function VideoPanel({ onClose, controller, canvasSize, slidePath }: VideoPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [pending, setPending] = useState(false);

  const canInsert = controller !== null && canvasSize !== null && slidePath !== null && !pending;

  function pickFile(next: File | null): void {
    setFile(next);
    if (next) setUrl("");
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>): void {
    pickFile(event.target.files?.[0] ?? null);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    pickFile(event.dataTransfer.files[0] ?? null);
  }

  function handleUrlChange(next: string): void {
    setUrl(next);
    if (next !== "") setFile(null);
  }

  async function insert(): Promise<void> {
    if (!canInsert || !controller || !canvasSize || !slidePath) return;
    setPending(true);

    // A YouTube link is not an asset — there are no bytes to download and
    // no file header to detect, so it must be recognised BEFORE the import
    // path, not fail inside it. `embedUrlFor` returns null for an ordinary
    // media URL, which falls through to the download below unchanged.
    const trimmedUrl = url.trim();
    const embed = file === null && trimmedUrl !== "" ? embedUrlFor(trimmedUrl) : null;

    let assetKind: MediaAssetKind = PANEL_KIND;
    let path: string | null = null;
    if (embed) {
      // Nothing to import: fall straight through to the insert below.
    } else if (file) {
      const imported = await controller.importAsset(file);
      if (!imported.ok) {
        setPending(false);
        return;
      }
      assetKind = imported.data.kind;
      path = imported.data.path;
    } else if (trimmedUrl !== "") {
      const imported = await controller.importAssetFromUrl(trimmedUrl);
      if (!imported.ok) {
        setPending(false);
        return;
      }
      assetKind = imported.data.kind;
      path = imported.data.path;
    }

    const input: MediaInsertInput = embed ? embedInsertInput(embed, canvasSize) : mediaInsertInput(assetKind, path, canvasSize);
    const inserted = await controller.runCommand("element insert", { slidePath, ...input });
    setPending(false);
    if (!inserted.ok) return;

    const insertedData = inserted.data as { elementId?: unknown } | undefined;
    const insertedId = typeof insertedData?.elementId === "string" ? insertedData.elementId : undefined;

    // An inserted video should play in play mode without the author having
    // to go and build an effect list by hand — see shouldAutoPlayOnClick.
    if (insertedId && shouldAutoPlayOnClick(input)) {
      await controller.runCommand("effect add", {
        slidePath,
        elementIds: [insertedId],
        family: "media",
        effect: "play",
        start: "on-click",
      });
    }

    const trimmedCaption = caption.trim();
    if (trimmedCaption !== "") {
      if (insertedId) {
        // D4: a failure here does not roll back the insert; the message is
        // just handed to the existing CanvasState.error channel — runCommand
        // already does this itself, no extra handling needed here.
        await controller.runCommand("element name set", { slidePath, elementIds: [insertedId], name: trimmedCaption });
      }
    }
    onClose();
  }

  return (
    <div className="floating-layer dock-panel media-panel" role="dialog" aria-label="Video">
      <label className="media-panel-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        <input type="file" accept="video/*" onChange={handleFileInput} />
        {file ? file.name : "Drop a video, or click to choose"}
      </label>
      <input
        className="media-panel-url"
        type="text"
        placeholder="Or paste a video URL"
        value={url}
        onChange={(event) => handleUrlChange(event.target.value)}
      />
      <input
        className="media-panel-caption"
        type="text"
        placeholder="Caption"
        value={caption}
        onChange={(event) => setCaption(event.target.value)}
      />
      <button type="button" className="media-panel-insert" disabled={!canInsert} onClick={() => void insert()}>
        Insert
      </button>
    </div>
  );
}
