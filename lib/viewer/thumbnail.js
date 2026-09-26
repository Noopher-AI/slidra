// Slide thumbnails as small PNGs. A slide's prepared markup (assets already
// inlined) is drawn as an SVG *image* — an image runs no script and loads
// nothing from the network — onto a canvas, and only the PNG is kept, so an
// overview of a large deck holds kilobytes per slide instead of a frame with
// every asset inlined.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The slide as a standalone SVG document with the deck's fonts, for drawing
 * as an image. Returns null when the markup cannot be parsed.
 */
export function thumbnailSvg(markup, fontCss) {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") return null;
  if (fontCss) {
    const style = doc.createElementNS(SVG_NS, "style");
    style.textContent = fontCss;
    root.insertBefore(style, root.firstChild);
  }
  // An image has no viewport of its own: give it the canvas size explicitly.
  const [, , width, height] = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (width > 0 && height > 0) {
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
  }
  return new XMLSerializer().serializeToString(root);
}

/**
 * Renders a thumbnail and resolves to an object URL of a PNG `width` pixels
 * wide (the caller revokes it). Falls back to the SVG itself when the
 * canvas cannot be read back.
 * @param {string} markup prepared slide markup
 * @param {string} fontCss @font-face rules (fontFaceCss)
 * @param {{ width: number, height: number }} canvasSize the deck's canvas
 * @param {number} [width] thumbnail width in pixels
 * @returns {Promise<string>}
 */
export async function renderThumbnail(markup, fontCss, canvasSize, width = 480) {
  const svg = thumbnailSvg(markup, fontCss);
  if (!svg) throw new Error("the slide cannot be drawn");
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = svgUrl;
    await image.decode();
    const height = Math.max(1, Math.round((width * canvasSize.height) / canvasSize.width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("no PNG");
    URL.revokeObjectURL(svgUrl);
    return URL.createObjectURL(png);
  } catch (error) {
    // A browser that taints the canvas still shows the SVG image itself.
    if (error instanceof DOMException && error.name === "SecurityError") return svgUrl;
    URL.revokeObjectURL(svgUrl);
    throw error;
  }
}
