# moqt-devtools のデバッグパネルで、ログを 1 件追加したときに描画される行を 1 件だけにする

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/perf-devtools-debug-panel-append
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools のデバッグパネルは、ログを 1 件追加するたびに表示中のすべての行を作り直す。Object の送受信は毎秒数十件になるため、上限の 1000 件を表示している間は 1 件追加するたびに 1000 行分のコストがかかり、再生中はログを出し続けられない。まず 1 件追加で描画される行を 1 件だけにし、追記のコストを下げる。表示中の件数に比例して残る分 (Preact が表示中の子を走査する分) は別 issue (0767) で扱う。

## 現状

- `devtools/src/components/DebugLogList.tsx` の `DebugLogList` は、`logSequence` の変化で再描画され、`getLogBuffer()` の全件を新しい順に並べて `DebugLogRow` を組み立てる。上限 (`MAX_LOGS` = 1000) まで溜まると、1 件追加するたびに `DebugLogRow` が 1000 回呼ばれる
- 実測 (Chromium、dev サーバー、`preact.options.__r` で描画を数え、追加からマイクロタスクが片付くまでの中央値): 1000 件表示で 1 件追加 23.0 ms、描画は `DebugLogList` 1 回・`DebugLogCount` 1 回・`DebugLogRow` 1000 回。同じ計測で 100 件表示 2.2 ms / 300 件表示 5.8 ms
- 同じリポジトリの WebTransport のメッセージ一覧は、表示を新しい 200 件に限ることで 1 件追加を 44.8 ms から 3.0 ms にした (`devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`)

## 設計方針

- 行の vnode をログの連番で保持し、展開の状態・表示モード・コピーの表示が変わったときだけ作り直す。Preact は `_original` が一致する vnode を再び受け取ると、その部分木の差分を省略する (内部実装への依存のため、描画回数を E2E で固定する) ため、1 件追加で描画される行が 1 件になる
- 上限で捨てたログの vnode はキャッシュから落とす (連番は増え続けるため、残すと長いセッションで増え続ける)。`devtools/src/utils/logRowState.ts` の枝刈りと同じ考え方を使う
- 上限 (`MAX_LOGS`) と表示の内容 (新しい順、展開、Binary タブ、Expand All / Collapse All、オートスクロール、Clear) は変えない
- 展開やコピーの操作をしたときは行を作り直してよい (利用者の操作 1 回につき 1 度)

## 完了条件

- 1000 件表示で 1 件追加したときに描画される `DebugLogRow` が 1 件だけになる (E2E で固定する)。パネル本体と App は 0 回のまま
- 1 件追加の所要時間が半分以下になる (実測: 同じ計測方法で 1000 件表示の中央値 23.0 ms → 7.6 ms)
- 画面の表示と操作 (新しい順、展開、折りたたみ、Binary タブ、Expand All / Collapse All、オートスクロール、Clear、上限で捨てたログの状態) が変わらない
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` / `vp run e2e-test` が通る

## 残る課題

- 行の描画は 1 件になったが、Preact が表示中のすべての子 (行の vnode) を走査する分と、行の vnode のキャッシュの枝刈り (全キーの走査、1000 件で約 11 µs) は件数に比例して残る (実測: 100 件 0.4 ms / 300 件 1.3 ms / 1000 件 7.6 ms)。この分を無くすには、表示する行を画面に入る分だけにする (仮想化) か、表示件数を絞る (WebTransport のメッセージ一覧は 200 件) 必要がある。表示の内容を変える判断が要るため 0767 で扱う

## 参照

- `devtools/src/components/DebugLogList.tsx` の `DebugLogList` (行の組み立て)
- `devtools/src/components/DebugLogRow.tsx` の `DebugLogRow`
- `devtools/src/utils/logRowState.ts` の `pruneLogIds` / `pruneViewModes`
- `devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`
- `tests/e2e/devtools-debug-panel.spec.ts` (表示と操作の E2E)
- `tests/e2e/devtools-rerender-scope.spec.ts` (描画回数の数え方)
