# MediaPublisher の自己起点 close で state が closed に化け、状態遷移図に stopped からの辺がない

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-publisher-close-state
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaPublisher.ts` の `connectToServer` が渡す `onSessionClose` は state が `"closed"` 以外なら `"closed"` にして `onClose` を呼ぶ。`stop` は `disposeAllResources()` の中で session を閉じるため、`"stopped"` にしたあとに session の close 通知が非同期で届き、state が `"closed"` に上書きされ `onClose` が二重に通知される。`close()` 自身も `disposeAllResources()` の後に `"closed"` と `onClose` を行うため、自己起点の close でも通知が二重になり得る。`start` は `"created"` と `"stopped"` を受け付ける契約なのに、実機では `"stopped"` が保たれず再開が保証されない。

## 現状

- `src/createMediaPublisher.ts` の `onSessionClose` は state が `"closed"` 以外なら `setState("closed")` と `callbacks.onClose?.()` を行う
- `src/createMediaPublisher.ts` の `stop` は `disposeAllResources()` の後に `setState("stopped")` を行う。`close` は `disposeAllResources()` の後に `setState("closed")` と `onClose` を行う
- `disposeAllResources()` は session を閉じるため、自己起点の `stop` / `close` でも `onSessionClose` が非同期に届き得る。世代で区別する仕組みが無い
- `src/createMediaPublisher.ts` の `start` は `"created"` と `"stopped"` を受け付け、それ以外は throw する
- `docs/HIGH_LEVEL_API.md` の MediaPublisher の状態遷移図は `created ──start(stream)──► publishing` と `publishing → stop() → stopped` を描くが、`stopped ──start(stream)──► publishing` の辺が無い。メソッド表の `stop` / `close` の説明も解放と再開の契約を書いていない
- 0654 は `createMediaSubscriber` 側で session の世代番号を使い、自己起点の close 通知を捨てる方式を定めている。`createMediaPublisher` 側の同じ穴と図の欠落辺は対象外とされている

## 設計方針

- 0654 と同じ世代番号方式を publisher 側にも入れる。`connectToServer` が session を作るときに現在の世代番号を捕捉して `onSessionClose` のクロージャに持たせ、`disposeAllResources()` の冒頭で世代番号を進める。捕捉値が現在値と一致しない通知は state も `onClose` も動かさない
- 真偽旗ではなく世代番号にする理由は 0654 と同じである。解放の前後で await を挟む間に旧 session の通知が新しい session の確立後へ遅れて届く場合と、解放自体が失敗して旗が残る場合を扱えない
- `stop` は通知しない (`"stopped"` のまま)。`close` は `close` 自身が解放後に `"closed"` と `onClose` を行う。ピア起点の close (世代番号が一致する通知) は従来どおり `"closed"` と `onClose` を通知する
- `close` の単発性を保つ既存の early return を維持する
- 解放の段階失敗で最初の失敗を throw し参照は切り離し済みとする既存の形を変えない
- `docs/HIGH_LEVEL_API.md` の MediaPublisher の状態遷移図に `stopped ──start(stream)──► publishing` を足し、`close()` を終端として明記する。メソッド表の `stop` / `close` の説明も更新する
- `src/codec/types.ts` の `MediaPublisher` の `start` / `stop` / `close` の説明を実装と揃える
- `src/createMediaPublisher.test.ts` に、解放後の session close 通知で state と `onClose` が変わらないことを固定するテストを追加する (0654 の subscriber 側と同じく、記録用オブジェクトを注入して駆動する)
- `CHANGES.md` の `## develop` に `[FIX]` を追記する

## 完了条件

- 自己起点の `stop` のあと state が `"stopped"` のまま (`"closed"` に化けない) で、`onClose` が呼ばれない
- 自己起点の `close` で `onClose` が 1 回だけ通知される
- `"stopped"` から `start()` を呼んでも `cannot start in state` で拒否されない
- 解放のあとに届いた session close 通知で state と `onClose` が変わらない。新しい session を確立したあとに旧 session の通知が届いた場合も無視される
- `docs/HIGH_LEVEL_API.md` の MediaPublisher の状態遷移図・メソッド表が実装と一致する
- `src/createMediaPublisher.test.ts` に上記を固定するテストが追加される
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0654 (createMediaSubscriber 側の stop / close の解放と再開。createMediaPublisher 側の同じ穴と図の欠落辺を対象外としている)
- `src/createMediaPublisher.ts` の `onSessionClose` / `stop` / `close` / `disposeAllResources` / `start`
- `docs/HIGH_LEVEL_API.md` の MediaPublisher の状態遷移

## 解決方法

{未着手}
