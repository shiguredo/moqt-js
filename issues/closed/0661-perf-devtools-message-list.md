# devtools のメッセージ一覧が 1 件追加ごとに全体を再構築する

- Created: 2026-09-21
- Completed: 2026-09-26
- Branch: feature/refactor-devtools-message-list
- Polished: {YYYY-MM-DD}

## 目的

devtools のストリーム詳細はメッセージを 1 件受信するたびに配列を作り直し、表示側は全行の日時を整形し直す。表示件数が多いほど 1 件追加のコストが増えるため、長時間の接続で操作性が落ちる。一覧に上限が無いため、そのコストは増え続ける。加えてデバッグログ側は配列添字を key にしているため、1 件追加すると展開状態が別の行へ移る。

## 現状

- `devtools/src/webtransport-devtools/signals.ts` は `messages: [...s.messages, msg]` で毎回新しい配列を作る (双方向 / 単方向の各ストリーム)
- `messages` に上限が無く、`StreamMessage` は整形済みの日時を持たない
- `devtools/src/webtransport-devtools/components/MessageItem.tsx` は表示のたびに `formatTimestamp(msg.timestamp)` を呼び、`formatTimestamp` は `toLocaleTimeString("ja-JP", { fractionalSecondDigits: 3 })` を呼ぶ
- 測定 (Apple M4 Pro / Node.js v26.4.0、`formatTimestamp` と同じ引数): 1 回 19.4 µs。1000 件のリストでは 1 件追加あたり約 19 ms を日時整形だけで使う
- `devtools/src/components/DebugPanel.tsx` は `logBuffer.shift()` で先頭を落とすリングバッファ (`MAX_LOGS`) に対し、`key={originalIndex}` と添字の `Set` (`expandedRows`) で展開状態を持つ。1 件追加すると全行の添字がずれ、展開状態が別の行へ移る

## 設計方針

- 追記コストを件数に比例させない。上限付きリングバッファにし、`shift()` ではなく読み出し位置または連番 ID で最古を扱う
- 表示の key は配列添字ではなくメッセージごとの連番 ID にし、展開状態もその ID で持つ
- 日時の整形結果は追加時に 1 回だけ計算して保持し、再描画では再計算しない
- `MessageItem` は整形済みの値だけを受け取る形にする

## 完了条件

- メッセージ追加のコストが既存件数に比例しない
- 1 件追加しても展開状態が同じ行に残る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0632 (devtools のコンポーネントテスト基盤。再描画の検証はこの基盤に載せる)

## 解決方法

- `devtools/src/webtransport-devtools/messageLog.ts` を足し、ストリームとデータグラムで共有するメッセージ一覧を連番 ID の追記型にした
  - `StreamMessage` に、一覧をまたいで一意な連番の `id` と、追加時に 1 回だけ整形した `formattedTimestamp` を持たせた
  - 一覧の配列は signal にせず破壊的に追記し、追加とクリアは `messagesVersion` の連番で伝える。表示側は連番を読んだ項目だけを再描画する
  - 保持するのは新しい `MAX_STREAM_MESSAGES` (200) 件までにした。最古の破棄は上限 200 件の配列への `shift()` 1 回で、1 件追加のコストは接続時間に依らず一定になる (読み出し位置を持つリングバッファにはしていない)
- `devtools/src/webtransport-devtools/signals.ts` の `bidiStreams` / `uniSendStreams` / `uniRecvStreams` は一覧を `MessageLogFields` として持ち、データグラムも配列と `datagramMessagesVersion` の組にした。1 件受信するたびに `messages: [...s.messages, msg]` で一覧とストリーム一覧を作り直す経路を無くした
- `BidiStreamPanel` / `UniSendStreamPanel` / `UniRecvStreamPanel` / `DatagramPanel` は `messagesVersion` を読み、メッセージが増えたときはそのパネルだけを再描画する。表示の key は配列の添字ではなく `msg.id` にした
- `MessageItem` は `formattedTimestamp` をそのまま表示し、描画のたびに `formatTimestamp` を呼ばない
- `devtools/src/components/DebugPanel.tsx` は `LogEntry` に連番の `id` を足し、表示の key と展開状態 (`expandedRows`)・表示モード (`viewModes`) を配列の添字ではなく id で持つようにした。`addLog` は `logIdCounter` を進める
- テスト: `devtools/src/webtransport-devtools/messageLog.test.ts` に 5 件 (連番と整形済みの日時、一覧をまたいだ連番の一意性、上限 200 件で最古を捨てる、配列を作り直さず連番で伝える、クリアで空にする)、`devtools/src/components/DebugPanel.test.ts` に上限到達後も連番が重複しないことを固定する 1 件を足した。展開状態が同じ行に残ること自体は、key と状態の識別に使う連番が重複しないことで担保する (行を操作する描画テストは足していない)
- 実測 (1000 件表示): 1 件追記が 44.8 ms から 3.0 ms になった (上限 200 件では 1.2 ms)。パネル本体の再描画は 0 回になる。日時は追加時に 1 回だけ整形する
- `npx vp check` / `npx vp test --run` (161 ファイル / 2986 テスト) が通った
- 残り: DebugPanel のログ追加 (17.5〜19.2 ms) と webcodecs-devtools の FrameLogPanel の日時整形は今回の対象外
