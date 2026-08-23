import { describe, expect, it } from "vitest";
import { deriveSteps, parseEffects } from "../src/effects.js";
import type { Effect } from "../src/effects.js";

// The effect list lives in the slide's <metadata> under a custom namespace
// (ADR-0009). Steps are never stored — they are derived from the list
// (ADR-0008).

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

const enterFade = '<comot:effect target="el-a3f2c1" family="enter" effect="fade" start="on-click"/>';
const mediaPlay = '<comot:effect target="el-7b91de" family="media" effect="play" start="on-click"/>';

function effect(target: string, start: Effect["start"]): Effect {
  return { target, family: "enter", effect: "fade", start };
}

describe("parseEffects", () => {
  it("讀出效果清單，順序等同檔案中的出現順序", () => {
    expect(parseEffects(slideWithEffects(`${enterFade}\n${mediaPlay}`))).toEqual([
      { target: "el-a3f2c1", family: "enter", effect: "fade", start: "on-click" },
      { target: "el-7b91de", family: "media", effect: "play", start: "on-click" },
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

  it("效果清單是空的，得到空清單", () => {
    expect(parseEffects(slideWithEffects(""))).toEqual([]);
  });

  it("未實作的家族拋錯，訊息指出是第幾項、target 與該屬性值", () => {
    const svg = slideWithEffects(
      `${enterFade}\n<comot:effect target="el-7b91de" family="exit" effect="fade" start="on-click"/>`,
    );
    expect(() => parseEffects(svg)).toThrow(/第 2 項.*el-7b91de.*family.*exit/);
  });

  it("未實作的效果拋錯", () => {
    const svg = slideWithEffects(
      '<comot:effect target="el-a3f2c1" family="enter" effect="fly-in" start="on-click"/>',
    );
    expect(() => parseEffects(svg)).toThrow(/第 1 項.*el-a3f2c1.*effect.*fly-in/);
  });

  it("未實作的起始方式拋錯", () => {
    const svg = slideWithEffects(
      '<comot:effect target="el-a3f2c1" family="enter" effect="fade" start="with-previous"/>',
    );
    expect(() => parseEffects(svg)).toThrow(/第 1 項.*el-a3f2c1.*start.*with-previous/);
  });

  it("缺少必要屬性拋錯", () => {
    const svg = slideWithEffects('<comot:effect family="enter" effect="fade" start="on-click"/>');
    expect(() => parseEffects(svg)).toThrow(/第 1 項.*target/);
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

  it("錯誤訊息是繁體中文，且不含檔案系統路徑", () => {
    const svg = slideWithEffects(
      '<comot:effect target="el-a3f2c1" family="exit" effect="fade" start="on-click"/>',
    );
    let message = "";
    try {
      parseEffects(svg);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/[一-鿿]/);
    expect(message).not.toMatch(/\//);
  });
});

describe("deriveSteps", () => {
  it("空清單推導出零步", () => {
    expect(deriveSteps([])).toEqual([]);
  });

  it("每個 on-click 開啟一個新步驟，步驟順序等同清單順序", () => {
    const effects = [effect("a", "on-click"), effect("b", "on-click")];
    expect(deriveSteps(effects)).toEqual([{ effects: [effects[0]] }, { effects: [effects[1]] }]);
  });

  it("with-previous 與 after-previous 併入當前步驟", () => {
    const effects = [
      effect("a", "on-click"),
      effect("b", "with-previous"),
      effect("c", "after-previous"),
      effect("d", "on-click"),
    ];
    expect(deriveSteps(effects)).toEqual([
      { effects: [effects[0], effects[1], effects[2]] },
      { effects: [effects[3]] },
    ]);
  });

  it("第一項不是 on-click 時拋錯", () => {
    expect(() => deriveSteps([effect("a", "with-previous")])).toThrow(/第 1 項/);
  });
});
