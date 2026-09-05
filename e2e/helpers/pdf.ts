import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";

/**
 * Test-only PDF reader (NOOP-93 §6.3): page count and per-page rasterized
 * screenshots, via `pdfjs-dist` (a root `devDependency` — production code
 * must never import it, this file included only under `e2e/`).
 *
 * `pdfjs-dist`'s worker needs to load from `http(s)`, not `file://`, so this
 * spins up a tiny throwaway `node:http` server that serves the two built
 * `pdfjs-dist` files plus a page that loads them, feeds it the PDF bytes,
 * and renders each page to a `<canvas>` to screenshot. Every one of these
 * three things was hit and fixed during this ticket's spike, in order:
 * `page.goto("http://localhost/")` with no real server behind it is
 * `ERR_CONNECTION_REFUSED`; `page.goto("file://….pdf")` in headless
 * Chromium becomes a download ("Download is starting"), never a
 * navigable page; `getViewport({ scale: 1 })` on a 1280×720 page reports
 * `[960, 540]` — the CSS-px-to-pt conversion at 96dpi, not a bug.
 */

const pdfjsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules/pdfjs-dist/build",
);

interface PdfServer {
  url: string;
  close: () => Promise<void>;
}

async function startPdfWorkerServer(): Promise<PdfServer> {
  const files: Record<string, { path: string; type: string }> = {
    "/pdf.min.mjs": { path: path.join(pdfjsDir, "pdf.min.mjs"), type: "text/javascript; charset=utf-8" },
    "/pdf.worker.min.mjs": {
      path: path.join(pdfjsDir, "pdf.worker.min.mjs"),
      type: "text/javascript; charset=utf-8",
    },
    "/": { path: "", type: "text/html; charset=utf-8" },
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/") {
      res.writeHead(200, { "Content-Type": files["/"].type });
      res.end("<!doctype html><html><body></body></html>");
      return;
    }
    const entry = files[url];
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }
    readFile(entry.path)
      .then((data) => {
        res.writeHead(200, { "Content-Type": entry.type });
        res.end(data);
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface PdfInfo {
  numPages: number;
  /** CSS-pixel viewport size of each page, in page order — `getViewport({ scale: 1 })`'s width/height, which is a pt measurement (96dpi), not the `page.pdf()` CSS-px size that produced it (§6.3's own note). */
  pageSizes: Array<{ width: number; height: number }>;
  /** Rasterizes page `index` (0-based) to a PNG buffer at the given CSS-pixel scale. */
  rasterizePage: (index: number, scale?: number) => Promise<Buffer>;
  close: () => Promise<void>;
}

/**
 * Loads `pdfBytes` in a real (Playwright-launched) browser page via
 * `pdfjs-dist`, returning page count/sizes and a per-page rasterizer.
 * Callers must `close()` when done (closes the throwaway page and the
 * worker-file HTTP server both).
 */
export async function loadPdf(browser: Browser, pdfBytes: Buffer): Promise<PdfInfo> {
  const workerServer = await startPdfWorkerServer();
  const page = await browser.newPage();
  await page.goto(workerServer.url);

  // A dynamic `import()` *inside* a `page.evaluate()` callback does not
  // work under vitest/vite-node: vite-node rewrites `import()` at the
  // source level into a Node-only `__vite_ssr_dynamic_import__` helper
  // before Playwright ever stringifies the callback to send to the
  // browser, so the rewritten call fails there with a ReferenceError.
  // `page.addScriptTag`'s `content` is a plain string this file builds
  // itself — never passed through a function that vite-node's transform
  // ever sees — so an `import` statement inside it survives untouched;
  // this is what actually loads the ESM build into the page and exposes
  // it as a global for every `evaluate()` call below to read.
  await page.addScriptTag({
    content: `import * as pdfjsLib from "/pdf.min.mjs"; window.__comotPdfjs = pdfjsLib;`,
    type: "module",
  });
  await page.waitForFunction(() => (window as unknown as { __comotPdfjs?: unknown }).__comotPdfjs !== undefined);

  const numPages = await page.evaluate(
    async ({ base64, workerUrl }) => {
      const pdfjsLib = (window as unknown as { __comotPdfjs: any }).__comotPdfjs;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      (window as unknown as { __comotPdfDoc: unknown }).__comotPdfDoc = doc;
      return doc.numPages as number;
    },
    { base64: pdfBytes.toString("base64"), workerUrl: `${workerServer.url}/pdf.worker.min.mjs` },
  );

  const pageSizes: Array<{ width: number; height: number }> = [];
  for (let i = 1; i <= numPages; i++) {
    const size = await page.evaluate(async (pageNumber) => {
      const doc = (window as unknown as { __comotPdfDoc: { getPage: (n: number) => Promise<unknown> } })
        .__comotPdfDoc;
      const pdfPage = (await doc.getPage(pageNumber)) as { getViewport: (opts: { scale: number }) => { width: number; height: number } };
      const viewport = pdfPage.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    }, i);
    pageSizes.push(size);
  }

  return {
    numPages,
    pageSizes,
    rasterizePage: async (index: number, scale = 1): Promise<Buffer> => {
      const pageNumber = index + 1;
      await page.evaluate(
        async ({ pageNumber: n, scale: s }) => {
          const doc = (window as unknown as { __comotPdfDoc: { getPage: (n: number) => Promise<unknown> } })
            .__comotPdfDoc;
          const pdfPage = (await doc.getPage(n)) as {
            getViewport: (opts: { scale: number }) => { width: number; height: number };
            render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
          };
          const viewport = pdfPage.getViewport({ scale: s });
          let canvas = document.getElementById("c") as HTMLCanvasElement | null;
          if (!canvas) {
            canvas = document.createElement("canvas");
            canvas.id = "c";
            document.body.appendChild(canvas);
          }
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d")!;
          await pdfPage.render({ canvasContext: context, viewport: pdfPage.getViewport({ scale: s }) }).promise;
        },
        { pageNumber, scale },
      );
      return page.locator("#c").screenshot();
    },
    close: async () => {
      await page.close();
      await workerServer.close();
    },
  };
}
