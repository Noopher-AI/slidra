// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { ServiceClient } from "./service-clients.js";

interface ObjectUrlFactory {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

const URL_ATTRIBUTES = ["href", "xlink:href", "src", "poster", "data-slidra-media"] as const;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".ogv"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".oga", ".ogg", ".m4a"];

function mediaKind(reference: string): "video" | "audio" | null {
  const dot = reference.lastIndexOf(".");
  const extension = dot === -1 ? "" : reference.slice(dot).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return null;
}

function mediaType(reference: string): string | undefined {
  const extension = reference.slice(reference.lastIndexOf(".")).toLowerCase();
  const types: Record<string, string> = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".oga": "audio/ogg",
    ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  };
  return types[extension];
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function deckPath(reference: string, documentPath: string): string | null {
  const value = reference.trim();
  if (value === "" || value.startsWith("#") || value.startsWith("data:") || value.startsWith("blob:")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return null;

  if (value.startsWith("/api/raw/")) return value.slice("/api/raw/".length);
  if (value.startsWith("/raw/")) return value.slice("/raw/".length);
  if (value.startsWith("/")) return null;

  const resolved = new URL(value, `https://deck.invalid/${documentPath}`);
  return resolved.pathname.slice(1);
}

/**
 * Owns every object URL used by one rendered deck generation. A caller
 * resets it before replacing a frame and disposes it when the workbench
 * leaves, so credentialed deck bytes never fall back to browser subrequests.
 */
export class DeckAssetResolver {
  readonly #urls = new Map<string, string>();

  constructor(
    private readonly deck: Pick<ServiceClient, "fetch">,
    private readonly objectUrls: ObjectUrlFactory = URL,
  ) {}

  async resolveSvg(markup: string, documentPath: string): Promise<string> {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("Failed to parse slide while resolving deck assets");

    for (const element of Array.from(parsed.querySelectorAll("*"))) {
      for (const attribute of URL_ATTRIBUTES) {
        if (!element.hasAttribute(attribute)) continue;
        const current = element.getAttribute(attribute);
        if (current === null) continue;
        if (attribute === "data-slidra-media" && !element.hasAttribute("data-slidra-type")) {
          const kind = mediaKind(current);
          if (kind !== null) element.setAttribute("data-slidra-type", kind);
        }
        element.setAttribute(attribute, await this.#resolveReference(current, documentPath));
      }
      const inlineStyle = element.getAttribute("style");
      if (inlineStyle !== null) element.setAttribute("style", await this.#resolveCss(inlineStyle, documentPath));
      if (element.localName === "style" && element.textContent !== null) {
        element.textContent = await this.#resolveCss(element.textContent, documentPath);
      }
    }
    return new XMLSerializer().serializeToString(parsed.documentElement);
  }

  reset(): void {
    for (const url of this.#urls.values()) {
      if (url.startsWith("blob:")) this.objectUrls.revokeObjectURL(url);
    }
    this.#urls.clear();
  }

  dispose(): void {
    this.reset();
  }

  async #resolveReference(reference: string, documentPath: string): Promise<string> {
    const path = deckPath(reference, documentPath);
    if (path === null) return reference;
    const existing = this.#urls.get(path);
    if (existing) return existing;

    const response = await this.deck.fetch(`/api/raw/${path}`);
    if (!response.ok) {
      const unavailable = "data:,";
      this.#urls.set(path, unavailable);
      return unavailable;
    }
    const type = mediaType(path);
    if (type !== undefined) {
      const dataUrl = `data:${type};base64,${base64(new Uint8Array(await response.arrayBuffer()))}`;
      this.#urls.set(path, dataUrl);
      return dataUrl;
    }
    const blob = await response.blob();
    const objectUrl = this.objectUrls.createObjectURL(blob);
    this.#urls.set(path, objectUrl);
    return objectUrl;
  }

  async #resolveCss(css: string, documentPath: string): Promise<string> {
    const matches = Array.from(css.matchAll(CSS_URL));
    let resolved = css;
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      const replacement = await this.#resolveReference(match[2], documentPath);
      const start = match.index ?? 0;
      resolved = `${resolved.slice(0, start)}url("${replacement}")${resolved.slice(start + match[0].length)}`;
    }
    return resolved;
  }
}
