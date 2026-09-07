import { describe, expect, it } from "vitest";
import { embedPlayerSrc, embedUrlFor, requireEmbedProvider, youtubeVideoId } from "../src/embed.js";

describe("youtubeVideoId — 認得出 YouTube 連結的每一種寫法", () => {
  it.each([
    ["https://www.youtube.com/watch?v=MtKyexX-GQc", "MtKyexX-GQc"],
    ["https://youtube.com/watch?v=MtKyexX-GQc&t=42s", "MtKyexX-GQc"],
    ["https://m.youtube.com/watch?v=MtKyexX-GQc", "MtKyexX-GQc"],
    ["https://youtu.be/MtKyexX-GQc", "MtKyexX-GQc"],
    ["https://www.youtube.com/embed/MtKyexX-GQc", "MtKyexX-GQc"],
    ["https://www.youtube-nocookie.com/embed/MtKyexX-GQc", "MtKyexX-GQc"],
    ["https://www.youtube.com/shorts/MtKyexX-GQc", "MtKyexX-GQc"],
    ["https://www.youtube.com/live/MtKyexX-GQc", "MtKyexX-GQc"],
  ])("%s → %s", (url, expected) => {
    expect(youtubeVideoId(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/clip.webm", "一般媒體網址"],
    ["https://www.youtube.com/results?search_query=x", "搜尋頁沒有影片 id"],
    ["https://www.youtube.com/watch?v=tooshort", "id 長度不對"],
    ["https://notyoutube.com/watch?v=MtKyexX-GQc", "網域不是 YouTube"],
    ["ftp://youtu.be/MtKyexX-GQc", "不是 http(s)"],
    ["這不是網址", "無法解析成 URL"],
  ])("%s → null（%s）", (url) => {
    expect(youtubeVideoId(url)).toBeNull();
  });
});

describe("embedUrlFor", () => {
  it("把任何一種 YouTube 連結正規化成 nocookie 的 embed 網址", () => {
    expect(embedUrlFor("https://youtu.be/MtKyexX-GQc?t=10")).toEqual({
      provider: "youtube",
      url: "https://www.youtube-nocookie.com/embed/MtKyexX-GQc",
    });
  });

  it("一般媒體網址回傳 null，讓呼叫端走原本的下載路徑", () => {
    expect(embedUrlFor("https://example.com/clip.webm")).toBeNull();
  });
});

describe("requireEmbedProvider", () => {
  it("認得 youtube", () => {
    expect(requireEmbedProvider("youtube")).toBe("youtube");
  });

  it("未知的來源明確報錯，不是靜默略過", () => {
    expect(() => requireEmbedProvider("vimeo")).toThrow(/不支援的嵌入來源：vimeo/);
  });
});

describe("embedPlayerSrc — 讓 media 效果驅動嵌入的播放器", () => {
  it("載入用的 src 補上 enablejsapi，但存進檔案的網址維持乾淨", () => {
    expect(embedPlayerSrc("youtube", "https://www.youtube-nocookie.com/embed/MtKyexX-GQc")).toBe(
      "https://www.youtube-nocookie.com/embed/MtKyexX-GQc?enablejsapi=1",
    );
  });

  it("網址已經有查詢字串時用 & 接續", () => {
    expect(embedPlayerSrc("youtube", "https://x/embed/y?start=10")).toBe("https://x/embed/y?start=10&enablejsapi=1");
  });
});
