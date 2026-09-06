# 動態是一份有序的效果清單，不是元素身上的屬性

ADR-0005 原本把動態表達成元素身上的屬性（`data-comot-step`、`data-comot-enter`）。屬性設計的部分現在撤銷，改為每張投影片持有一份有序的效果清單，每項指向一個元素。

PowerPoint 與 Keynote 都是這個形狀。PowerPoint 把動畫存在 `<p:timing>`，那是一棵與形狀樹 `<p:spTree>` 完全分開的樹，透過 `<p:spTgt spid="…">` 指向形狀；Keynote 的建構清單同構。兩者的效果都分家族（進場、強調、退場、路徑），媒體的播放與暫停也是清單裡的效果項，不是另一套機制；每項各自帶起始方式（按一下／與前項同時／前項之後）。

屬性設計有一個結構性的天花板：一個元素只能有一個效果。「第 2 步出現、第 5 步強調、第 7 步退場」無法表達，除非在屬性值裡發明一套迷你語法，那比兩個方案都糟。清單另外讓「在中間插入一個效果」變成 splice，而不是把後續元素的編號重編一遍——與 ADR-0003 選擇明確的 `slides` 陣列、ADR-0008 選擇投影片自成一體，是同一條理由的第三次應用。

清單寫在投影片 SVG 的 `<metadata>` 中，使用自訂命名空間的 XML 元素而非內嵌 JSON：整份檔案維持單一語法，讀它的人或 agent 不必在中途切換剖析器，也不必處理 CDATA 與引號逃脫。未知命名空間會被其他向量工具忽略，ADR-0001 的靜態相容性不受影響。

## Consequences

- 「步驟」不再被儲存，而是推導出來的：runtime 依每項的起始方式，把清單切成一組一組，以「按一下」起始的那一組就是一個步驟。
- 每個效果項都指向一個元素，這是模型的不變式。音訊因此也必須掛在一個可見元素上（它同時是未來視覺編輯的選取握把），而不是成為一個不指向元素的特例項。
- 刪除元素時，清單裡指向它的效果項會變成懸空引用，必須一併清除。這是本決定唯一的新失敗模式，由刪除元素的命令負責。
- XML 屬性值皆為字串，未來的 duration、delay 需自行轉型。這是選擇單一語法付出的代價。
- ADR-0005 的其餘決定不受影響：仍然不用 SMIL 與 CSS animation，仍然不用 `<foreignObject>`，影音仍以可見的佔位元素搭 `data-comot-media` 表達。

## 修訂（[E2.T7]：四個家族、時間參數、群組動畫、路徑）

原始版本只落地了 `enter`／`media` 兩個家族，且沒有 `duration`／`delay`。這一輪把 ADR 描述的完整模型補齊：

```xml
<comot:effects xmlns:comot="https://co-motion.dev/ns">
  <comot:effect target="el-a3f2c1" family="enter"    effect="fade"  start="on-click"       duration="0.6" delay="0"/>
  <comot:effect target="el-7b91de" family="emphasis" effect="pulse" start="with-previous"  duration="0.8" delay="0.2"/>
  <comot:effect target="el-2c9f10" family="path"     effect="path"  start="after-previous" duration="1.2" delay="0" d="M 100 200 C 300 100 500 300 700 200"/>
  <comot:effect target="el-group"  family="enter"    effect="zoom"  start="on-click"       duration="0.6" delay="0"/>
</comot:effects>
```

- `family` ∈ `enter`／`emphasis`／`exit`／`path`／`media`（值集固定，見 `@co-motion/core/effects`），`start` 三種全開（`on-click`／`with-previous`／`after-previous`）。
- `duration`／`delay` 為選填屬性，秒為單位；缺席時依家族取預設值（`media` 為 0，其餘 0.6）。合法值是「有限、非負的數字」——格式錯誤或負數一律拋錯，絕不回傳修補後的值。
- `family="path"` 的效果項多一個 `d` 屬性，語法是投影片座標系下的 SVG path data；`d` 出現在其他家族上是合法但未使用的屬性，原樣保留。
- **群組動畫**：一筆效果項的 `target` 可以指向一個群組 `<g>`，而不僅是葉節點元素——這與「多個散落元素各自一筆項目」是同一份 schema 的兩種自然結果，不是額外分支。
- 效果項的清單順序即身分：`co-motion effect` 命令族用 1-based 位置定址（D6），沒有另外發明 id。
- 命名空間常數收斂到 `@co-motion/core/effects` 一處（`https://co-motion.dev/ns`）；`element-clipboard.ts` 先前誤用了 `https://schemas.comotion.app/effects`，導致貼上後的效果在播放時被靜默當成不存在——已修正，現在整個 repo 只有一個命名空間字面值的來源。
- 效果清單第一次有了真正的寫入端（`co-motion effect add/remove/move/set`）；先前只有讀取（`packages/web/src/effects.ts`）與旁路清理（`element delete` 的懸空項清除）。
