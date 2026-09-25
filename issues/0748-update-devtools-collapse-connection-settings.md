# moqt-devtools の Connection Settings を閉じられず、Publisher と Subscriber のパネルが画面の下に押し出される

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-collapse-connection-settings
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の Connection Settings は、接続先、トラック、映像、音声、配信、購読、WebCodecs、Authorization Token の設定を常に広げて描く。設定を決めた後も画面の上の大部分を占め、Publisher と Subscriber のパネルを見るたびにスクロールが要る。利用者から「Connection Settings も閉じれるようにして欲しい」と要望があった。統計の欄 (closed の `0733`) と同じく、開け閉めできるようにする。

## 現状

- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` は、見出し (`h2`、アイコン、「Connection Settings」、`HttpVersionBadge`、MOQT / LOC / MSF / C4M のヘルプのボタン) の下に、8 つの設定の節を常に描く
- 統計の欄は `devtools/src/components/StatsView.tsx` の `StatsCollapse` で開け閉めする (既定は閉じる。`aria-expanded` と `aria-controls` を持つボタン、開閉の印は ▾ / ▸)

## 設計方針

使いやすさを優先する (利用者と決めた)。

- 見出しの行 (アイコン、「Connection Settings」、`HttpVersionBadge`) を開け閉めのボタンにし、行いっぱいを押せるようにする。MOQT / LOC / MSF / C4M のヘルプのボタンは、閉じている間も見出しに残し、押しても開け閉めしない
- `StatsCollapse` と同じく `aria-expanded` / `aria-controls` と ▾ / ▸ の印を付ける
- 既定は開く (今と同じ見た目で始まる)。開け閉めの状態はブラウザ (localStorage) に覚え、再読み込みしても同じ状態で始める。localStorage が使えないとき (プライベートウィンドウ、保存の拒否など) は既定の開いた状態で始め、覚えられなくても開け閉めはできる
- 閉じている間は、接続先 (Server URL)、Namespace、Track Name、映像 (入力、codec、解像度、fps)、音声 (入力、codec) の要約を 1 行で出す。はみ出す分は省き、全文はマウスを重ねると出る。要約の行を押しても開く
- 閉じている間は設定の節を隠す (`hidden`)。入力は signal に結び付いているため、隠しても設定の値は変わらない

## 完了条件

- 見出しの行を押すと設定の節が隠れて要約の 1 行になり、見出しの行か要約の行を押すと元に戻る。既定は開いている
- 閉じた状態で再読み込みすると、閉じたまま始まる
- 覚えた値の読み方 (覚えていない、読めない値、localStorage が使えない) を単体テストで固定する
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
