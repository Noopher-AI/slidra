// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import path from "node:path";
import { loadProject } from "../read-routes.js";
import { startExportServer } from "./server.js";
import { renderExportPdf } from "./render.js";
import { exportFileName } from "./output-name.js";
import type { ExportFormat } from "./job.js";

/**
 * Entry point for `slidra export <presentation-id> --format pdf|pdf-frames
 * [--out <path>] [--port <n>]` (NOOP-93 §4.3).
 *
 * Invoked from `packages/server/bin/slidra-node.js` via the same
 * runtime-only dynamic import `serve` uses, after the Rust binary
 * dispatches the `export` entry point.
 */
export async function runExportCli(argv: string[]): Promise<number> {
  const parsed = parseExportArgv(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 1;
  }
  const { presentationId, format, outPath, port } = parsed.value;

  let project;
  try {
    project = await loadProject(presentationId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (project.slides.length === 0) {
    console.error("Presentation has no slides");
    return 1;
  }

  const outputPath = outPath
    ? path.resolve(outPath)
    : path.resolve(process.cwd(), exportFileName(project.name, format));

  const server = await startExportServer({ presentationId, port });
  try {
    const result = await renderExportPdf({
      serverUrl: server.url,
      format,
      outputPath,
      onRunning: (totalFrames) => {
        console.log(`Export started: ${format}, ${totalFrames} frames total`);
      },
      onProgress: (completedFrames, totalFrames) => {
        console.log(`Progress: ${completedFrames}/${totalFrames}`);
      },
    });
    console.log(`Exported: ${outputPath} (${result.pageCount} pages)`);
    return 0;
  } catch (error) {
    // renderExportPdf never writes anything to outputPath until page.pdf()
    // itself has already succeeded (writePdfAtomically's temp-file+rename),
    // so a failure at any point before that — including every case this
    // catch handles — leaves no partial file at outputPath to clean up.
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await server.close();
  }
}

interface ParsedExportArgv {
  presentationId: string;
  format: ExportFormat;
  outPath?: string;
  port?: number;
}

type ParseResult = { ok: true; value: ParsedExportArgv } | { ok: false; message: string };

function isFlagLike(value: string): boolean {
  return value.startsWith("--");
}

/**
 * Hand-written, not `packages/cli/src/argv.ts`'s `parseArgv` (§3.6's own
 * instruction) — this command lives outside that registry entirely, and
 * pulling in an argv library for four flags is not worth the dependency.
 */
function parseExportArgv(argv: string[]): ParseResult {
  let presentationId: string | undefined;
  let format: string | undefined;
  let outPath: string | undefined;
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format") {
      const value = argv[i + 1];
      if (value === undefined || isFlagLike(value)) return { ok: false, message: "--format is missing a value" };
      format = value;
      i++;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || isFlagLike(value)) return { ok: false, message: "--out is missing a value" };
      outPath = value;
      i++;
    } else if (arg === "--port") {
      const value = argv[i + 1];
      const parsedPort = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsedPort)) return { ok: false, message: "--port is missing a valid number" };
      port = parsedPort;
      i++;
    } else if (presentationId === undefined && !isFlagLike(arg)) {
      presentationId = arg;
    }
  }

  if (!presentationId) return { ok: false, message: "Command export is missing an argument: presentation-id" };
  if (!format) return { ok: false, message: "Command export is missing an argument: --format" };
  // Case-sensitive, on purpose (§4.3's table): "PDF", "Pdf", etc. are
  // rejected outright rather than normalized — a typo should be reported,
  // not silently repaired.
  if (format !== "pdf" && format !== "pdf-frames") {
    return { ok: false, message: "--format must be one of: pdf, pdf-frames" };
  }
  return { ok: true, value: { presentationId, format, outPath, port } };
}
