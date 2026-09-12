import path from "node:path";
import { loadProject } from "../read-routes.js";
import { startExportServer } from "./server.js";
import { renderExportPdf } from "./render.js";
import { exportFileName } from "./output-name.js";
import type { ExportFormat } from "./job.js";

/**
 * Entry point for `comotion export <presentation-id> --format pdf|pdf-frames
 * [--out <path>] [--port <n>]` (NOOP-93 §4.3).
 *
 * Invoked from `packages/cli/bin/comotion.js` via the same runtime-only
 * dynamic import `serve` already uses. [E4.T9]/F7: `@comotion/server` no
 * longer depends on `packages/cli`'s in-process registry at all.
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
    console.error("簡報沒有投影片");
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
        console.log(`匯出開始：${format}，共 ${totalFrames} 格`);
      },
      onProgress: (completedFrames, totalFrames) => {
        console.log(`進度：${completedFrames}/${totalFrames}`);
      },
    });
    console.log(`已匯出：${outputPath}（${result.pageCount} 頁）`);
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
      if (value === undefined || isFlagLike(value)) return { ok: false, message: "--format 缺少值" };
      format = value;
      i++;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || isFlagLike(value)) return { ok: false, message: "--out 缺少值" };
      outPath = value;
      i++;
    } else if (arg === "--port") {
      const value = argv[i + 1];
      const parsedPort = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsedPort)) return { ok: false, message: "--port 缺少有效的數值" };
      port = parsedPort;
      i++;
    } else if (presentationId === undefined && !isFlagLike(arg)) {
      presentationId = arg;
    }
  }

  if (!presentationId) return { ok: false, message: "命令 export 缺少參數：presentation-id" };
  if (!format) return { ok: false, message: "命令 export 缺少參數：--format" };
  // Case-sensitive, on purpose (§4.3's table): "PDF", "Pdf", etc. are
  // rejected outright rather than normalized — a typo should be reported,
  // not silently repaired.
  if (format !== "pdf" && format !== "pdf-frames") {
    return { ok: false, message: "--format 必須是下列其中一個值：pdf、pdf-frames" };
  }
  return { ok: true, value: { presentationId, format, outPath, port } };
}
