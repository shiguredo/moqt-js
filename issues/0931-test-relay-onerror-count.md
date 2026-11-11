# 実リレー E2E で onError の回数と告知の失敗経路を検証していない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/test-relay-onerror-count
- Polished: {YYYY-MM-DD}

## 目的

`tests/e2e/relay/namespace-announcement.spec.ts` は、低レベルの `PUBLISH_NAMESPACE` の受理、`SUBSCRIBE_NAMESPACE` での `NAMESPACE` の受信、`close()` 後の `NAMESPACE_DONE` を実リレーで確認する。しかし高レベル API の `onError` の回数は検証していない。0889 で「確立後の失敗で `onError` は 1 回」に直した契約は、低レベルの単体テストと高レベルの配線テストで担っており、実リレーでは未検証である。実リレーに不正応答をさせるのは現実的でないが、正常系で `onError` が 0 回であること、観測可能な失敗経路では 1 回であることは固定できる。

## 現状

- `tests/e2e/relay/namespace-announcement.spec.ts` は低レベルの `PUBLISH_NAMESPACE` の受理と `NAMESPACE` / `NAMESPACE_DONE` を確認する
- `tests/e2e/main.ts` の `window.__moqtE2E` は Publisher / Subscriber / Fetch / namespace の告知 (低レベル) / namespace の購読をハンドルとして露出している
- 高レベルの `createMediaPublisher` の `announceNamespace` と `rendezvousTimeout` は個別の E2E で検証しているが、`onError` の回数は検証していない
- `issues/closed/0892-test-relay-discovered-namespace-subscribe.md` は発見した namespace の購読経路を扱う。本 issue は `onError` の回数と失敗経路に限定する
- `issues/0817-add-relay-tests.md` は実リレーの E2E を増やす横断的な issue である

## 設計方針

- 高レベルの告知を実リレーで駆動し、正常な確立・終了で `onError` が 0 回であることを固定する
- 実リレーで再現できる失敗経路では `onError` の回数を固定する。接続前に拒否する経路 (空 namespace など) は `onError` を通知しないため、回数の対象外とする
- 実リレーに不正応答をさせる必要がある経路は対象外とし、その旨を spec のコメントに明記する (低レベル単体と配線テストが担う)

## 完了条件

- 実リレー E2E で `onError` の回数を assert する spec を追加する
- 再現できない失敗経路を対象外とする理由を spec に書く
- `vp check` / `vp test --run` / `vp run e2e-test:relay` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `tests/e2e/relay/namespace-announcement.spec.ts`
- `tests/e2e/relay/pubsub.spec.ts`
- `tests/e2e/main.ts` の `window.__moqtE2E`
- `src/createMediaPublisher.ts` の `announceNamespace` / `notifyStartFailure`
- `docs/HIGH_LEVEL_API.md` の「namespace の告知 (announceNamespace)」

## pending にした理由

`.github/workflows/e2e-test.yml` は draft-23 対応のリレーが無いため relay project をスキップする。本 issue の `onError` 回数の assert は実リレー E2E でしか走らない。正常系 0 回は `tests/e2e/relay/namespace-announcement.spec.ts` の `errors` 空 assert で一部固定済みであり、残るのは失敗経路の回数固定と `e2e-test:relay` の通過である。
