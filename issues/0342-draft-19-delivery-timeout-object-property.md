# Delivery Timeout を Object Property としても扱えるようにする (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-delivery-timeout-object-property
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 Section 12.1 (SUBGROUP_DELIVERY_TIMEOUT) / Section 12.2 (OBJECT_DELIVERY_TIMEOUT) で、両プロパティが Track Property に加えて Object Property にもなった (draft-18 → 19 変更履歴 "Delivery timeouts are both Track and Object Properties (#1476)")。

draft-19 Section 12.1 / 12.2:

> is a Track and Object Property. It is a varint. ... As an Object
> Property on the first object in a subgroup, it overrides the
> Track-level value for that subgroup; it is ignored on any other
> object in the subgroup.

draft-18 では両者とも "is a Track Property." のみで、IANA テーブル (Section 15.8) の Scope も Track のみだった。draft-19 では Scope が "Track, Object" になっている。Property Type (0x02 / 0x06) は不変。

## 優先度根拠

additive な拡張であり、未対応でも相互運用は壊れない (Object Property は opaque なバイト列として素通しされる)。moqt-js は delivery timeout のタイマー実行自体を持たず値をパラメータとして中継するのみなので、実害は「subgroup 先頭オブジェクトでの上書き値をアプリケーションが読めない・書けない」に限られる。よって Low。

## 現状

- `src/properties.ts:74-97`: `TrackPropertyId` に `OBJECT_DELIVERY_TIMEOUT: 0x02n` / `SUBGROUP_DELIVERY_TIMEOUT: 0x06n` を定義。Object Property スコープの概念はない
- `src/session/params.ts:85-99` (Track Property) / `src/session/params.ts:170-184` (Message Parameter): 送信は Track Property / Message Parameter としてのみ
- `src/session.ts:247, 256, 418, 427`: SubscribeOptions / PublishOptions の `deliveryTimeout` / `subgroupDeliveryTimeout`
- `src/dataStream.ts:510-524`: 受信オブジェクトの properties は `Uint8Array` として opaque に扱い、個別のプロパティ ID を解釈していない。subgroup 先頭オブジェクトでの上書きは未実装

## 設計方針

- プロパティのスコープ定義 (Track / Object) を `src/properties.ts` に導入し、0x02 / 0x06 を両スコープで許可する
- publisher 側: subgroup 先頭オブジェクトの Object Properties に delivery timeout を書き込める API を追加する
- subscriber 側: subgroup 先頭オブジェクトの Object Properties から delivery timeout を読み取り、アプリケーションへ公開する (moqt-js はタイマー実行を持たないため、値の解釈・公開までを実装範囲とする)
- 「先頭以外のオブジェクトでは無視する」規則に沿って、先頭以外での受信値は解釈しない
- 仕様参照コメントを draft-19 Section 12.1 / 12.2 / 15.8 に更新する

## 完了条件

- subgroup 先頭オブジェクトに delivery timeout の Object Property を付けて送信し、受信側で読み取れるテストがあること
- 先頭以外のオブジェクトに付いた delivery timeout が無視されること
- lint / build / typecheck / 既存テストが通ること
