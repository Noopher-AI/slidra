import { randomBytes } from "node:crypto";

/**
 * Generates a 12-character opaque identifier from a cryptographic random
 * source. The id carries no encoded meaning (ADR-0004) — it must never be
 * decodable into a path or a semantic hint.
 *
 * 9 random bytes base64url-encode to exactly 12 characters.
 */
export function generateOpaqueId(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Generates an element id, which follows the same opaque-id rule but is
 * prefixed with `el-` so it is recognizable as an element reference.
 */
export function generateElementId(): string {
  return `el-${generateOpaqueId()}`;
}
