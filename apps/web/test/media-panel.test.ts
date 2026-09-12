import { describe, expect, it } from "vitest";
import { embedInsertInput, mediaInsertInput, shouldAutoPlayOnClick } from "../src/shell/dock/panels/media-insert.js";

const CANVAS_1280x720 = { width: 1280, height: 720 };

describe("mediaInsertInput", () => {
  it("image + a real path: kind=image, both href and media are ../<path>", () => {
    expect(mediaInsertInput("image", "assets/photo.png", CANVAS_1280x720)).toEqual({
      kind: "image",
      x: 716.8,
      y: 144,
      width: 460.8,
      height: 432,
      href: "../assets/photo.png",
      media: "../assets/photo.png",
    });
  });

  it("video + a real path: kind=video, only media, no href", () => {
    const result = mediaInsertInput("video", "assets/clip.webm", CANVAS_1280x720);
    expect(result).toEqual({ kind: "video", x: 716.8, y: 144, width: 460.8, height: 432, media: "../assets/clip.webm" });
    expect(result).not.toHaveProperty("href");
  });

  it("audio + a real path: kind=audio, its geometry box differs from image/video (copied from the prototype's MEDIA_BOX)", () => {
    expect(mediaInsertInput("audio", "assets/n.oga", CANVAS_1280x720)).toEqual({
      kind: "audio",
      x: 115.2,
      y: 403.2,
      width: 1049.6,
      height: 158.4,
      media: "../assets/n.oga",
    });
  });

  it("image left as an empty placeholder: falls back to kind=rect with no href/media (image without --href would be invalid)", () => {
    const result = mediaInsertInput("image", null, CANVAS_1280x720);
    expect(result).toEqual({ kind: "rect", x: 716.8, y: 144, width: 460.8, height: 432 });
    expect(result).not.toHaveProperty("href");
    expect(result).not.toHaveProperty("media");
  });

  it("video left as an empty placeholder: keeps kind=video with no media", () => {
    const result = mediaInsertInput("video", null, CANVAS_1280x720);
    expect(result).toEqual({ kind: "video", x: 716.8, y: 144, width: 460.8, height: 432 });
    expect(result).not.toHaveProperty("media");
  });

  it("audio left as an empty placeholder: keeps kind=audio with no media", () => {
    const result = mediaInsertInput("audio", null, CANVAS_1280x720);
    expect(result).toEqual({ kind: "audio", x: 115.2, y: 403.2, width: 1049.6, height: 158.4 });
    expect(result).not.toHaveProperty("media");
  });

  it("the path always gets a ../ prefix (asset import returns a path relative to the deck root, and slides live under slides/)", () => {
    const result = mediaInsertInput("video", "assets/sub/dir/clip.mp4", CANVAS_1280x720);
    expect(result.media).toBe("../assets/sub/dir/clip.mp4");
  });

  it("geometry is a percentage of the current deck's own canvas size, not a hardcoded 1280×720", () => {
    const result = mediaInsertInput("image", "assets/photo.png", { width: 1920, height: 1080 });
    expect(result).toMatchObject({ x: 1075.2, y: 216, width: 691.2, height: 648 });
  });
});

describe("embedInsertInput (YouTube embed)", () => {
  it("uses the same layout as a regular video; media holds the player URL, embed holds the source", () => {
    expect(embedInsertInput({ provider: "youtube", url: "https://www.youtube-nocookie.com/embed/MtKyexX-GQc" }, CANVAS_1280x720)).toEqual({
      ...mediaInsertInput("video", null, CANVAS_1280x720),
      media: "https://www.youtube-nocookie.com/embed/MtKyexX-GQc",
      embed: "youtube",
    });
  });
});

describe("shouldAutoPlayOnClick (auto-adds a \"play on click\" effect after insertion)", () => {
  it("inserting a video/audio with real media should add the effect", () => {
    expect(shouldAutoPlayOnClick(mediaInsertInput("video", "assets/clip.webm", CANVAS_1280x720))).toBe(true);
    expect(shouldAutoPlayOnClick(mediaInsertInput("audio", "assets/n.oga", CANVAS_1280x720))).toBe(true);
  });

  it("a third-party embed should also add it: it has no <video>, but the effect gets translated into the player's own API", () => {
    expect(shouldAutoPlayOnClick(embedInsertInput({ provider: "youtube", url: "https://x/embed/y" }, CANVAS_1280x720))).toBe(true);
  });

  it("an empty placeholder or an image should not add it", () => {
    expect(shouldAutoPlayOnClick(mediaInsertInput("video", null, CANVAS_1280x720))).toBe(false);
    expect(shouldAutoPlayOnClick(mediaInsertInput("image", "assets/photo.png", CANVAS_1280x720))).toBe(false);
  });
});
