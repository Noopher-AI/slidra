import { describe, expect, it } from "vitest";
import { pasteElements } from "@co-motion/core";
import { parseEffects } from "../src/effects.js";

// The effect list lives in the slide's <metadata> under a custom namespace
// (ADR-0009). [E2.T7] moved the value-set/attribute validation and
// deriveSteps into @co-motion/core/effects (D1) — this file keeps only what
// is genuinely specific to the DOMParser-based web reader: namespace-URI
// matching regardless of prefix, and the two error paths only a real DOM
// can produce (XML parse failure, target-lookup via `doc.getElementById`).
// See packages/core/test/effects.test.ts for the value-set/attribute tests
// this file used to carry — same inputs, moved wholesale (plan §6.2).

const NS = 'xmlns:comot="https://co-motion.dev/ns"';

/** A slide carrying the given <comot:effect .../> lines, plus two elements. */
function slideWithEffects(effectLines: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      ${effectLines}
    </comot:effects>
  </metadata>
  <rect id="el-a3f2c1"/>
  <image id="el-7b91de"/>
</svg>`;
}

const enterFade = '<comot:effect target="el-a3f2c1" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>';
const mediaPlay = '<comot:effect target="el-7b91de" family="media" effect="play" start="on-click" duration="0" delay="0"/>';

describe("parseEffects", () => {
  it("讀出效果清單，順序等同檔案中的出現順序", () => {
    expect(parseEffects(slideWithEffects(`${enterFade}\n${mediaPlay}`))).toEqual([
      { target: "el-a3f2c1", family: "enter", effect: "fade", start: "on-click", duration: 0.6, delay: 0, index: 0 },
      { target: "el-7b91de", family: "media", effect: "play", start: "on-click", duration: 0, delay: 0, index: 1 },
    ]);
  });

  it("接受 enter/appear", () => {
    const svg = slideWithEffects(
      '<comot:effect target="el-a3f2c1" family="enter" effect="appear" start="on-click"/>',
    );
    expect(parseEffects(svg)[0].effect).toBe("appear");
  });

  it("以命名空間 URI 比對，不管前綴叫什麼", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <x:effects xmlns:x="https://co-motion.dev/ns">
      <x:effect target="el-a3f2c1" family="enter" effect="fade" start="on-click"/>
    </x:effects>
  </metadata>
  <rect id="el-a3f2c1"/>
</svg>`;
    expect(parseEffects(svg)).toHaveLength(1);
  });

  it("沒有 <metadata> 的投影片是合法的，得到空清單", () => {
    expect(parseEffects('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-a3f2c1"/></svg>')).toEqual([]);
  });

  it("有 <metadata> 但沒有效果清單，得到空清單", () => {
    expect(
      parseEffects('<svg xmlns="http://www.w3.org/2000/svg"><metadata><title>x</title></metadata></svg>'),
    ).toEqual([]);
  });

  it("<metadata> 之外的效果清單不被採用", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <comot:effects ${NS}>
    ${enterFade}
  </comot:effects>
  <rect id="el-a3f2c1"/>
</svg>`;
    expect(parseEffects(svg)).toEqual([]);
  });

  it("<metadata> 內出現兩組效果清單時拋錯", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>${enterFade}</comot:effects>
    <comot:effects ${NS}>${mediaPlay}</comot:effects>
  </metadata>
  <rect id="el-a3f2c1"/>
  <image id="el-7b91de"/>
</svg>`;
    expect(() => parseEffects(svg)).toThrow(/2 組.*只能有一份效果清單/);
  });

  it("效果清單是空的，得到空清單", () => {
    expect(parseEffects(slideWithEffects(""))).toEqual([]);
  });

  // [E2.T7]/D4: web's own delegation-to-core test — "exit" is now a real,
  // implemented family, so the fixture moved to "build" (this round's
  // stand-in for "a family nothing implements yet", same role "exit" used
  // to play). This is the one web-reader test kept from the pre-[E2.T7]
  // "未實作的家族拋錯" case: it proves the web reader actually delegates to
  // core's validateEffectItem rather than carrying its own copy of the
  // value set forward.
  it("未實作的家族拋錯，訊息指出是第幾項、target 與該屬性值", () => {
    const svg = slideWithEffects(
      `${enterFade}\n<comot:effect target="el-7b91de" family="build" effect="fade" start="on-click"/>`,
    );
    expect(() => parseEffects(svg)).toThrow(/第 2 項.*el-7b91de.*family.*build/);
  });

  it("target 指向不存在的元素時拋錯，不略過該項", () => {
    const svg = slideWithEffects(
      `${enterFade}\n<comot:effect target="el-nope" family="enter" effect="fade" start="on-click"/>`,
    );
    expect(() => parseEffects(svg)).toThrow(/第 2 項.*el-nope/);
  });

  it("SVG 不是合法 XML 時拋錯", () => {
    expect(() => parseEffects("<svg><rect></svg>")).toThrow(/XML/);
  });

  // [E2.T7]/D2, A8: element-clipboard.ts's `appendEffects` used to write
  // the wrong namespace (`https://schemas.comotion.app/effects`), so a
  // paste onto a slide with no prior effect list produced a
  // `<comot:effects>` the web reader's namespace-URI match silently
  // treated as empty — pasted effects vanished with no error. This is the
  // regression test for that fix, exercising the real cross-package path:
  // core's pasteElements() writes, this file's own parseEffects() reads.
  it("D2 round-trip：貼上到一張沒有效果清單的投影片後，parseEffects 讀得到那些效果（命名空間修正）", () => {
    // A payload shaped like extractElementsForCopy's own output — this test
    // only needs pasteElements' write side, so it is built by hand rather
    // than round-tripped through a copy first.
    const payload = {
      sourceSlidePath: "slides/001.svg",
      elements: ['<g id="el-src"><rect width="10" height="10"/></g>'],
      effects: ['<comot:effect target="el-src" family="enter" effect="fade" start="on-click"/>'],
    };
    const target = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';

    let nextId = 0;
    const { updated } = pasteElements(target, "slides/002.svg", payload, 0, 0, () => `el-pasted-${nextId++}`);

    const effects = parseEffects(updated);
    expect(effects.length).toBeGreaterThan(0);
    expect(effects[0].target).toBe("el-pasted-0");
  });
});
