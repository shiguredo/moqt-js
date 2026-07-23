# SUBSCRIPTION_FILTER を LOCATION_FILTER にリネームする (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-location-filter-rename
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で SUBSCRIPTION_FILTER パラメータ (Parameter Type `0x21`) が LOCATION_FILTER にリネームされた。

- パラメータ定義: Section 10.2.9 (LOCATION FILTER Parameter)
- フィルタ意味論: Section 5.1.2 (Location Filters)

draft-19 Section 10.2.9:

> The LOCATION_FILTER parameter (Parameter Type 0x21) uses length-
> prefixed encoding. It MAY appear in a SUBSCRIBE, PUBLISH_OK or
> REQUEST_UPDATE (for a subscription) message. It is a Location Filter
> (see Section 5.1.2).

Filter Type の値は不変:

- Next Group Start (`0x1`)
- Largest Object (`0x2`)
- AbsoluteStart (`0x3`)
- AbsoluteRange (`0x4`)

未知の Filter Type を受けたエンドポイントは PROTOCOL_VIOLATION でセッションを閉じる (Section 5.1.2)。コードポイント `0x21` とワイヤフォーマットも不変で、純粋な名称変更である。

## 優先度根拠

ワイヤ互換であり動作に影響はないが、公開型 `SubscriptionFilter` を含む識別子・コメントが仕様用語と乖離したままだと、draft-19 以降の仕様と突き合わせた保守・レビューの妨げになる。急がないため Low。

## 現状

- `src/message/types.ts`: `MessageParameterType.SUBSCRIPTION_FILTER: 0x21`
- `src/message/types.ts`: `FilterType` (値は draft-19 でも不変)
- `src/message/parameter.ts`: `SubscriptionFilter` 型、encode / decode 関数群
- `src/message/parameter.ts`: `MESSAGE_PARAMETER_VALUE_ENCODING` の 0x21 エントリ
- `src/session/params.ts`: `buildSubscribeParameters` での組み立て
- `src/index.ts`: `SubscriptionFilter` を公開 API として re-export
- `src/session.ts`: `SubscribeOptions.filter?: SubscriptionFilter`

## 設計方針

- 識別子を LOCATION_FILTER / `LocationFilter` 系にリネームする (`MessageParameterType.LOCATION_FILTER`、`LocationFilter` 型、encode / decode 関数名)
- コードポイント `0x21`・Filter Type 値・ワイヤフォーマットは変更しない
- 公開型 `SubscriptionFilter` のリネームは破壊的 API 変更となるため、CHANGES.md に破壊的変更であることを明記する
- 仕様参照コメントを draft-19 Section 5.1.2 (Location Filters) / Section 10.2.9 (LOCATION FILTER Parameter) に更新する

## 完了条件

- コードベースに SUBSCRIPTION_FILTER / SubscriptionFilter の識別子が残っていないこと
- リネーム前後でエンコード結果 (ワイヤ表現) が不変であることをテストで確認していること
- lint / build / typecheck / 既存テストが通ること
