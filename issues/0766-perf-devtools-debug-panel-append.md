# moqt-devtools のデバッグパネルの 1 件追記のコストを、表示中の件数に依らなくする

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/perf-devtools-debug-panel-append
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools のデバッグパネルは、ログを 1 件追加するたびに表示中のすべての行を作り直す。Object の送受信は毎秒数十件になるため、上限の 1000 件を表示している間は 1 件追加するたびに 1000 行分のコストがかかり、再生中はログを出し続けられない。追記のコストを表示中の件数に依らなくする。

## 現状

- `devtools/src/components/DebugLogList.tsx` の `DebugLogList` は、`logSequence` の変化で再描画され、`getLogBuffer()` の全件を新しい順に並べて `DebugLogRow` を組み立てる。上限 (`MAX_LOGS` = 1000) まで溜まると、1 件追加するたびに `DebugLogRow` が 1000 回呼ばれる
- 実測 (Chromium、1000 件表示、`preact.options.__r` で描画を数える): 1 件追加で `DebugLogList` 1 回・`DebugLogCount` 1 回・`DebugLogRow` 1000 回。追加から DOM が更新されるまで 4.5 ms (MutationObserver で計測)、別の計測方法では 15.9 ms から 18.4 ms になった (行を `DebugLogRow` へ切り出した分)
- 同じリポジトリの WebTransport のメッセージ一覧は、表示を新しい 200 件に限ることで 1 件追加を 44.8 ms から 3.0 ms にした (`devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`)

## 設計方針

- 行の vnode をログの連番で保持し、展開の状態・表示モード・コピーの表示が変わったときだけ作り直す。Preact は同じ vnode オブジェクトを再び受け取ると、その部分木の差分を省略する (memo と同じ仕組み) ため、追記のコストが表示中の件数に比例しなくなる
- 上限で捨てたログの vnode はキャッシュから落とす (連番は増え続けるため、残すと長いセッションで増え続ける)。`devtools/src/utils/logRowState.ts` の枝刈りと同じ考え方を使う
- 上限 (`MAX_LOGS`) と表示の内容 (新しい順、展開、Binary タブ、Expand All / Collapse All、オートスクロール、Clear) は変えない
- 展開やコピーの操作をしたときは行を作り直してよい (利用者の操作 1 回につき 1 度)

## 完了条件

- 1000 件表示で 1 件追加したときに `DebugLogRow` が 1 回以下しか描画されない (E2E で固定する)
- 1 件追加の所要時間が表示中の件数に比例しない (1000 件表示と 100 件表示で比べる)
- 画面の表示と操作 (新しい順、展開、折りたたみ、Binary タブ、Expand All / Collapse All、オートスクロール、Clear、上限で捨てたログの状態) が変わらない
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` / `vp run e2e-test` が通る

## 参照

- `devtools/src/components/DebugLogList.tsx` の `DebugLogList` (行の組み立て)
- `devtools/src/components/DebugLogRow.tsx` の `DebugLogRow`
- `devtools/src/utils/logRowState.ts` の `pruneLogIds` / `pruneViewModes`
- `devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`
- `tests/e2e/devtools-debug-panel.spec.ts` (表示と操作の E2E)
- `tests/e2e/devtools-rerender-scope.spec.ts` (描画回数の数え方)
