// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useState, type ChangeEvent, type DragEvent } from "react";
import type { CanvasController } from "../../../canvas.js";
import { mediaInsertInput, type MediaAssetKind } from "./media-insert.js";

export interface ImagePanelProps {
  onClose(): void;
  controller: CanvasController | null;
  /** The presentation's own canvas size — `mediaInsertInput`'s geometry is a percentage of THIS, never a hard-coded 1280×720. `null` before it has loaded, which disables Insert. */
  canvasSize: { width: number; height: number } | null;
  /** `null` before a slide has loaded, which disables Insert. */
  slidePath: string | null;
}

/** This panel's own identity — used as the empty-placeholder kind when Insert is pressed with neither a file nor a URL (plan §4.2). */
const PANEL_KIND: MediaAssetKind = "image";

/**
 * Image insert panel: file picker (which is also the drop zone), URL text
 * field, caption text field, Insert button. File and URL are mutually
 * exclusive (picking a file clears the URL, typing a URL clears the file);
 * leaving all three empty inserts an empty placeholder box. The actual
 * format is always decided by `asset.kind` (byte-sniffed), never by which
 * panel was used — D9: panel identity is never the source of
 * format, so picking a PNG in the Video panel legitimately inserts an image.
 */
export function ImagePanel({ onClose, controller, canvasSize, slidePath }: ImagePanelProps) {
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

    let assetKind: MediaAssetKind = PANEL_KIND;
    let path: string | null = null;
    if (file) {
      const imported = await controller.importAsset(file);
      if (!imported.ok) {
        setPending(false);
        return;
      }
      assetKind = imported.data.kind;
      path = imported.data.path;
    } else if (url.trim() !== "") {
      const imported = await controller.importAssetFromUrl(url.trim());
      if (!imported.ok) {
        setPending(false);
        return;
      }
      assetKind = imported.data.kind;
      path = imported.data.path;
    }

    const input = mediaInsertInput(assetKind, path, canvasSize);
    const inserted = await controller.runCommand("element insert", { slidePath, ...input });
    setPending(false);
    if (!inserted.ok) return;

    const trimmedCaption = caption.trim();
    if (trimmedCaption !== "") {
      const data = inserted.data as { elementId?: unknown } | undefined;
      const elementId = typeof data?.elementId === "string" ? data.elementId : undefined;
      if (elementId) {
        // D4: a failure here does not roll back the insert; the message is
        // just handed to the existing CanvasState.error channel — runCommand
        // already does this itself, no extra handling needed here.
        await controller.runCommand("element name set", { slidePath, elementIds: [elementId], name: trimmedCaption });
      }
    }
    onClose();
  }

  return (
    <div className="floating-layer dock-panel media-panel" role="dialog" aria-label="Image">
      <label className="media-panel-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        <input type="file" accept="image/*" onChange={handleFileInput} />
        {file ? file.name : "Drop an image, or click to choose"}
      </label>
      <input
        className="media-panel-url"
        type="text"
        placeholder="Or paste an image URL"
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
