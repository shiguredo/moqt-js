# moqt-devtools の副題のモードリンクが設定変更のたびに App 全体を再描画しないようにする

- Created: 2026-09-25
- Completed: 2026-09-26
- Branch: feature/refactor-devtools-mode-subtitle-render
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools のヘッダーの副題に並べたモードのリンクは、`href` を今の接続設定に追従させるため、render 中に接続設定の signal をすべて読む。そのため、設定を 1 文字入力するたびに `App` が再描画され、子コンポーネントの関数本体も再実行される。DebugPanel は開いている間に最大 1000 件のログを毎 render 組み立てるため、設定入力時の不要な再描画を減らす。

## 現状

- `devtools/src/App.tsx` の `App` は、副題のリンクの `href` を `buildQueryStringForMode(targetMode)` で作る。この関数は `buildQueryParams` を通じて `url` / `fragment` / `namespace` / `trackName` / `codec` / `videoSource` などの signal を読むため、`App` がそれらすべてを購読する
- 設定を変更するたびに `App` と子コンポーネント (`ConnectionSettings` / `PublisherPanel` / `SubscriberPanel` / `DebugPanel`) の関数本体が再実行される。表示モードの追加前の `App` は `subscriberIds` / `isDebugPanelOpen` / `logCount` だけを読んでいたため、設定入力では再描画されなかった
- 描画の遅れは実測しておらず、体感できる問題は未確認である

## 設計方針

- 副題 (`Media over QUIC Transport - ...` の行) を専用のコンポーネントに切り出す
  - 切り出したコンポーネントの中で `mode` と `buildQueryStringForMode` を読み、signal の購読範囲を副題だけに限定する
  - `App` は副題の外で接続設定の signal を読まなくなり、設定変更で `App` と子コンポーネントが再描画されない
- リンクの `href` が設定変更に追従することは変えない
- 見た目・リンク先・`data-testid` は変えず、既存の画面確認と E2E に影響させない

## 完了条件

- `devtools/src/App.tsx` の `App` が接続設定の signal を読まない
- 副題の表示・リンクの `href`・新しいタブで開く挙動が変わらない
- 設定を変更すると副題のリンクの `href` が更新される
- 手元のブラウザで、設定の変更で再描画される範囲が副題だけになることを確かめる
- `npx vp check` / `npx vp test --run` / 既存の E2E (`npx vp run e2e-test`) が通る

## 参照

- `devtools/src/App.tsx` の `App` / `MODE_LABELS`
- `devtools/src/signals/connectionSettings.ts` の `buildQueryStringForMode` / `buildQueryParams`
- `devtools/src/components/DebugPanel.tsx` の `DebugPanel` (ログの組み立て)

## 解決方法

- `devtools/src/components/ModeSubtitle.tsx` を足し、`App` が持っていた副題 (`Media over QUIC Transport - ...` の行) と `MODE_LABELS` を移した。`mode` と `buildQueryStringForMode` を読むのはこのコンポーネントの中だけになり、接続設定の signal の購読が副題に閉じる
- `devtools/src/App.tsx` の `App` は接続設定の signal を読まなくなった。Copy URL ボタンは `useCopyUrlButton` がクリック時に `buildQueryString` を呼ぶ形のままで、描画時の購読を作らない
- 副題の表示・リンクの `href`・`target="_blank"`・`data-testid` (`mode-link-{mode}`) は変えていない
- テスト: `tests/e2e/devtools-rerender-scope.spec.ts` を足した。実ブラウザで Preact の描画フック (`options.__r`) を包んでコンポーネントごとの描画回数を数え、Relay URI へ 10 文字入力したときに `App` と `SubscriberPanel` が 0 回、`ModeSubtitle` が 1 回以上再描画されること、`mode-link-publisher` の `href` が入力した URL へ追従することを確かめる。devtools にはコンポーネントテストの基盤 (Vitest Browser Mode) が無いため、再描画の範囲はこの E2E で確かめる
- 実測 (Relay URI へ 10 文字入力したときの描画時間): 修正前は `App` が 10 回再描画されて 23.7 ms かかっていた。修正後は 8.4 ms になり、再描画されるのは副題だけになる
- `npx vp check` / `npx vp test --run` (161 ファイル / 2986 テスト) / `npx vp run e2e-test` (48 件) が通った
