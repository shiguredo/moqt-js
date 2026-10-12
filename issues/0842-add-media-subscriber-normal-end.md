# 高レベル API で正常な PUBLISH_DONE を検知できない

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/add-media-subscriber-normal-end
- Polished: {YYYY-MM-DD}

## 目的

moqt-js の高レベル API (`createMediaSubscriber`) は、publisher が PUBLISH_DONE (TRACK_ENDED 等) で購読を正常に終えても何も通知しない。`MediaSubscriberCallbacks` は `onStateChange` / `onCatalog` / `onError` / `onClose` だけを持ち、エラーを示す Status Code のときだけ `onError` が呼ばれる。アプリは配信が終わったことを検知できず、購読を終えるべきか待ち続けるべきかを判断できない。PUBLISH_DONE による終了 (Status Code と Reason Phrase) をアプリへ通知する。

## 現状

- `src/createMediaSubscriber.ts` の `handlePublishDone` は、`resolvePublishDoneError` が返した Error を `onError` に渡すだけである。正常終了 (TRACK_ENDED 等) では `onStateChange` も `onClose` も呼ばず、state も変わらない
- 低レベル API は `SubscribeCallbacks.end` が Status Code と Reason Phrase を運ぶ (公開型 `PublishDoneInfo`)。高レベル API 側にその通知経路が無い
- catalog / 音声 / 映像の 3 つの購読すべてが同じ扱いである (同じ `handlePublishDone` を通る)

## 設計方針

- `MediaSubscriberCallbacks` に終了通知を足すかを決める。足す場合の名前と引数は公開型 `PublishDoneInfo` に合わせる
- 通知は購読ごとに 1 回だけにする。エラーを示す Status Code では従来どおり `onError` を呼び、終了通知と二重に通知しない
- 正常終了で state をどうするかを決める。`onStateChange` の説明と `docs/HIGH_LEVEL_API.md` の記述を整合させる
- 対象外
  - 低レベル API の変更 (終了通知は完了済み)
  - セッション終了 (`markClosed`) の通知

## 完了条件

- 正常な PUBLISH_DONE で、アプリが Status Code と Reason Phrase を受け取れる
- エラーを示す Status Code では従来どおり `onError` が 1 回だけ呼ばれ、終了通知と二重にならない
- `src/createMediaSubscriber.test.ts` に catalog / 音声 / 映像の 3 経路のテストがある
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `src/createMediaSubscriber.ts` の `handlePublishDone` / `resolvePublishDoneError`
- `src/codec/types.ts` の `MediaSubscriberCallbacks`
- `src/session/publicTypes.ts` の `PublishDoneInfo` / `SubscribeCallbacks`
- `docs/HIGH_LEVEL_API.md` のコールバック節
- closed の `0840-change-subscriber-publish-done-reason.md` (低レベル API の終了通知)

## 解決方法

{未着手}
