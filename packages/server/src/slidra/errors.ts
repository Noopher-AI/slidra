// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * `packages/server`'s own copy of `packages/core`'s error hierarchy
 * ([E4.T9]/F7 — the server no longer imports `packages/core` at all).
 * Identical class hierarchy to `packages/core/src/errors.ts`; see that
 * module for the reasoning behind the `SlidraNotFoundError`/
 * `SlidraInvalidRequestError` split.
 */
export class SlidraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlidraError";
  }
}

export class SlidraNotFoundError extends SlidraError {
  constructor(message: string) {
    super(message);
    this.name = "SlidraNotFoundError";
  }
}

export class SlidraInvalidRequestError extends SlidraError {
  constructor(message: string) {
    super(message);
    this.name = "SlidraInvalidRequestError";
  }
}
