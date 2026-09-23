# MediaPublisher の自己起点 stop / close でも session の close 通知が届き onClose が誤発火する

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-publisher-close-state
- Polished: 2026-09-23

## 目的

`src/createMediaPublisher.ts` の `connectToServer` が渡す `onSessionClose` は state が `"closed"` 以外なら `"closed"` にして `onClose` を呼ぶ。`stop` と `close` は `disposeAllResources()` の中で session を閉じるため、自己起点の解放でもこの通知が届く。`stop` では利用者が閉じていないのに `onClose` が呼ばれ、`onStateChange` が `"closed"` を経由する。通知が `setState("stopped")` より後に届く場合は state が `"closed"` のまま残り、`start()` が `cannot start in state` で拒否して再開できない。`close` では、通知が `close` 自身の `setState("closed")` より前に届くと `onClose` が `onSessionClose` と `close` 自身の 2 回になる。解放の世代で自己起点の通知を区別する仕組みが無い。

## 現状

- `onSessionClose` は `state !== "closed"` なら `setState("closed")` と `callbacks.onClose?.()` を行う。`setState` は `callbacks.onStateChange?.(newState)` も呼ぶ
- `stop` は `processingGeneration++` → `await disposeAllResources()` → `setState("stopped")` の順である。`close` は `processingGeneration++` → `await disposeAllResources()` → `setState("closed")` と `onClose` の順である
- session の close 通知は `src/session.ts` が `transport.closed` の `.then` と `.catch` で送る。`src/session/lifecycle.ts` の解放手順は `transport.close(...)` を同期で呼ぶため、自己起点の `stop` / `close` でも通知が届く
- 通知が `setState("stopped")` より前に届くか後になるかは `disposeAllResources()` の中の await の位置に依存する。前に届けば `onClose` の誤発火と `onStateChange("closed")` が起き、後に届けば state が `"closed"` のまま残って `start()` が `"stopped"` を受け付けない。どちらも誤りである
- `processingGeneration` は処理ループ用で、`pause()` / `stop()` / `close()` の 3 箇所で加算される (`disposeAllResources()` では加算されない)。session の close 通知はこの世代を見ていない
- `start` は `"created"` と `"stopped"` を受け付け、それ以外は throw する
- `docs/HIGH_LEVEL_API.md` の状態遷移図は `created ──start(stream)──► publishing` と `publishing → stop() → stopped` を描くが、`stopped ──start(stream)──► publishing` と `paused ──stop()──► stopped` の辺が無い。メソッド表の `stop` / `close` の説明も解放と再開の契約を書いていない
- `src/codec/types.ts` の `MediaPublisher` は `state` / `start` / `pause` / `resume` / `stop` / `requestKeyframe` / `close` の宣言だけで JSDoc を持たない
- `src/createMediaPublisher.test.ts` は private を直接駆動する制御口 (`PublisherLifecycleControl`) を既に持つ。`start()` は接続を要するため Node では駆動できない
- 0654 は `createMediaSubscriber` 側で session の世代番号を使い、自己起点の close 通知を捨てる方式を定めている (`## 解決方法` は未着手)。`createMediaPublisher` 側の同じ穴と図の欠落辺は対象外とされている

## 設計方針

- 0654 と同じ世代番号方式を publisher 側にも入れる。0654 の完了後に実装する。コードの対象ファイルは 0654 が `createMediaSubscriber.ts`、本 issue が `createMediaPublisher.ts` で重ならないが、`docs/HIGH_LEVEL_API.md` / `src/codec/types.ts` / `CHANGES.md` は 0654 も対象にしているため同時に進めると衝突する。0657 待ちの 0679 も `src/createMediaPublisher.ts` と `CHANGES.md` を対象にするため、0679 とも同時に進めない
- session close 通知専用の世代番号を新設する。既存の `processingGeneration` は流用しない。`pause()` でも進むため、流用すると pause のあとのピア起点 close 通知が世代不一致で捨てられる。また `disposeAllResources()` で進める形にすると `stop()` / `close()` 本体の加算と合わせて 2 回進み、加算 1 回を期待する既存テストが崩れる
- `connectToServer` が session を作るときに現在の世代番号を捕捉し、`onSessionClose` のクロージャに持たせる。世代番号を進めるのは `disposeAllResources()` の 1 箇所だけにする
- 捕捉値が現在値と一致しない通知は state も `onClose` も動かさない。ピア起点の close (一致する通知) は従来どおり `"closed"` と `onClose` を通知する
- 通知処理は世代番号を引数に取る private メソッドに切り出し、テストから直接駆動できるようにする。`start()` は接続を要するため、既存の `PublisherLifecycleControl` と同じく private 経由で駆動する
- 真偽旗ではなく世代番号にする理由は 0654 と同じである。解放の前後で await を挟む間に旧 session の通知が新しい session の確立後へ遅れて届く場合と、解放自体が失敗して旗が残る場合を扱えない
- `stop` は通知しない (`"stopped"` のまま)。`close` は `close` 自身が解放後に `"closed"` と `onClose` を行う
- `close` の単発性を保つ既存の early return を維持する
- 解放の段階失敗で最初の失敗を throw し参照は切り離し済みとする既存の形を変えない
- `docs/HIGH_LEVEL_API.md` の状態遷移図に `stopped ──start(stream)──► publishing` と `paused ──stop()──► stopped` を足し、`close()` を終端として明記する。メソッド表の `stop` / `close` の説明も更新する
- `src/codec/types.ts` の `MediaPublisher` に `start` / `stop` / `close` の JSDoc を追加し、`"stopped"` が再開可能で `close()` が終端であることを書く
- 対象は `src/createMediaPublisher.ts` / `src/codec/types.ts` / `docs/HIGH_LEVEL_API.md` / `src/createMediaPublisher.test.ts` / `CHANGES.md` とする
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- 自己起点の `stop` で `onClose` が呼ばれず、`onStateChange` に `"closed"` が現れない
- 自己起点の `stop` のあと state が `"stopped"` で、`start()` に `cannot start in state` で拒否されない
- 自己起点の `close` で `onClose` が 1 回だけ、`onStateChange` の `"closed"` も 1 回だけ通知される
- 解放のあとに届いた session close 通知で state と `onClose` が変わらない。新しい session を確立したあとに旧 session の通知が届いた場合も無視される
- ピア起点の close 通知は従来どおり `"closed"` と `onClose` を 1 回通知する
- `pause()` のあとのピア起点 close 通知が世代不一致で捨てられない (`processingGeneration` を流用していない)
- 世代番号を進めるのは `disposeAllResources()` の 1 箇所だけで、既存の `processingGeneration` の加算位置と回数が変わらない
- `src/createMediaPublisher.test.ts` に、private に切り出した通知処理を世代番号を与えて直接駆動し、上記を固定するテストが追加される
- `docs/HIGH_LEVEL_API.md` の状態遷移図 (2 つの辺の追加) とメソッド表が実装と一致する
- `src/codec/types.ts` の `MediaPublisher` に `start` / `stop` / `close` の JSDoc が入る
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0654 (createMediaSubscriber 側の stop / close の解放と再開。世代番号方式の出所。publisher 側の同じ穴と図の欠落辺を対象外としている)
- 0679 (高レベル API の通知回数の扱い。`onError` 側の不変条件)
- `src/createMediaPublisher.ts` の `onSessionClose` / `stop` / `close` / `disposeAllResources` / `start`、`src/session.ts` の `transport.closed` 監視、`src/session/lifecycle.ts` の解放手順、`docs/HIGH_LEVEL_API.md` の MediaPublisher の状態遷移

## 解決方法

{未着手}
