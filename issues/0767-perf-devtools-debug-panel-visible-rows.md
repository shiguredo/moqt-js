# moqt-devtools のデバッグパネルの 1 件追記のコストを、表示件数に依らなくする

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/perf-devtools-debug-panel-visible-rows
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

デバッグパネルを開いている間は、ログの上限 (`MAX_LOGS` = 1000) まで溜まると 1 件追加するたびに表示中のすべての行の分のコストがかかる。最初の対応 (0766) で行の描画は 1 件分になったが、Preact が一覧の子 (表示中のすべての行の vnode) を走査する分、行を組み立てる走査、行の vnode のキャッシュの枝刈りが件数に比例して残る。ログの追加が続いても再生を止めないため、画面に入る行だけを描画する仮想化にして、1 件追加のコストを画面に入る行の数だけで決まるようにする。

## 現状

- `devtools/src/components/DebugLogList.tsx` は、行の vnode をログの連番で保持し、展開の状態・表示モード・コピーの表示が変わったときだけ作り直す。1 件追加で描画される `DebugLogRow` は 1 件である
- それでも `DebugLogList` は `getLogBuffer()` の全件を新しい順に走査して `rows` を組み立て、Preact はその `rows` のすべての子を走査する。実測 (Chromium、`preact.options.__r` で描画を数え、追加から描画までの中央値): 100 件 0.4 ms / 300 件 1.4 ms / 1000 件 7.2 ms。行の描画をやめる前は 1000 件で 18.4 ms だった (0766 の実装時の計測。0766 の解決方法には別の計測で 23.0 ms / 7.6 ms とある)
- 上限に達した後は、行の vnode のキャッシュの枝刈り (`devtools/src/utils/logRowState.ts` の `pruneMapByLogId`) が全キーを走査する (1000 件で約 11 µs)
- パネルを開いている間は 1000 行の DOM が残る
- 同じリポジトリの WebTransport のメッセージ一覧は、上限 200 件への制限などを含む対策で 1 件追加を 44.8 ms から 3.0 ms にした (`devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`)

## 設計方針

- 画面に入る行だけを描画する (仮想化) を選ぶ。表示件数を絞る案 (WebTransport のメッセージ一覧と同じ 200 件など) もあるが、デバッグパネルは 1000 件を遡れることを保つため、仮想化にする。ログの保持 (`MAX_LOGS` = 1000) と `Copy for LLM` が全件を対象にすることは変えない
- 画面に入る行と前後の数行 (オーバースキャン) だけを DOM に出す。行の高さは展開の状態で変わるため、描画した行の高さを `ResizeObserver` で測り、ログの連番ごとに保持する。画面外の行は推定値を使い、描画したときに測り直して窓とスクロール位置を補正する
- 新しいログを先頭に追加したとき、先頭 (最新) を表示していなければ、追加した行の高さ分だけ `scrollTop` を進めて、読んでいる位置を保つ。先頭を表示しているときは先頭へスクロールする (既存のオートスクロール)
- 展開・折りたたみ・Binary タブの切り替えで行の高さが変わったとき、その行より上を表示している場合は `scrollTop` を差分だけ補正して、読んでいる位置を保つ
- 行の vnode のキャッシュは画面に入る行だけにし、保持件数分の全キー走査をなくす。行を組み立てる走査も、画面に入る行数で止める。絞り込みがある場合は一致する行を探す走査だけを許容する
- 絞り込み・一時停止の切り替えでは、表示するスナップショットから窓を作り直す。一時停止中は新しいログを追加しないため、窓は固定される
- 既存の動きを変えない: 新しい順、展開、折りたたみ、Binary タブ、絞り込み (本文・重要度・接続元)、一時停止、最新へ戻る、Expand All / Collapse All、オートスクロール、Clear
- `data-testid="debug-log-list"` と `data-testid="debug-log-row"` は残す (E2E が使う)

## 完了条件

- 既定の表示 (絞り込み・一時停止・展開なし) で、パネルを開いて 1000 件保持しているときの 1 件追加の所要時間が、画面に描く行の数で決まる。0766 と同じ計測方法 (Chromium、`preact.options.__r` で描画を数え、追加から描画までの中央値を 20 回以上測る) で、同じ実装の 100 件保持と 1000 件保持を同じ環境で測り、1000 件保持の 1 件追加が 100 件保持の 2 倍以内であることを示す。絶対値は計測環境で変わるため、E2E の合否にはせず、解決方法に計測結果を記録する
- 1000 件保持でパネルを開いたとき、`data-testid="debug-log-row"` の数が 1000 未満で、画面に入る行とオーバースキャンの行だけになる。画面外の古いログは DOM に無く、スクロールすると表示されることを E2E で固定する
- 行の組み立てと行の vnode のキャッシュの枝刈りが、保持件数ではなく画面に入る行数に比例する (1000 件保持で 100 件保持と同じ桁)。1000 件保持のときに全件を走査しないこと (絞り込みの一致探索を除く) を、実装で確認する
- 新しい順、展開、折りたたみ、Binary タブ、絞り込み (本文・重要度・接続元)、一時停止、最新へ戻る、Expand All / Collapse All、オートスクロール、Clear の動きが変わらないことを E2E で固定する。1000 行を前提にしている既存の E2E (行数、`nth` の位置、Expand All の `pre` の数) は、仮想化の DOM 数に合わせて更新する
- スクロールして古いログを表示できる (仮想化で 1000 件を遡れる) ことを E2E で固定する
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc -p devtools --noEmit` / `vp test run` / `vp run e2e-test` が通る

## 参照

- `devtools/src/components/DebugLogList.tsx` の `DebugLogList` (行の vnode のキャッシュ、行の組み立て)
- `devtools/src/components/DebugLogRow.tsx` の `DebugLogRow` (行の高さ)
- `devtools/src/components/DebugPanel.tsx` の `DebugPanel` (展開状態、絞り込み、一時停止、Expand All / Collapse All)
- `devtools/src/signals/debug.ts` の `autoScroll` / `isDebugPanelOpen`
- `devtools/src/signals/debugLog.ts` の `MAX_LOGS` / `addLog`
- `devtools/src/utils/logRowState.ts` の `pruneMapByLogId`
- `devtools/src/webtransport-devtools/messageLog.ts` の `MAX_STREAM_MESSAGES`
- `devtools/src/webtransport-devtools/components/MessageItem.tsx` の `MessageItem`
- `tests/e2e/devtools-debug-panel.spec.ts` の描画回数のテスト
- `tests/e2e/devtools-rerender-scope.spec.ts` の描画回数の数え方
