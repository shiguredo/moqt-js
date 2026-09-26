# moqt-devtools のデバッグパネルの 1 件追記のコストを、表示件数に依らなくする

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/perf-devtools-debug-panel-visible-rows
- Polished: {YYYY-MM-DD}

## 目的

デバッグパネルを開いている間は、ログの上限 (`MAX_LOGS` = 1000) まで溜まると 1 件追加するたびに表示中のすべての行の分のコストがかかる。最初の対応で行の描画は 1 件分になったが、Preact が表示中のすべての子を走査する分は件数に比例して残る。Object の送受信は毎秒数十件になるため、再生中もログを出し続けられるようにする。

## 現状

- `devtools/src/components/DebugLogList.tsx` は、行の vnode をログの連番で保持し、展開の状態・表示モード・コピーの表示が変わったときだけ作り直す。1 件追加で描画される `DebugLogRow` は 1 件である
- それでも Preact は一覧の子 (表示中のすべての行の vnode) を走査する。実測 (Chromium、`preact.options.__r` で描画を数え、追加から描画までの中央値): 100 件 0.4 ms / 300 件 1.4 ms / 1000 件 7.2 ms。行の描画をやめる前は 1000 件で 18.4 ms だった
- パネルを開いている間は 1000 行の DOM が残る
- 同じリポジトリの WebTransport のメッセージ一覧は、表示を新しい 200 件に限ることで 1 件追加を 44.8 ms から 3.0 ms にした (`devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`)

## 設計方針

- 画面に入る行だけを描画する (仮想化)。行の高さは展開の状態で変わるため、行の高さを測って窓を作る。スクロールの位置と行の高さの対応が崩れないようにする
- もしくは、表示する件数を絞る (WebTransport のメッセージ一覧と同じ 200 件など)。ログは保持したまま表示だけを絞ると、古いログを遡れなくなるため、どちらを選ぶか決めてから着手する
  - 仮想化を選ぶ場合: 新しい順、展開、折りたたみ、Binary タブ、Expand All / Collapse All、オートスクロール、Clear の動きを変えない
  - 表示件数を絞る場合: 遡れなくなることを許容し、画面にその旨を出す

## 完了条件

- パネルを開いて 1000 件保持しているときの 1 件追加の所要時間が、画面に描く行の数で決まる (仮想化の場合)。実測で「1000 件保持・画面に見える行だけを描く」ときの 1 件追加が、100 件保持のときと同じ桁 (2 倍以内) になることを示す
- 表示件数を絞る場合: 1000 件保持・表示 200 件のときの 1 件追加が、表示 200 件のときと同じであることを実測で示す
- 選んだ方式で「画面に入っていない行の DOM が無い」(仮想化) または「表示件数の上限が画面に出る」(件数制限) を E2E で固定する
- 仮想化を選んだ場合は、新しい順、展開、折りたたみ、Binary タブ、Expand All / Collapse All、オートスクロール、Clear の動きが変わらないことを E2E で固定する
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` / `vp run e2e-test` が通る

## 参照

- `devtools/src/components/DebugLogList.tsx` の `DebugLogList` (行の vnode のキャッシュ)
- `devtools/src/components/DebugLogRow.tsx` の `DebugLogRow`
- `devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`
- `devtools/src/webtransport-devtools/components/MessageItem.tsx` の `MessageItem`
- `tests/e2e/devtools-debug-panel.spec.ts` の描画回数のテスト
