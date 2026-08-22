# CLI 是唯一的操作語彙，`co-motion serve` 是它的常駐模式

CoMotion 要同時服務兩種編輯者：透過視覺編輯器操作的人，與透過 shell 操作的 agent。若兩者各有一套介面，能力會漂移，人與 agent 就無法真正在同一份簡報上協作。

因此所有能對簡報做的操作都由 CLI 命令定義，前端不得擁有 CLI 沒有的操作。Web 編輯器不是獨立的後端，而是 CLI 的一個子命令 `co-motion serve`——它與 one-shot 命令共用同一份 dispatch，所以「前端只能做 CLI 做得到的事」是結構保證，不是人為紀律。

## Considered Options

- **Server fork subprocess 呼叫 CLI**：最誠實，但每條命令要付 100–300ms 的 process 啟動成本，拖曳編輯不可用。
- **Server in-process 呼叫共用核心，靠測試保證對應**：夠快，但把不變式從結構降級成紀律，會漂移。

## Consequences

- 前端的拖曳是本地即時預覽，放開滑鼠才送出一條命令。一次操作＝一條命令＝一步 undo。
- 命令集合本身就是 CoMotion 的產品規格，新增命令等於新增使用者能力，應慎重設計。
- 命令必須是語意化的（`text set`、`element move`），不能是通用的低階屬性操作——否則 agent 得先精通 SVG 才能下命令，違背產品前提。
