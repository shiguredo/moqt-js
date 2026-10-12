# devtools の publish 停止で購読が維持されることを実リレーで固定する e2e が無い

- Created: 2026-10-13
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-publish-stop-e2e
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools は、購読しているトラックが PUBLISH_DONE で終わっても購読とセッションを維持するようになった (closed 0839)。しかし実リレーで「publisher を停止 → subscriber のセッションと購読が維持される」経路を固定する e2e が無い。単体テストはフックの外へ切り出した `handleTrackEnd` までで、`startSubscribing` の `end` クロージャ (後始末しない配線) を通せない。配線が戻ると、0839 が直した不具合 (最後のフレームを失う / トラック 1 本の終了を配信の終了と誤認する) が再発する。

## 現状

- `tests/e2e/*.spec.ts` に `publisher-stop-button` を押すテストは 1 つも無い (grep で 0 件)
- devtools の e2e は publisher と subscriber をそれぞれ操作する spec を持つが、publisher の停止後に subscriber 側の購読状態を見ていない
- 実リレーへ接続する spec は `relay` project で、`TEST_MOQT_URI` が設定された環境でだけ実行される (`npx vp run e2e-test:relay`)
- `tests/e2e/relay/audio-catch-up.spec.ts` は publisher の停止を後始末にだけ使っており、購読の状態を assert していない

## 設計方針

- `relay` project に、devtools の publisher と subscriber をつないだ後で publisher を停止し、subscriber 側で次を固定する spec を追加する
  - `subscriber-status-message` が終了の理由 (Status Code と Reason Phrase) を含む (`video ended: ...` の形)
  - `subscriber-stop-button` が押せる (購読とセッションが維持されている)
  - 映像の canvas が空にならない (最後のフレームが保持される)
- 検証の後は、既存の spec と同じ形で publisher と subscriber を停止して後始末する
- `TEST_MOQT_URI` が無い環境では skip する (既存の relay spec と同じ)
- 対象外: ライブラリ (`createMediaSubscriber`) の購読終了の扱い (closed 0839 で完了)、relay 側の実装

## 完了条件

- `npx vp run e2e-test:relay` で新しい spec が通る (`TEST_MOQT_URI` 未設定の環境では skip する)
- publisher の停止後に、subscriber の Status の文言が終了の理由を含み、subscriber の Stop が押せることを assert している
- 停止と後始末を既存の relay spec と同じ形で行っている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed の `0839-bug-devtools-track-end-teardown.md` (トラック終了で購読とセッションを維持する)
- `tests/e2e/relay/audio-catch-up.spec.ts` / `tests/e2e/relay/support.ts` / `playwright.config.ts`
- `devtools/src/hooks/useSubscriber.ts` の `handleTrackEnd`
- `devtools/src/components/SubscriberPanel.tsx` の `subscriber-status-message` / `subscriber-stop-button`

## 解決方法

{未着手}
