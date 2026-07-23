# SUBSCRIPTION_FILTER を LOCATION_FILTER にリネームする (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-location-filter-rename
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で SUBSCRIPTION_FILTER パラメータ (Parameter Type 0x21) が LOCATION_FILTER にリネームされた (Section 10.2.9 LOCATION FILTER Parameter)。あわせて Section 5.1.2 の節タイトルも "Subscription Filters" から "Location Filters" に変わった (Range Filters の新設に伴う整理)。

コードポイント 0x21 と Filter Type の値 (0x1 Next Group Start / 0x2 Largest Object / 0x3 AbsoluteStart / 0x4 AbsoluteRange)、ワイヤフォーマットはすべて不変。純粋な名称変更である。

## 優先度根拠

ワイヤ互換であり動作に影響はないが、公開型 `SubscriptionFilter` を含む識別子・コメントが仕様の用語と乖離したままだと、draft-19 以降の仕様と突き合わせた保守・レビュー (polish-refs を含む) の妨げになる。急がないため Low。

## 現状

- `src/message/types.ts:171-173`: `MessageParameterType.SUBSCRIPTION_FILTER: 0x21`
- `src/message/types.ts:213-218`: `FilterType` (値は draft-19 でも不変)
- `src/message/parameter.ts:840-844`: `SubscriptionFilter` 型
- `src/message/parameter.ts:860-949`: `encodeSubscriptionFilter` / `decodeSubscriptionFilter` / `encodeSubscriptionFilterParameter` / `decodeSubscriptionFilterParameter`
- `src/message/parameter.ts:613-614`: `MESSAGE_PARAMETER_VALUE_ENCODING` の 0x21 エントリ (コメント "SUBSCRIPTION_FILTER")
- `src/session/params.ts:165-168`: `buildSubscribeParameters` での SUBSCRIPTION_FILTER 組み立て
- `src/index.ts:45`: `SubscriptionFilter` を公開 API として re-export
- `src/session.ts:401-414`: `SubscribeOptions.filter?: SubscriptionFilter`

## 設計方針

- 識別子を LOCATION_FILTER / `LocationFilter` 系にリネームする (`MessageParameterType.LOCATION_FILTER`、`LocationFilter` 型、encode / decode 関数名)
- コードポイント 0x21・Filter Type 値・ワイヤフォーマットは変更しない
- 公開型 `SubscriptionFilter` のリネームは破壊的 API 変更となるため、CHANGES.md に破壊的変更であることを明記する
- 仕様参照コメントを draft-19 Section 5.1.2 / 10.2.9 に更新する

## 完了条件

- コードベースに SUBSCRIPTION_FILTER / SubscriptionFilter の識別子が残っていないこと
- リネーム前後でエンコード結果 (ワイヤ表現) が不変であることをテストで確認していること
- lint / build / typecheck / 既存テストが通ること
