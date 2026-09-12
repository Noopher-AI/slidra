/**
 * Builds the "editorial brief" (編輯規約): CoMotion's own opening message to
 * whichever agent is connected, sent as a plain user message before the
 * author's first message ever reaches the agent (ADR-0006).
 *
 * This is part of CoMotion, not user configuration — it must never be read
 * from a config file or environment variable. Kept in its own module so it
 * stays reviewable as prose, separate from the ACP wiring around it.
 *
 * Slimmed down to only what changes per conversation — the identifier and
 * this comment-prefix note — plus a pointer to the work directory's own
 * `reference/commands.md` for the command catalogue itself: that document
 * lives in a real file the agent reads with its native file access, not in
 * a string rebuilt on every turn, and it is the one place with room to
 * list every command's parameters, not just a handful as illustrative
 * syntax. `text set` and `comment list` stay named here, verbatim, purely
 * as the two worked examples for the "how to write command parameters"
 * section's quoting rules — `commands-reference.test.ts` asserts this
 * brief names only those two commands, so a change here that adds a third
 * command name fails loudly rather than silently drifting the brief and
 * the reference apart again.
 *
 * Takes the presentation's opaque id — the id is the *only* handle the
 * agent is ever given, it never sees a real path — folded into
 * `識別碼是：${presentationId}` in a fixed shape `chat.test.ts` extracts
 * with a regex, and into the two worked command examples below.
 */
export function buildEditorialBrief(presentationId: string): string {
  return `你正在透過 CoMotion 協助編輯一份簡報。

【你身處的環境】
這份簡報的作者正透過瀏覽器編輯器與你對話。你看到的每一句話都是他直接打給你的。你們共用同一份簡報：他用滑鼠與鍵盤操作畫面，你用命令操作內容，兩邊改動的是同一個檔案。

【這份簡報的識別碼】
這份簡報的識別碼是：${presentationId}
每一個 \`comotion\` 命令的第一個參數都要填這個識別碼，用來指定要操作哪一份簡報。你只拿得到這個識別碼，永遠拿不到這份簡報在這台機器上的真實路徑，也不需要用到路徑。

【怎麼讀、怎麼改】
完整的命令清單（每個命令的名稱、參數、用途）在你工作目錄的 \`reference/commands.md\`——用你原生的檔案讀取能力讀取那份文件，不要只憑下面兩個例子猜其他命令的語法。這份簡報本身的內容也是一組可以直接讀取的虛擬路徑（例如 \`slides/001.svg\`），你的工作目錄的 \`AGENTS.md\` 有更完整的說明。

【規則】
- 這份簡報的內容只能透過 \`comotion\` 命令讀寫。直接拿 shell 的檔案工具（\`sed\`、\`cp\`、\`rm\` 之類）去動簡報的實體檔案會被擋下——不會詢問作者，直接擋下，而且你本來就拿不到那些路徑。
- 除此之外的 shell 命令不受限制：跟簡報檔案無關的事情（查資料、處理暫存檔、跑別的工具）照你平常的方式做就好。
- 你不能用寫檔工具寫入簡報的虛擬路徑：嘗試寫檔一定會被拒絕，錯誤訊息會告訴你該改用哪個 \`comotion\` 命令，照著做就對了，不必重試寫檔。
- 被擋下時你收到的訊息可能長得像「使用者拒絕了這次工具使用」，那不是作者按的——CoMotion 會另外告訴你該改用什麼命令，照著改就好，不要問作者為什麼拒絕。

【命令參數怎麼寫】
含有空白的文字參數（例如中文標題）要用引號包起來，例如：
\`comotion text set ${presentationId} slides/001.svg <元素識別碼> '第三季 財報'\`
另一個例子，列出某張投影片的留言：\`comotion comment list ${presentationId} slides/001.svg\`
單引號 \`'...'\` 最不容易出錯（裡面不會有任何代換），文字本身含有半形單引號時才改用雙引號。

從現在開始，作者會直接對你說話，請根據他的指示讀取內容、使用上述命令完成編輯。`;
}
