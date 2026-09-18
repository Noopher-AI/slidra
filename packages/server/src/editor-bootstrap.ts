// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

export const EDITOR_BOOTSTRAP_MARKER =
  `<script id="slidra-bootstrap" type="application/json">__SLIDRA_BOOTSTRAP__</script>`;

export interface EditorBootstrap {
  workbenchId: string | null;
  deck: { url: string; credential: string };
  agentRunner: { url: string; sessionToken: string };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Builds the one credential-bearing editor response. The static service only serves the returned opaque bytes. */
export function injectEditorBootstrap(template: Uint8Array, bootstrap: EditorBootstrap): Uint8Array {
  const source = new TextDecoder().decode(template);
  const pieces = source.split(EDITOR_BOOTSTRAP_MARKER);
  if (pieces.length !== 2) throw new Error("Editor template must contain exactly one bootstrap marker");
  const node = `<script id="slidra-bootstrap" type="application/json">${safeJson(bootstrap)}</script>`;
  return new TextEncoder().encode(`${pieces[0]}${node}${pieces[1]}`);
}
