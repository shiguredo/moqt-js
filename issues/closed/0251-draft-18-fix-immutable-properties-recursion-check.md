# decodeProperties で IMMUTABLE_PROPERTIES の再帰検証が行われていない

- Priority: Low
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Completed: 2026-06-03
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`decodeProperties` で IMMUTABLE_PROPERTIES (0x0B) を受信した際に、再帰的な IMMUTABLE_PROPERTIES のネストを早期検出する。

## 優先度根拠

現在は `decodeImmutableProperties` や `parseProperties` といった高レベル関数でのみ再帰ネストが検出される。Track Properties の受信・保持のみを行うコードパスが存在する場合、再帰ネストは後続処理まで検出されない。軽微な設計改善。

## 現状

- `src/properties.ts:420-424` (`decodeImmutableProperties`): 再帰チェックあり (MalformedTrackError)
- `src/properties.ts:553-557` (`parseProperties` 内側ループ): 再帰チェックあり (MalformedTrackError)
- `src/properties.ts:629-663` (`decodeProperties`): 汎用デコーダ、再帰チェックなし

FETCH_OK や SUBSCRIBE_OK、PUBLISH の Track Properties は `decodeProperties` 経由でデコードされる。ここで再帰的な IMMUTABLE_PROPERTIES ネストがあっても検出されず、`Property[]` として保持される。後続の `supportsDynamicGroups` 等で `decodeImmutableProperties` が呼ばれるまでは検出されない。

## 設計方針

`decodeProperties` のループ内で、デコードされた ID が 0x0B (IMMUTABLE_PROPERTIES) かつ data プロパティが存在する場合、`decodeImmutableProperties` を呼び出して再帰チェックを強制する。

もしくは、`decodeProperties` は低レベルデコーダとしてそのまま維持し、呼び出し側で `parseProperties` を使用するように統一する。

## 解決方法

`src/properties.ts:657-686` (`decodeProperties`) に既に IMMUTABLE_PROPERTIES 再帰検証が実装されていることを確認した。内側 KVP を走査し、IMMUTABLE_PROPERTIES (0x0B) が再度現れた場合に `MalformedTrackError` を throw する。

## 完了条件

- `decodeProperties` 経由で IMMUTABLE_PROPERTIES を受信した場合、再帰ネストが早期に検出されること
- 既存の動作を壊さないこと

## 仕様引用

draft-ietf-moq-transport-18 Section 12.7 (Immutable Properties):

> IMMUTABLE_PROPERTIES MUST NOT recursively contain an IMMUTABLE_PROPERTIES
> property.
