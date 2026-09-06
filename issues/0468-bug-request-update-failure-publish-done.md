# REQUEST_UPDATE 失敗時に PUBLISH_DONE (UPDATE_FAILED) を送信しない

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-request-update-publish-done
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.9.1 は REQUEST_UPDATE 失敗時に publisher が `PUBLISH_DONE` (`UPDATE_FAILED`) で購読を終了する MUST を定める。現状は `REQUEST_ERROR` のみで、対向の失敗待機が宙吊りになり相互運用が壊れる。

## 現状

- `src/session/bidi.ts` の publisher 側 REQUEST_UPDATE 拒否経路 (受信 PUBLISH 系のパラメータ検証・発行 PUBLISH 系の値検証・publisher 不在) はいずれも `REQUEST_ERROR` のみを返す。
- `src/session/publish.ts` の `publishSendPublishDone` は `TRACK_ENDED` 固定で `UPDATE_FAILED` を送る手段がない。
- 受信側は `UPDATE_FAILED` の定義 (`src/message/types.ts` の `PublishDoneStatusCode`) とエラー通知 (`src/subscriber.ts` の `handleEnd`) 済みで、送受信が非対称である。

## 設計方針

1. `publishSendPublishDone` に status 引数を追加し、`UPDATE_FAILED` を送れるようにする。
2. 全拒否経路で `REQUEST_ERROR` 応答後に `PUBLISH_DONE` (`UPDATE_FAILED`) を送信する。
3. FETCH 失敗時の stream reset、NAMESPACE 系失敗時の bidi close (同節後段) も合わせて実装する。

## 完了条件

- REQUEST_UPDATE 拒否時に `REQUEST_ERROR` と `PUBLISH_DONE` (`UPDATE_FAILED`) の両方が送出されること。
- 受信側の既存 `UPDATE_FAILED` 通知と round-trip すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.9.1 / §10.12
