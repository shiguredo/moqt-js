# NEW_GROUP_REQUEST 送信時に DYNAMIC_GROUPS Property を確認する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts:requestKeyframe` (および `subscribeOptions.newGroupRequest = 0n` で送信される SUBSCRIBE) は NEW_GROUP_REQUEST Parameter (Type 0x32) を含めて送信しているが、`draft-ietf-moq-transport-17 §9.3.11` の MUST NOT を確認していない:

> A subscriber MUST NOT send this parameter in PUBLISH_OK or REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS Property with value 1.

現在の実装では Catalog から得た Track の DYNAMIC_GROUPS Property を確認せず、無条件で NEW_GROUP_REQUEST を送信できてしまう。

## 根拠

- `refs/moq/draft-ietf-moq-transport-17.txt` §9.3.11 (3072-3074 行)
- `useSubscriber.ts:requestKeyframe` (`subscriberInstance.update({ parameters: [{ type: 0x32, value: new Uint8Array([0x01]) }] })`)
- `useSubscriber.ts:startSubscribing` の `subscribeOptions.newGroupRequest = 0n` も同じ仕様制約を満たす必要がある (SUBSCRIBE での送信は §9.3.11 が許可する経路と整合確認が要る)

## 修正方針

1. Catalog (`videoTrackFromCatalog`) または Subscriber インスタンスから DYNAMIC_GROUPS Property の値を取得する経路を確保する (moqt-js 側の API がなければ追加検討)
2. NEW_GROUP_REQUEST を送る前に値が 1 であることを確認し、満たさなければ Error を投げる (devtools UI で「Keyframe 要求」ボタンを disable するなどの対応も検討)
3. UI に DYNAMIC_GROUPS の値を表示する (Subscriber 状態の一部として)

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts:requestKeyframe`
- 必要に応じて `moqt-js` 側で `CatalogTrack` / `Subscriber` から DYNAMIC_GROUPS を露出する API 追加

## テスト戦略

- moqt-js 側の API 拡張が伴う場合は `tests/` 配下の e2e に「DYNAMIC_GROUPS なしの Track で NEW_GROUP_REQUEST が送信されない」シナリオを追加
- devtools 側は単体テストで `requestKeyframe` がガード条件を満たさない場合に Error / 早期 return することを検証

## CHANGES.md 記載方針

- `## develop` 直下に `[FIX]` で記載する (仕様 MUST NOT の準拠)

## 完了条件

- DYNAMIC_GROUPS が 1 でない Track に対して NEW_GROUP_REQUEST が送信されない
- 全テストパス
- `refs/moq/draft-ietf-moq-transport-17.txt` §9.3.11 の引用がコードコメントに記載されている
