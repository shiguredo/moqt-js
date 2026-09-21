# devtools のメッセージ一覧が 1 件追加ごとに全体を再構築する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
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

{未着手}
