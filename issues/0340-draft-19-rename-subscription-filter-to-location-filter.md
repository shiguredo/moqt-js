# SUBSCRIPTION_FILTER を LOCATION_FILTER にリネームする (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-location-filter-rename
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 の本文および IANA レジストリで、Parameter Type `0x21` の名称が `LOCATION_FILTER` になっている。本リポジトリの識別子・コメントは draft-18 由来の `SUBSCRIPTION_FILTER` / `SubscriptionFilter` のまま乖離している。

draft-19 Section 10.2.9 (LOCATION FILTER Parameter):

> The LOCATION_FILTER parameter (Parameter Type 0x21) uses length-
> prefixed encoding. It MAY appear in a SUBSCRIBE, PUBLISH_OK or
> REQUEST_UPDATE (for a subscription) message. It is a Location Filter
> (see Section 5.1.2).

> If omitted from SUBSCRIBE or PUBLISH_OK, the subscription is
> unfiltered. If omitted from REQUEST_UPDATE, the value is unchanged.

draft-19 Section 5.1.2 (Location Filters) の構造:

> Location Filter {
> Filter Type (vi64),
> [Start Location (Location),]
> [End Group Delta (vi64),]
> }

IANA Section 15.7 (Message Parameters) Table 13 も `0x21` → `LOCATION_FILTER` (Section 10.2.9)。

Appendix A.1 (Since draft-ietf-moq-transport-18) に本リネーム専用の bullet は無い。根拠は Change Log ではなく、draft-19 本文・IANA の確定名称に置く。

コードポイント `0x21`・Filter Type 値 (`0x1`–`0x4`)・ワイヤフォーマットは不変。純粋な識別子・コメントの名称変更である。公開型 `SubscriptionFilter` のリネームは破壊的 API 変更を伴う。

## 優先度根拠

ワイヤ互換であり動作に影響はないが、公開型 `SubscriptionFilter` を含む識別子・コメントが仕様用語と乖離したままだと、draft-19 以降の仕様と突き合わせた保守・レビューの妨げになる。ワイヤ非破壊の用語追従であり急がないため Low。

## 現状

識別子・コメントの主な残存箇所:

- `src/message/types.ts`: `MessageParameterType.SUBSCRIPTION_FILTER: 0x21`。同ファイルの公開定数 `FilterType`（値 `0x1`–`0x4` は不変。実装の encode / decode が参照するのは `parameter.ts` 内の非公開 `FILTER_TYPE`）と JSDoc「Subscription Filters」
- `src/message/parameter.ts`: `SubscriptionFilter` 型、`encodeSubscriptionFilter` / `decodeSubscriptionFilter` / `encodeSubscriptionFilterParameter` / `decodeSubscriptionFilterParameter`。`MESSAGE_PARAMETER_VALUE_ENCODING` の `0x21` エントリコメント。encode / decode Parameter 双方が type に数値リテラル `0x21` を使用
- `src/message/parameterScope.ts`: SUBSCRIBE / PUBLISH_OK / REQUEST_UPDATE の許可集合で `MessageParameterType.SUBSCRIPTION_FILTER`
- `src/message/index.ts`: 型・encode / decode の re-export
- `src/index.ts`: `export type { SubscriptionFilter, ... }`（パッケージ公開面。`package.json` exports は `"."` のみ）
- `src/session.ts`: `SubscribeOptions.filter?: SubscriptionFilter`。JSDoc に「Subscription Filter」および誤った `Section 10.2.11` 参照（正: 10.2.9）
- `src/session/params.ts`: `buildSubscribeParameters` が `encodeSubscriptionFilterParameter` を呼ぶ
- `src/subscriber.ts`: JSDoc コメント内の `SUBSCRIPTION_FILTER`
- `src/message/parameter.test.ts`: `decodeSubscriptionFilter*` の import とエラー系テスト
- `src/message/parameter.prop.ts` / `src/session.prop.ts`: 型・関数名・テスト名・`subscriptionFilterArb`
- `README.md`: Subscriber 機能一覧に「Subscription Filter (...)」が 4 行残る

`devtools/` / `examples/` に旧識別子は無い（変更不要）。`CHANGES.md` の過去エントリ・`issues/` 内の旧名は歴史記録のため対象外。`dataStream.ts` の Object Status 系 `0x21` や各 `*.prop.ts` の GREASE / パラメータ型リテラル `0x21` は別用途であり、数値置換しない。

## 設計方針

- 識別子を LOCATION_FILTER / `LocationFilter` 系にリネームする:
  - `MessageParameterType.LOCATION_FILTER`
  - `LocationFilter`（Section 5.1.2 の構造名に対応）
  - `encodeLocationFilter` / `decodeLocationFilter`
  - `encodeLocationFilterParameter` / `decodeLocationFilterParameter`
- コードポイント `0x21`・Filter Type 値・ワイヤフォーマット・未知 Filter Type → `ProtocolViolationError`（closed `#0330`）・`parameterScope` の許可集合の意味は変更しない
- `FilterType` 定数名と判別ユニオン文字列 (`"NextGroupStart"` 等) は維持し、コメントだけ Location Filters に更新する
- `encodeLocationFilterParameter` / `decodeLocationFilterParameter` の type 判定はどちらも `MessageParameterType.LOCATION_FILTER`（値 `0x21`）に揃える
- 公開破壊面は主に `SubscriptionFilter` → `LocationFilter` と、それに追随する `SubscribeOptions.filter` の注釈型。互換エイリアスは置かない。`CHANGES.md` の `## develop` に `[CHANGE]` で明記する（内部の encode / decode・`MessageParameterType` も追随する旨を一行添えてよい）
- 本変更で編集する箇所の識別子・散文コメント（`Subscription Filter` / `SUBSCRIPTION FILTER` 等）・arbitrary 名はここで `LOCATION_FILTER` / `LocationFilter` / `locationFilterArb` 系に揃える。同一ファイル内でも本リネームと無関係な `draft-ietf-moq-transport-18` 参照は触らず `#0343` に残す
- `#0334`（同一 Track 複数 subscription）との順序: 0334 はリネーム未完了なら旧名のまま触り、本 issue が後で揃える。本 issue は 0334 の多重化・filter 再適用を扱わない
- `#0341`（Range Filters）は扱わない
- SUBSCRIBE_TRACKS への LOCATION_FILTER 送信 API・許可集合追加は扱わない。`#0336` は「リネーム・SUBSCRIBE_TRACKS 対応」を本 issue に委譲しているが、本 issue のスコープはリネームに限定する。SUBSCRIBE_TRACKS での Location Filter 対応は `#0336` 側の境界修正（または別 issue）とする。Section 10.2.9 の MAY 列挙は SUBSCRIBE / PUBLISH_OK / REQUEST_UPDATE のみ（Section 10.19.1 の包括規則との解釈は 0336 / 別 issue の領域）

## 完了条件

- 本 issue の変更対象ファイル（`types.ts` / `parameter.ts` / `parameterScope.ts` / `message/index.ts` / `src/index.ts` / `session.ts` / `session/params.ts` / `subscriber.ts` / `parameter.test.ts` / `parameter.prop.ts` / `session.prop.ts` / `README.md`）から次が消えていること:
  - 識別子: `SUBSCRIPTION_FILTER` / `SubscriptionFilter` / `encodeSubscriptionFilter*` / `decodeSubscriptionFilter*` / `subscriptionFilterArb`
  - 散文: `Subscription Filter` / `Subscription Filters` / `SUBSCRIPTION FILTER`
  - 過去の `CHANGES.md` 履歴エントリ・`issues/` は対象外
- `src/message/parameter.prop.ts` で `LocationFilter` の encode / decode ラウンドトリップと `param.type === MessageParameterType.LOCATION_FILTER`（値 `0x21`）が維持されていること。リネーム後に旧シンボルは無いので「リネーム前後バイト比較」は不要
- `CHANGES.md` の `## develop` に公開 API 破壊を含む `[CHANGE]` があること（例: `[CHANGE] SUBSCRIPTION_FILTER を LOCATION_FILTER にリネームする`。`SubscriptionFilter` → `LocationFilter` を箇条書き）
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/message/types.ts`: `SUBSCRIPTION_FILTER` → `LOCATION_FILTER`（値 `0x21` 維持）。当該定数・`FilterType` の JSDoc を Section 10.2.9 / 5.1.2 (Location Filters) に更新
2. `src/message/parameter.ts`: 型・encode / decode 4 関数を `LocationFilter` 系にリネーム。`MESSAGE_PARAMETER_VALUE_ENCODING` の `0x21` コメントを更新。`encodeLocationFilterParameter` / `decodeLocationFilterParameter` の type をどちらも `MessageParameterType.LOCATION_FILTER` に揃える。仕様コメントを draft-19 Section 5.1.2 / 10.2.9 に更新。未知 Filter Type の `ProtocolViolationError` は維持
3. `src/message/parameterScope.ts`: 許可集合 3 箇所を `MessageParameterType.LOCATION_FILTER` に更新
4. `src/message/index.ts` / `src/index.ts`: re-export を新名に合わせる（公開は型 `LocationFilter`）
5. `src/session.ts`: import・`SubscribeOptions.filter` の型・JSDoc を更新（Section 5.1.2 / 10.2.9。誤った 10.2.11 を削除）
6. `src/session/params.ts`: `encodeLocationFilterParameter` 呼び出しとコメント更新
7. `src/subscriber.ts`: JSDoc 内の旧パラメータ名を置換
8. `src/message/parameter.test.ts` / `parameter.prop.ts` / `src/session.prop.ts`: 識別子・テスト名・`locationFilterArb` を新名へ追従。PBT で `MessageParameterType.LOCATION_FILTER`（`0x21`）とラウンドトリップを維持
9. `README.md`: Subscriber 機能一覧の「Subscription Filter (...)」を「Location Filter (...)」に更新
10. `CHANGES.md`: `[CHANGE] SUBSCRIPTION_FILTER を LOCATION_FILTER にリネームする` を追記（公開型破壊を箇条書き）
11. `vp check` / `tsc --noEmit` / `vp test run` で確認
