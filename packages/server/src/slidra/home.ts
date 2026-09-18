// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves the Node runner's settings root. Deck registry, locks and content
 * are crate-owned and intentionally have no Node API in this module.
 */
export function resolveSlidraHome(): string {
  return process.env.SLIDRA_HOME ?? path.join(homedir(), ".slidra");
}
