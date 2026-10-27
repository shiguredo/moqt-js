# catalog 購読がエラー status の PUBLISH_DONE で終わっても待ちが解放されず、通知が二重になる

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-publish-done-wait
- Polished: 2026-10-27

## 目的

高レベル API の起動時、catalog の購読がエラーを示す Status Code の PUBLISH_DONE で終わっても catalog の待ちが解放されない。`onError` が 1 回目 (PUBLISH_DONE 由来) と 2 回目 (受信タイムアウト由来) の 2 回呼ばれ、`start()` もタイムアウトを理由に失敗する。1 つの終了で通知が 2 回になり、失敗の理由も実際の Status Code から `catalog receive timeout` に置き換わるため、relay の切り分けで誤った結論を導く。

## 現状

- `src/createMediaSubscriber.ts` の `subscribeCatalog` は `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` への wrapper であり、catalog の待ちは `tryResolveCatalog` の resolve (受信) と、`rejectCatalogReceiveTimeout` の reject (受信タイムアウト)、`abortReceive` の reject (解放) でのみ決着する
- catalog の購読の `end` は `handlePublishDone` を呼ぶだけで、catalog の待ちを解放しない。エラー status で catalog の待ちが未決着のままなら、`onError` が呼ばれ、その後に `CATALOG_RECEIVE_TIMEOUT` (5 秒) のタイムアウトで catalog の待ちが reject され、`start()` の失敗経路が `onError` をもう一度呼ぶ。`start()` は `catalog receive timeout` で失敗する
- devtools (`devtools/src/hooks/useSubscriber.ts`) は同じ状況で catalog の購読の `end` から即座に reject しており、扱いが 2 つの実装で分かれている
- `src/createMediaSubscriber.publish-done.test.ts` の `subscribeCatalog: エラー status の PUBLISH_DONE で catalog の購読が失敗する` は、PUBLISH_DONE の後に待ちが解放されず、`close()` で打ち切る挙動を固定している

## 設計方針

- エラーを示す Status Code の PUBLISH_DONE で catalog の購読が終わったときは、FETCH の完了を待たずに、常に PUBLISH_DONE の理由で catalog の待ちを reject する。devtools は同じ状況で `end` から即座に reject しており、この扱いに揃える。FETCH が応答しない場合 (`0835-bug-catalog-fetch-cancel.md` の状況) も待たないため、受信タイムアウト (5 秒) まで失敗が遅れない
- catalog の待ちを reject するときは `rejectCatalogReceiveTimeout` と同じ後始末 (タイマー解除、フェーズ状態の解除、`catalogReceiveFailed` を立てる) を行い、reject する Error だけを PUBLISH_DONE の Status Code と Reason Phrase から作る
- catalog の `end` では、待ちが未決着なら `onError` を呼ばずに待ちを reject し、`start()` の失敗経路が `onError` を 1 回だけ通知する。待ちが決着済み (起動後) なら `handlePublishDone` で `onError` を 1 回だけ通知する。これで 1 つの終了で `onError` を 2 回呼ばない
- `start()` が失敗する理由を、実際に起きた終了 (Status Code と Reason Phrase) にする。タイムアウトの文言に置き換えない
- `docs/HIGH_LEVEL_API.md` の `start()` の失敗の説明を更新する。catalog の購読がエラー status の PUBLISH_DONE で終わった場合は `catalog receive timeout` ではなく PUBLISH_DONE の Status Code と Reason Phrase で失敗することを書く
- 対象外: devtools 側の扱い (現状の即座の reject でよいことを確認するだけ。変更しない)
- 対象外: 正常な PUBLISH_DONE (TRACK_ENDED 等) の通知 (`0842-add-media-subscriber-normal-end.md` の範囲。本 issue では正常終了の扱いを変えない)
- 対象外: `CHANGES.md` の更新 (`CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」)

## 完了条件

- エラーを示す Status Code の PUBLISH_DONE で catalog の購読が終わったとき、`onError` が PUBLISH_DONE の理由で 1 回だけ呼ばれる (起動中は `start()` の失敗経路、起動後は `handlePublishDone` の経路)
- `start()` の失敗の理由が実際の Status Code と Reason Phrase を保つ (タイムアウトの文言に置き換わらない、タイムアウトを待たない)
- catalog の待ちが PUBLISH_DONE の Error で reject され、`CATALOG_RECEIVE_TIMEOUT` を待たない
- `src/createMediaSubscriber.publish-done.test.ts` の `subscribeCatalog: エラー status の PUBLISH_DONE で catalog の購読が失敗する` が新しい期待に追従する。既存の `src/createMediaSubscriber.media.test.ts` の `subscribeCatalog` のタイムアウトのテストが通る
- `start()` の経路と、起動後の catalog の `end` の経路で、`onError` が PUBLISH_DONE の理由で 1 回だけ呼ばれることを固定するテストを追加する
- `docs/HIGH_LEVEL_API.md` の `start()` の失敗の説明が新しい挙動に追従する
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `src/createMediaSubscriber.ts` の `subscribeCatalog` (wrapper) / `handlePublishDone` / `resolvePublishDoneError`
- `src/mediaSubscriber/catalogSubscription.ts` の `CatalogSubscription.subscribe` / `tryResolveCatalog` / `rejectCatalogReceiveTimeout` / `abortReceive` / `CATALOG_RECEIVE_TIMEOUT`
- `src/createMediaSubscriber.publish-done.test.ts` の `subscribeCatalog` のテスト
- `src/createMediaSubscriber.media.test.ts` の `subscribeCatalog` のタイムアウトのテスト
- `src/createMediaSubscriber.lifecycle.test.ts` の `start()` の失敗と解放のテスト
- `devtools/src/hooks/useSubscriber.ts` の catalog の購読の `end`
- `docs/HIGH_LEVEL_API.md` の `start()` の失敗とカタログの受信の説明
- closed の `0840-change-subscriber-publish-done-reason.md` (終了通知の契約)
- open の `0835-bug-catalog-fetch-cancel.md` (FETCH が応答しない場合)
- open の `0842-add-media-subscriber-normal-end.md` (正常な PUBLISH_DONE の通知。本 issue はエラー status のみを扱う)

## 解決方法

{未着手}
