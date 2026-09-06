# webtransport-devtools で WebTransport.closed が受け取った closeInfo を表示する

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/add-webtransport-devtools-closed-outcome
- Polished: YYYY-MM-DD

## 目的

sora-quic リポジトリの issue 0445 (CONNECT ストリーム capsule framing の RFC 9297 DATA frame ラップ対応) では、送信側サーバーから Chromium へ close_code / reason が渡ることをブラウザ E2E で検証する必要がある。Shiguredo WebTransport DevTools ページ (`https://moqt-devtools.shiguredo.app/webtransport-devtools`) が `WebTransport.closed` の closeInfo を表示しないため、現状は Playwright の `page.add_init_script` で `WebTransport` をラップして closeInfo を自己記録する回避策が採られている。ページ側で closeInfo を表示すれば、E2E は `data-testid` 経由で直接読み出せる。

## 現状

- `devtools/src/webtransport-devtools/signals.ts` の `connect()` にある `wt.closed.then()` のコールバックは `WebTransportCloseInfo` 引数を受け取っておらず、ピア (またはローカルの `close()`) から受け取った closeCode / reason をそのまま捨てている (W3C WebTransport CR §6.3 / §6.6 / §6.10)
- fulfilled 直後に `disconnect()` が呼ばれ、`wtClosedState` を含む表示がすべてリセットされるため、セッション終了情報がページに残らない
- rejected 側 (異常終了、W3C WebTransport CR §6.5) も `connectionError` を設定した直後の `disconnect()` で `connectionStatus` が `disconnected` に戻るため、エラーメッセージが表示されない

## 設計方針

1. `closed` の結果 (fulfilled: closeCode / reason、rejected: エラーメッセージ) を `ClosedOutcome` 型で定義し、切断後も保持する signal `wtClosedOutcome` に記録する。クリアは再接続 (`connect()`) の開始時に行い、`disconnect()` ではリセットしない
2. `ClosedOutcome` の構築と表示用整形は純粋関数として `devtools/src/webtransport-devtools/closedOutcome.ts` に分離し、ユニットテストでカバーする。整形ではフィールドの欠落 (`undefined`) と空文字 (`""`) を区別して表示する
3. `ConnectionPanel` に切断後も残る "Last closed outcome" ブロックを追加し、`data-testid` (`closed-outcome` / `closed-outcome-state` / `closed-outcome-code` / `closed-outcome-reason` / `closed-outcome-error`) を付与する

## 完了条件

- closeCode / reason を指定した切断、またはピア起点のセッション終了時に、`closed` が受け取った値がページに表示され続け、Playwright のテストから testid で読み出せること
- rejected 経路でもエラーメッセージが同ブロックに表示されること
- `vp check` / `tsc --noEmit` / `vp test run` と既存の webtransport-devtools E2E が通ること
