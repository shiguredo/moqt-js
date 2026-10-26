# 高レベル API で正常な PUBLISH_DONE を検知できない

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/add-media-subscriber-normal-end
- Polished: 2026-10-27

## 目的

moqt-js の高レベル API (`createMediaSubscriber`) は、publisher が PUBLISH_DONE (TRACK_ENDED 等) で購読を正常に終えても何も通知しない。`MediaSubscriberCallbacks` は `onStateChange` / `onCatalog` / `onError` / `onClose` だけを持ち、エラーを示す Status Code のときだけ `onError` が呼ばれる。アプリは配信が終わったことを検知できず、購読を終えるべきか待ち続けるべきかを判断できない。PUBLISH_DONE による終了 (Status Code と Reason Phrase) をアプリへ通知する。

## 現状

- `src/createMediaSubscriber.ts` の `handlePublishDone` は、`resolvePublishDoneError` が返した Error を `onError` に渡すだけである。正常終了 (TRACK_ENDED 等) では `onStateChange` も `onClose` も呼ばず、state も変わらない
- 低レベル API は `SubscribeCallbacks.end` が Status Code と Reason Phrase を運ぶ (公開型 `PublishDoneInfo`)。高レベル API 側にその通知経路が無い
- catalog / 音声 / 映像の 3 つの購読すべてが同じ扱いである (同じ `handlePublishDone` を通る)

## 設計方針

- `src/codec/types.ts` の `MediaSubscriberCallbacks` に `onPublishDone?: (publishDone: PublishDoneInfo) => void` を足す。`PublishDoneInfo` は `src/session` の公開型を型 import する。引数は `PublishDoneInfo` のみとし、どの購読 (catalog / 音声 / 映像) が終わったかは区別しない (購読ごとに 1 回呼ばれる)
- 通知は購読ごとに 1 回だけにする。エラーを示さない Status Code (TRACK_ENDED / GOING_AWAY / EXPIRED) で `onPublishDone` を呼ぶ
- エラーを示す Status Code では `onPublishDone` を呼ばず、従来どおり `onError` を呼ぶ (終了通知と二重に通知しない)。catalog の購読で受信タイムアウト由来の `onError` が重なる件は `0843-bug-catalog-publish-done-wait.md` の範囲であり、本 issue では `onPublishDone` の追加で `onError` の呼び出しを増やさない
- 正常終了では state を変えず、`onStateChange` も `onClose` も呼ばない。`docs/HIGH_LEVEL_API.md` のコールバック節に `onPublishDone` を追加し、この契約を書く
- 対象外
  - 低レベル API の変更 (終了通知は完了済み)
  - セッション終了 (`markClosed`) の通知
  - catalog の受信待ちの解放 (エラー status は 0843 の範囲。正常終了の catalog PUBLISH_DONE で待ちをどうするかは本 issue では変えない)
  - `CHANGES.md` の更新 (CODEBASE.md の MOQT RFC ドラフト中の特別ルール)

## 完了条件

- 正常な PUBLISH_DONE で、アプリが Status Code と Reason Phrase を受け取れる
- エラーを示す Status Code では `onPublishDone` を呼ばず、`onError` だけを呼ぶ (二重通知にしない)。catalog の受信タイムアウト由来の `onError` は 0843 の範囲であり、本 issue では `onPublishDone` の追加で `onError` の呼び出しを増やさない
- 正常終了では `onStateChange` も `onClose` も呼ばず、state は変わらない
- `src/createMediaSubscriber.publish-done.test.ts` に、catalog / 音声 / 映像の 3 経路で正常終了の `onPublishDone` が購読ごとに 1 回だけ呼ばれるテストがある (旧 `src/createMediaSubscriber.test.ts` は 5 ファイルに分割済み)
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `src/createMediaSubscriber.ts` の `handlePublishDone` / `resolvePublishDoneError`
- `src/mediaSubscriber/catalogSubscription.ts` の catalog 購読の `end` (`handlePublishDone` を呼ぶ経路)
- `src/codec/types.ts` の `MediaSubscriberCallbacks`
- `src/session/publicTypes.ts` の `PublishDoneInfo` / `SubscribeCallbacks`
- `src/createMediaSubscriber.publish-done.test.ts` (catalog / 音声 / 映像の PUBLISH_DONE のテスト)
- `docs/HIGH_LEVEL_API.md` のコールバック節
- closed の `0840-change-subscriber-publish-done-reason.md` (低レベル API の終了通知)
- open の `0843-bug-catalog-publish-done-wait.md` (catalog のエラー status の PUBLISH_DONE と受信タイムアウトの二重通知)

## 解決方法

{未着手}
