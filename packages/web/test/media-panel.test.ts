import { describe, expect, it } from "vitest";
import { mediaInsertInput } from "../src/shell/dock/panels/media-insert.js";

const CANVAS_1280x720 = { width: 1280, height: 720 };

describe("mediaInsertInput（[E2.T17] plan §4.2）", () => {
  it("image + 真實路徑：kind=image，href 與 media 都是 ../<path>", () => {
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

  it("video + 真實路徑：kind=video，只有 media，沒有 href", () => {
    const result = mediaInsertInput("video", "assets/clip.webm", CANVAS_1280x720);
    expect(result).toEqual({ kind: "video", x: 716.8, y: 144, width: 460.8, height: 432, media: "../assets/clip.webm" });
    expect(result).not.toHaveProperty("href");
  });

  it("audio + 真實路徑：kind=audio，幾何框與 image/video 不同（抄原型 MEDIA_BOX）", () => {
    expect(mediaInsertInput("audio", "assets/n.oga", CANVAS_1280x720)).toEqual({
      kind: "audio",
      x: 115.2,
      y: 403.2,
      width: 1049.6,
      height: 158.4,
      media: "../assets/n.oga",
    });
  });

  it("image 留空占位：降級成 kind=rect，不帶 href/media（image 這個 kind 沒有 --href 不合法）", () => {
    const result = mediaInsertInput("image", null, CANVAS_1280x720);
    expect(result).toEqual({ kind: "rect", x: 716.8, y: 144, width: 460.8, height: 432 });
    expect(result).not.toHaveProperty("href");
    expect(result).not.toHaveProperty("media");
  });

  it("video 留空占位：保留 kind=video，不帶 media", () => {
    const result = mediaInsertInput("video", null, CANVAS_1280x720);
    expect(result).toEqual({ kind: "video", x: 716.8, y: 144, width: 460.8, height: 432 });
    expect(result).not.toHaveProperty("media");
  });

  it("audio 留空占位：保留 kind=audio，不帶 media", () => {
    const result = mediaInsertInput("audio", null, CANVAS_1280x720);
    expect(result).toEqual({ kind: "audio", x: 115.2, y: 403.2, width: 1049.6, height: 158.4 });
    expect(result).not.toHaveProperty("media");
  });

  it("路徑一律加上 ../ 前綴（asset import 回傳的是簡報根目錄相對路徑，投影片在 slides/ 底下）", () => {
    const result = mediaInsertInput("video", "assets/sub/dir/clip.mp4", CANVAS_1280x720);
    expect(result.media).toBe("../assets/sub/dir/clip.mp4");
  });

  it("幾何是目前簡報自己的 canvas 尺寸的百分比，不是寫死的 1280×720", () => {
    const result = mediaInsertInput("image", "assets/photo.png", { width: 1920, height: 1080 });
    expect(result).toMatchObject({ x: 1075.2, y: 216, width: 691.2, height: 648 });
  });
});
