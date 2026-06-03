# PublishOk 型と encodePublishOkPayload を削除する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

PUBLISH_OK (0x1E) 削除に伴い、`PublishOk` 型と `encodePublishOkPayload` 関数が不要になった。これらは `RequestOk` / `encodeRequestOkPayload` と同一であり、PBT テストからのみ参照されている。

## 優先度根拠

デッドコードの削除。保守性向上。

## 現状

- `src/message/publish.ts:37-48`: `PublishOk` interface — `RequestOk` と同一のシグネチャ
- `src/message/publish.ts:152-166`: `encodePublishOkPayload` — `encodeRequestOkPayload` で代替可能
- `src/message/index.ts:105,109`: re-export

## 設計方針

- `PublishOk` を削除し PBT テスト (`publish.prop.ts`) を `RequestOk` に移行する
- `encodePublishOkPayload` を削除し `encodeRequestOkPayload` に移行する
- `index.ts` の re-export を削除する

## 完了条件

- `PublishOk` 型と `encodePublishOkPayload` が存在しない
- 全テストが PASS する
