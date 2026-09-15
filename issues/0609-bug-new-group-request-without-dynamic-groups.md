# REQUEST_UPDATE の NEW_GROUP_REQUEST が DYNAMIC_GROUPS を検査しない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-new-group-request-dynamic-groups
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.20.20 は、Track が DYNAMIC_GROUPS Property を値 1 で含まない限り REQUEST_UPDATE に NEW_GROUP_REQUEST を送ってはならない (MUST NOT) と定める。現状は公開 API から無条件に送信でき、SUBSCRIBE での送信 (適法) と更新経路での送信 (違法になりうる) が区別されていない。

## 現状

- `bidiSendRequestUpdate` (`src/session/bidi.ts`) は `options.newGroupRequest` を検査せずに NEW_GROUP_REQUEST (0x32) を送る
- raw パラメータ経由の 0x32 も同様に検査されない
- `SubscriberImpl` は `trackProperties` を保持しており、`supportsDynamicGroups` (`src/properties.ts`) で DYNAMIC_GROUPS=1 を判定できる
- 高レベル経路の `createMediaSubscriber` は `supportsDynamicGroups` を使って判定しているが、下位の公開 API では MUST が担保されない

draft-ietf-moq-transport-21 §9.20.20:

> A subscriber MUST NOT send this parameter in REQUEST_UPDATE if the Track did not include the DYNAMIC_GROUPS Property with value 1. A subscriber MAY include this parameter in SUBSCRIBE without foreknowledge of support.

## 設計方針

- `bidiSendRequestUpdate` で 0x32 を送る前に、型付きと raw の双方について `supportsDynamicGroups(subscriber.trackProperties)` を検査し、偽ならローカル API 誤用として拒否する
- SUBSCRIBE 経路は §9.20.20 が foreknowledge なしの送信を認めるため対象外とする
- DYNAMIC_GROUPS は Immutable Properties 配下にも置けるため、`supportsDynamicGroups` の二重検索をそのまま使う

## 完了条件

- DYNAMIC_GROUPS=1 を受けていない購読で `update({ newGroupRequest })` が拒否される
- DYNAMIC_GROUPS=1 を受けている購読では送信できる
- SUBSCRIBE での送信は従来どおり可能
- raw パラメータ経由の 0x32 も同じ検査を受ける
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.20.20 (NEW GROUP REQUEST Parameter)
- draft-ietf-moq-transport-21 §10.6 (DYNAMIC GROUPS)
- draft-ietf-moq-transport-21 §10.7 (Immutable Properties)
