// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

export type MediaKind = "video" | "audio";

export const MEDIA_FORMATS: Readonly<Record<string, { kind: MediaKind; mime: string }>> = {
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".m4v": { kind: "video", mime: "video/mp4" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".ogv": { kind: "video", mime: "video/ogg" },
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".opus": { kind: "audio", mime: "audio/opus" },
  ".oga": { kind: "audio", mime: "audio/ogg" },
  ".aac": { kind: "audio", mime: "audio/aac" },
};

export const VIDEO_EXTENSIONS = Object.keys(MEDIA_FORMATS).filter(
  (extension) => MEDIA_FORMATS[extension]!.kind === "video",
);
export const AUDIO_EXTENSIONS = Object.keys(MEDIA_FORMATS).filter(
  (extension) => MEDIA_FORMATS[extension]!.kind === "audio",
);

export function mediaFormatFor(reference: string): { kind: MediaKind; mime: string } | null {
  const dot = reference.lastIndexOf(".");
  return dot === -1 ? null : MEDIA_FORMATS[reference.slice(dot).toLowerCase()] ?? null;
}
