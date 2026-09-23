# createMediaSubscriber の stop() がリソースを解放せず再開もできない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-stop-lifecycle
- Polished: 2026-09-21

## 目的

`src/createMediaSubscriber.ts` の `stop` は購読を解除するだけで、AudioContext / デコーダ / MediaStreamTrackGenerator / session を保持したまま `"stopped"` になる。`start` は `"created"` 以外から呼ぶと throw するため再開できない。`src/createMediaPublisher.ts` の `stop` は `disposeAllResources` で解放し、`start` が `"created"` と `"stopped"` を受け付ける契約になっているため、高レベル API として非対称である。

## 現状

- `src/createMediaSubscriber.ts` の `stop` は `catalogSubscriber` / `audioSubscriber` / `videoSubscriber` を unsubscribe して `setState("stopped")` するだけである
- `src/createMediaSubscriber.ts` の `close` は `audioDecoder` / `videoDecoder` / `videoWriter` / `audioContext` / `session` を閉じて `"closed"` にする。解放処理はここにしかなく、参照を null にするのは `outputStream` だけである
- `src/createMediaSubscriber.ts` の `start` は `this.currentState !== "created"` で throw するため `"stopped"` から再開できない。失敗時は `onError` の通知と再 throw だけで、`"subscribing"` のまま残るため再試行もできない
- `src/createMediaPublisher.ts` の `stop` / `close` は共通の `disposeAllResources()` を呼び、`start` は `"created"` と `"stopped"` を受け付け、失敗時は `disposeAllResources()` で巻き戻して state を変えない
- `src/createMediaSubscriber.ts` の `onSessionClose` は state が `"closed"` 以外なら `"closed"` にして `onClose` を呼ぶ。session の close 通知は `transport.closed` の解決後に非同期で届くため、`stop` で session を閉じると `"stopped"` が後から `"closed"` に上書きされ、`onClose` も二重に通知される。`src/createMediaPublisher.ts` の `onSessionClose` も同じ形で、publisher の「再 start 可能な完全停止」も実機では保証されていない
- `src/createMediaSubscriber.ts` の `setupDecoders` は `audioSubscriber` / `videoSubscriber` の `trackProperties` を読むため、再開時に購読オブジェクトの参照が残っていると前世代の値を使う
- `docs/HIGH_LEVEL_API.md` の MediaSubscriber の状態遷移図は `stopped` を終端として描いており、`stopped` から出る辺が無い。メソッド表の `stop` / `close` の説明も解放と再開の契約を書いていない
- `src/codec/types.ts` の `MediaSubscriber` インターフェースには `start` / `stop` / `close` の JSDoc が無く、`"stopped"` の意味は実装クラスの JSDoc にも書かれていない

## 設計方針

- 方式は (A)「`stop` で `close` と同じ解放を行い、`"stopped"` から再 start できるようにする」に確定する。(B)「リソースを保持したまま再開する」は購読解除だけで AudioContext / デコーダを保持し続けるため、解放されないという本質が残る。`MediaSubscriber` に pause / resume は無く、公開 API の追加にもなる
- 解放処理は `close` と共通の 1 つのヘルパー (`disposeAllResources()`) にまとめ、`stop` と `close` の両方から呼ぶ。内容は次のとおり
  - `catalogSubscriber` / `audioSubscriber` / `videoSubscriber` を unsubscribe する (state が `"active"` のときだけ)
  - `audioDecoder` / `videoDecoder` を close する
  - `videoWriter` を close し、`videoTrackGenerator` の track を stop する
  - `audioContext` を close する
  - `session` を close する
  - 参照を null にする (`session` / subscriber 3 種 / `audioDecoder` / `videoDecoder` / `videoWriter` / `videoTrackGenerator` / `audioContext` / `audioDestination` / `outputStream`)
  - 実行時状態を初期値に戻す (`receivedCatalog` / `audioTrackInfo` / `videoTrackInfo` / `catalogResolve` / `catalogFetchInProgress` / `pendingCatalogObjects` / `catalogFetchLastLocation` / `catalogTimer` / `catalogReceiveFailed` / `audioDecoderConfigured` / `videoDecoderConfigured` / `lastAppliedVideoConfig` / `lastAppliedAudioConfig`)
  - 統計 (`audioStats` / `videoStats`) は publisher と同じく再 start でも引き継ぐ
  - 破棄の段階失敗は後続を止めず、最後に最初の失敗を throw する (publisher の `disposeAllResources` と同じ形)
- 自己起点の session close 通知は session の世代番号で捨てる。`connectToServer` が session を作るときに現在の世代番号を捕捉して `onSessionClose` のクロージャに持たせ、`disposeAllResources()` の冒頭で世代番号を進める (stop / close / start 失敗時の巻き戻しの全経路)。届いた通知の捕捉値が現在値と一致しなければ state も `onClose` も動かさない。真偽旗では、解放前後で await を挟む間に旧 session の通知が新しい session の確立後へ遅れて届く場合と、解放自体が失敗して旗が残る場合を扱えない
- `close` の通知は `close` 自身が行う (解放後に `"closed"` にして `onClose` を呼ぶ)。ピア起点の session close (世代番号が一致する通知) は従来どおり `"closed"` と `onClose` を通知する。`stop` では通知しない
- `start` は `"created"` と `"stopped"` を受け付ける。`"subscribing"` に遷移してから失敗した場合は `disposeAllResources()` で巻き戻し、遷移前の state に戻す (publisher と同じく再試行できる)。巻き戻し自体の失敗で元の失敗を隠さない (publisher と同じく握り潰して元のエラーを優先する)
- `stop` は `"stopped"`、`close` は `"closed"` (終端、`close` は冪等) とする
- `stop` は `mediaStream` と `catalog` を無効化するため、再 start 後は新しい `mediaStream` を使う必要があることを JSDoc に書く
- `audioDestination` のトラックは `audioContext.close()` で無効になるため明示的に stop せず、参照だけ null にする
- `docs/HIGH_LEVEL_API.md` の MediaSubscriber の状態遷移図に `stopped ──start()──► subscribing` を足し、`close()` を終端として明記する。メソッド表の `stop` / `close` の説明も更新する
- `src/codec/types.ts` の `MediaSubscriber` に `start` / `stop` / `close` の JSDoc を足し、`"stopped"` が再開可能であることを明記する。実装クラス (`src/createMediaSubscriber.ts`) の JSDoc も揃え、publisher と同じく直列呼び出し前提 (並行呼び出しは未対応) と、解放が失敗しても参照は切り離し済みで再試行できることを書く
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
- 対象外は `createMediaPublisher` 側の同じ穴 (自己起点 close で `"closed"` に化ける) と MediaPublisher の状態遷移図の欠落辺とし、0681 で扱う

## 完了条件

- `stop` のあとに `session` / subscriber 3 種 / デコーダ / `videoWriter` / `videoTrackGenerator` / `audioContext` / `audioDestination` / `outputStream` の参照が残らず、unsubscribe と close が 1 回ずつ呼ばれる
- `stop` のあと state が `"stopped"` のまま (`"closed"` に化けない) で、`onClose` が呼ばれない
- `close` は `stop` と同じ解放を行い、`"closed"` になったあとの `start` は拒否される
- `"stopped"` から `start()` を呼んでも `cannot start in state` で拒否されない
- `start` が失敗したときは解放され、state は遷移前 (`"created"` または `"stopped"`) に戻る
- 解放のあとに届いた session close 通知で state と `onClose` が変わらない。新しい session を確立したあとに旧 session の通知が届いた場合も無視される
- `docs/HIGH_LEVEL_API.md` の MediaSubscriber の状態遷移図・メソッド表と、`src/codec/types.ts` / `src/createMediaSubscriber.ts` の JSDoc が実装と一致する
- 次のテストが `src/createMediaSubscriber.test.ts` に追加される (`src/createMediaPublisher.test.ts` と同じく、cast で private フィールドに記録用のオブジェクトを注入して駆動する)
  - `stop` が全参照を解放し、unsubscribe / close を 1 回ずつ呼ぶ
  - `close` が同じ解放を行い、以後の `start` を拒否する
  - `"stopped"` から `start()` が state ガードで拒否されない (`cannot start in state` を含まないエラーになることを確認し、失敗後の state は `"stopped"` に戻る)
  - `start` の失敗後に state が遷移前に戻り、再試行できる
  - 解放のあとの close 通知で state と `onClose` が変わらない (close 通知の処理を private メソッドに切り出して駆動する)
- WebTransport の実接続と実 WebCodecs を要する再開の区間は Node では駆動できないため、テスト対象外とする
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0663 (createMediaSubscriber の受信経路がテストされていない)。0663 は現状の `stop` / `close` の契約を固定し、変更差分は本 issue 側で扱う前提のため、本 issue を先に実施してから 0663 のテストを新しい契約に合わせる
- `src/createMediaPublisher.ts` の `disposeAllResources` / `stop` / `start` (解放と巻き戻しの形を揃える対象)

## 解決方法

{未着手}
