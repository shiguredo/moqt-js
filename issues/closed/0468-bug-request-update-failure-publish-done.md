# REQUEST_UPDATE 失敗時に PUBLISH_DONE (UPDATE_FAILED) を送信しない

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-request-update-publish-done
- Polished: 2026-09-07

## 目的

draft-ietf-moq-transport-20 §10.9.1 は REQUEST_UPDATE 失敗時に publisher が `PUBLISH_DONE` (`UPDATE_FAILED`) で購読を終了する MUST を定める。現状は `REQUEST_ERROR` のみで、`UPDATE_FAILED` を待つ対向と整合しない恐れがある。

## 現状

- 自発 `PUBLISH` 系 (`bidiReadRequestStreamMessages` の publish ロール。ピア subscriber の `REQUEST_UPDATE` を自側 publisher が受ける) の `GOING_AWAY` (GOAWAY 受信済み。`goawayReceivedOnRequestStreams` の publish 分岐)、`INVALID_FILTER` (Range / Location 値違反)、`publisher not found` (`INTERNAL_ERROR`) はいずれも `REQUEST_ERROR` のみを返す。
- 受信 `PUBLISH` 系 (`bidiHandlePublishRequestUpdate`。ピア publisher の `REQUEST_UPDATE` を自側 subscriber が受ける) の拒否 (`NOT_SUPPORTED` 等) は `REQUEST_ERROR` のみが正しく、`PUBLISH_DONE` を送る立場にない (§10.12 は publisher のみが送信する) ため対象外とする。
- 最小再現手順は REQUEST_UPDATE 送信 → `REQUEST_ERROR` 受信 → `PUBLISH_DONE` 不受信で対向の終了待機が継続する、である。
- `src/session/publish.ts` の `publishSendPublishDone` は `TRACK_ENDED` 固定で `UPDATE_FAILED` を送る手段がない。
- 受信側は `UPDATE_FAILED` の定義 (`src/message/types.ts` の `PublishDoneStatusCode`) とエラー通知 (`src/subscriber.ts` の `handleEnd`) 済みで、送受信が非対称である。
- FETCH / NAMESPACE 系の REQUEST_UPDATE 失敗時処理 (§10.9.1 後段の reset / close) は responder 側の責務であり、自側が responder になる受信経路 (FETCH / NAMESPACE 系の REQUEST_UPDATE 受信) は存在しないため本 issue では扱わない (`0198` の追加実装不要の結論を維持する)。

## 設計方針

1. `publishSendPublishDone` に `PublishDoneStatusCode` 型の status 必須引数を追加し、`UPDATE_FAILED` を送れるようにする (既存呼び出し 1 箇所とテスト呼び出しは `TRACK_ENDED` で更新。後方互換の既定値は付けない)。`publisher not found` 時は `PublisherImpl` がないため、`requestId` と `streamCount` を直接受ける publisher-less な送信経路を追加する。`Error Reason` は現状どおり空のまま変えない。
2. 3 拒否経路 (`GOING_AWAY` / `INVALID_FILTER` / `publisher not found`) で `REQUEST_ERROR` 応答後に `PUBLISH_DONE` (`UPDATE_FAILED`) を送信する (§10.12 で `PUBLISH_DONE` が最終メッセージのため順序固定)。送信前に当該 subscription のデータストリームを閉じる (`done()` 経路の `closePublisherStream` 相当。`publisher not found` 等の開設なしの場合は不要)。`publisher not found` 時は開設ストリーム数の正確数を確定できないため Stream Count に `2^64 - 1` を入れる (§10.12 の MUST 後段)。

## 完了条件

- REQUEST_UPDATE 拒否時 (publish ロールの 3 経路) に `REQUEST_ERROR` の後に `PUBLISH_DONE` (`UPDATE_FAILED`) が送出されること。順序 (`REQUEST_ERROR` → `PUBLISH_DONE`) と `publisher not found` 時の Stream Count (`2^64 - 1`) を assert すること (`bidi.test.ts` 等で検証)。
- 受信側の `handleEnd` の `errorCallback` が `UPDATE_FAILED` で呼ばれること (送信側修正との round-trip)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.9.1 / §10.12

## 解決方法

- `src/session/publish.ts` の `publishSendPublishDone` に status 必須引数を追加し、publisher がない経路 `publishSendPublishDoneWithoutPublisher` を新設した（Stream Count 不明時は 2^64-1、Error Reason 空維持）
- `src/session/bidi.ts` の publish ロール 3 拒否経路で REQUEST_ERROR 応答後にデータストリームを閉じて PUBLISH_DONE (UPDATE_FAILED) を送信する。not-found 経路の送信も書き込み失敗黙殺に統一した
- `src/session/bidi.test.ts` に拒否 6 件のテストを追加し、順序・Stream Count・round-trip を検証した。旧挙動の既存 5 件を新挙動に更新した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
