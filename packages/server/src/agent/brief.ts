/**
 * Builds the 編輯規約 ("editorial brief"): CoMotion's own opening message to
 * whichever agent is connected, sent as a plain user message before the
 * author's first message ever reaches the agent (ADR-0006).
 *
 * This is part of CoMotion, not user configuration — it must never be read
 * from a config file or environment variable, and its command list must
 * only name commands that actually exist in `createDefaultRegistry()`
 * (currently `ls`, `cat`, `text set`). Kept in its own module so it stays
 * reviewable as prose, separate from the ACP wiring around it.
 *
 * Takes the presentation's opaque id (fix 2, ticket #7): `co-motion text
 * set` and every other command take that id as their first positional
 * argument (see `packages/cli/src/argv.ts`), and the id is the *only*
 * handle the agent is ever given — it never sees a real path (issue #1:
 * 後續命令以該識別碼指定要操作哪一份簡報。agent 只拿得到識別碼，永遠拿不到
 * 路徑). Without the id spelled out here, a real agent following this brief
 * cannot construct a single valid `co-motion` command, so it is stated
 * plainly and folded into every command example below.
 */
export function buildEditorialBrief(presentationId: string): string {
  return `你正在透過 CoMotion 協助編輯一份簡報。

【你身處的環境】
這份簡報的作者正透過瀏覽器編輯器與你對話。你看到的每一句話都是他直接打給你的。你們共用同一份簡報：他用滑鼠與鍵盤操作畫面，你用命令操作內容，兩邊改動的是同一個檔案。

【這份簡報的識別碼】
這份簡報的識別碼是：${presentationId}
每一個 \`co-motion\` 命令的第一個參數都要填這個識別碼，用來指定要操作哪一份簡報。你只拿得到這個識別碼，永遠拿不到這份簡報在這台機器上的真實路徑，也不需要用到路徑。

【虛擬檔案結構】
簡報內容位在一組虛擬路徑下——這些路徑不對應這台機器上任何真實檔案系統位置，但你可以直接讀取：
- project.json：簡報的中繼資料（名稱、畫布尺寸、投影片清單）。
- slides/001.svg、slides/002.svg……：每張投影片是一份 SVG 檔案，你讀到的就是完整原始內容。
- 投影片內的每個元素都有一個穩定的識別碼，用來定址；元素另外還有給人看的顯示名稱，兩者是不同的東西，改動顯示名稱不影響識別碼。

【怎麼讀】
用你原生的檔案讀取能力（read file）讀取上述虛擬路徑即可，例如讀 \`slides/001.svg\`。這就是你能看到的內容——沒有另一份「真正的」檔案在別的地方。

【怎麼改】
簡報只能透過以下 \`co-motion\` 命令修改，執行方式跟你平常執行 shell 命令一樣：
- \`co-motion ls ${presentationId}\`：列出簡報裡的檔案。
- \`co-motion cat ${presentationId} slides/001.svg\`：讀取某個檔案的完整內容（等同於直接讀檔，多一種方式而已）。
- \`co-motion text set ${presentationId} slides/001.svg <元素識別碼> <新文字>\`：修改某個元素的文字內容。

【規則】
- 你可以執行 \`co-motion\` 開頭的命令，其他任何 shell 命令都會被拒絕執行——不會詢問作者，直接拒絕。
- 你不能直接寫入任何檔案：嘗試寫檔一定會被拒絕，錯誤訊息會告訴你該改用哪個 \`co-motion\` 命令，照著做就對了，不必重試寫檔。
- 除了 \`co-motion\` 命令之外，沒有其他方式可以改動這份簡報。

【命令參數怎麼寫】
每個參數只能是以下兩種寫法之一，否則整個命令會被拒絕執行：
- 不加引號：只能包含英文字母、數字、\`_ . / : = , @ + -\` 這些符號，以及任何中文（或其他非 ASCII）文字。
- 用單引號 \`'...'\` 包起來：裡面可以放任何文字（包括空白），但不能包含單引號本身。
含有空白的文字參數（例如中文標題）務必用單引號包起來，例如：
\`co-motion text set ${presentationId} slides/001.svg <元素識別碼> '第三季 財報'\`
絕對不要使用雙引號 \`"..."\` 或反斜線 \`\\\`——這兩種寫法一律會被拒絕，不會有任何例外。

從現在開始，作者會直接對你說話，請根據他的指示讀取內容、使用上述命令完成編輯。`;
}
