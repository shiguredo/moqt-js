# Largest Object が到着中であり得る前提で実装を確認する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-largest-object-arriving
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §3.1.4 は「Largest Object は到着中の Object を指し得る」ことを明確化した。§3.2 は、Largest Object を含む範囲の FETCH はその Object を完全に配送し、残りは利用可能になり次第届けると定める。LARGEST_OBJECT を「確定済みの最終値」として扱っている箇所がないか確認し、コメントに前提を残す。

## 現状

- `src/session/params.ts` の `extractLargestLocation` は SUBSCRIBE_OK / PUBLISH / REQUEST_UPDATE_OK などの LARGEST_OBJECT (0x09) を取り出す
- `src/subscriber.ts` の `setLargestLocation` は保持のみで再解決しない。`resolveLocationFilter` が明示的な再解決点で、SUBSCRIBE_OK / REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY / 受信 PUBLISH の各経路で呼ばれる。同じ内容の LOCATION_FILTER が再報告された場合は `isSameLocationFilter` で前進を防ぐ
- `src/fetcher.ts` / `src/session/stream.ts` は Largest Object を保持せず、FETCH_OK の End Location で完結する。終了位置を Largest Object にクランプする処理は無い
- `src/createMediaSubscriber.ts` の `catalogFetchFilter` は LARGEST_OBJECT が不明なときにフィルタを省略し、publisher 側の既定 (Largest Object まで) に委ねる
- Publisher 側の `PublisherImpl.recordLargestLocation` は送信のたびに Largest Object を更新し、REQUEST_OK / PUBLISH_STATE_NOTIFY に載せる
- コメントは v21 §9.20.18 (LARGEST OBJECT Parameter) などを参照している

## 設計方針

- 「Largest Object は後から進み得る」前提を、`extractLargestLocation` / `setLargestLocation` / `resolveLocationFilter` / `recordLargestLocation` の各コメントに明記し、参照を v22 §3.1.4 / §9.20.17 に更新する
- 一度解決した `resolvedFilterCache` を更新する契機 (REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY / PUBLISH の LARGEST_OBJECT) が §3.1.4 と整合することを確認する
- Fetch の「Largest Object を完全に配送する」規定は publisher / relay の責務であり、クライアントは FETCH_OK の End Location を信頼する現状のままでよいことを確認し、コメントに残す
- LARGEST_OBJECT を最終値と仮定している箇所が見つかった場合はテストで再現して修正する

## 完了条件

- 各利用箇所の確認結果と前提がコメントに記録されている
- LARGEST_OBJECT の更新が購読開始後に到着するケース (REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY) のテストが維持されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.1.4 (Largest Object) / §3.2 (Fetch) / §9.20.17 (LARGEST OBJECT Parameter)
- `src/session/params.ts` の `extractLargestLocation`
- `src/subscriber.ts` の `setLargestLocation` / `resolveLocationFilter`
- `src/publisher.ts` の `recordLargestLocation`
- `src/createMediaSubscriber.ts` の `catalogFetchFilter`

## 解決方法

{未着手}
