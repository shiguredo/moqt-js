# catalog 購読がエラー status の PUBLISH_DONE で終わっても待ちが解放されず、通知が二重になる

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-publish-done-wait
- Polished: {YYYY-MM-DD}

## 目的

高レベル API の起動時、catalog の購読がエラーを示す Status Code の PUBLISH_DONE で終わっても catalog の待ちが解放されない。`onError` が 1 回目 (PUBLISH_DONE 由来) と 2 回目 (受信タイムアウト由来) の 2 回呼ばれ、`start()` もタイムアウトを理由に失敗する。1 つの終了で通知が 2 回になり、失敗の理由も実際の Status Code から `catalog receive timeout` に置き換わるため、relay の切り分けで誤った結論を導く。

## 現状

- `src/createMediaSubscriber.ts` の `subscribeCatalog` は、catalog の待ちを resolve (受信) / reject (解放、`rejectCatalogReceiveTimeout`) でのみ決着させる
- catalog の購読の `end` は `handlePublishDone` を呼ぶだけで、catalog の待ちを解放しない。エラー status では `onError` が呼ばれ、その後に `CATALOG_RECEIVE_TIMEOUT` (5 秒) のタイムアウトが `onError` と `start()` の失敗をもう一度起こす
- devtools (`devtools/src/hooks/useSubscriber.ts`) は同じ状況で catalog の購読の `end` から即座に reject しており、扱いが 2 つの実装で分かれている
- `src/createMediaSubscriber.test.ts` の catalog のテストは、待ちが解放されない挙動を固定している

## 設計方針

- エラーを示す Status Code の PUBLISH_DONE で catalog の購読が終わったときの扱いを決める
  - FETCH フェーズがまだ生きている場合は FETCH の完了を待ち、終わっていれば PUBLISH_DONE の理由で決着させる (devtools と同じ扱いになる)
  - 常に待たずに PUBLISH_DONE の理由で決着させる
- どちらを選んでも、1 つの終了で `onError` を 2 回呼ばない
- `start()` が失敗する理由を、実際に起きた終了 (Status Code と Reason Phrase) にする
- `docs/HIGH_LEVEL_API.md` の `start()` の失敗の説明を更新する
- 対象外: devtools 側の扱い (現状のままでよいかの確認だけ行う)

## 完了条件

- エラーを示す Status Code の PUBLISH_DONE で catalog の購読が終わったとき、`onError` が PUBLISH_DONE の理由で 1 回だけ呼ばれる
- `start()` の失敗の理由が実際の Status Code と Reason Phrase を保つ (タイムアウトの文言に置き換わらない、またはタイムアウトを待たない)
- `src/createMediaSubscriber.test.ts` の catalog のテストが新しい期待に追従する
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `src/createMediaSubscriber.ts` の `subscribeCatalog` / `handlePublishDone` / `rejectCatalogReceiveTimeout` / `CATALOG_RECEIVE_TIMEOUT`
- `src/createMediaSubscriber.test.ts` の `subscribeCatalog` のテスト
- `devtools/src/hooks/useSubscriber.ts` の catalog の購読の `end`
- `docs/HIGH_LEVEL_API.md` の `start()` の説明
- closed の `0840-change-subscriber-publish-done-reason.md` (終了通知の契約)

## 解決方法

{未着手}
