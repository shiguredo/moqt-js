# TRACK_NAMESPACE_PREFIX のワイヤ形式から外側 Length を削除する

- Created: 2026-09-08
- Completed: 2026-09-08
- Branch: feature/change-track-namespace-prefix-wire
- Polished: 2026-09-08

## 目的

draft-ietf-moq-transport-20 §10.2.20 に適合させ、TRACK_NAMESPACE_PREFIX (0x34) の送受信を他実装と相互運用可能にする。現状は外側 Length を付与しており、仕様準拠のピアと namespace を破壊し合う。

## 現状

- `src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` が 0x34 を `"length-prefixed"` として扱い、`encodeMessageParameter` が `Value` の前に外側 Length を付与する。
- `encodeParameterTrackNamespace` / `getParameterTrackNamespace` は `encodeTrackNamespace` / `decodeTrackNamespace` の出力を Value として扱う。
- 仕様 §10.2.20 は「The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the Track Namespace encoding described in Section 2.4.1.」とのみ定める。外側 Length を明示するのは §10.2.2 AUTHORIZATION TOKEN と §10.2.15 FILL PARAMETERS であり、§10.2.9 LOCATION FILTER は構造の内部に Length を持つ自己区切りである。0x34 にはいずれの Length 記述もない。
- Track Namespace は §2.4.1 の「Number of Track Namespace Fields + 各フィールドの Length + Value」で自己区切りになるため、外側 Length は不要。
- 結果として、送信ワイヤは `Type Delta + 外側 Length + Track Namespace` となり、仕様準拠の受信側は外側 Length をフィールド数と誤解釈する。
- `issues/closed/0233-draft-18-add-track-namespace-prefix-parameter.md` が同じ仕様文に対して `"length-prefixed"` を採用したため、本 issue はその判断を仕様文面に基づいて反転させる。`issues/closed/0229-draft-18-add-track-namespace-prefix-parameter.md` は同じ `"track-namespace"` 種別を提案していたが、受信経路が無いことを理由に未実装で closed になっている。

## 設計方針

1. `MESSAGE_PARAMETER_VALUE_ENCODING` に 0x34 専用の自己区切り種別（仮称 `"track-namespace"`）を追加し、外側 Length を付与せず `encodeTrackNamespace` の出力をそのまま Value として書く。
2. デコードは同種別で `decodeTrackNamespace` を呼び、その消費バイト数で次の Type Delta の位置を確定する。`getParameterTrackNamespace` は `decodeTrackNamespace` をそのまま使う。
3. `self-length-prefixed`（LOCATION_FILTER / Range Filter）と混同しないよう、種別の意味をコメントに明記する。
4. PBT の arbitrary を更新する。`src/message/parameter.prop.ts` と `src/message/subscribe.prop.ts` の `lengthPrefixedParameterArb` は 0x34 に任意バイト列を生成しているため、0x34 は `encodeParameterTrackNamespace` で妥当な Track Namespace を生成する専用 arb に分離する。`parameter.prop.ts` のコメントにある 0x21 の分類誤記も直す。

## 完了条件

- 0x34 のエンコード結果が `Type Delta (vi64) + Track Namespace`（外側 Length なし）になること。
- 0x34 のデコードが外側 Length を要求せず、Track Namespace を復元できること。
- 固定バイト列のワイヤテストと round-trip テストが通ること。
- PBT（`parameter.prop.ts` / `subscribe.prop.ts`）が 0x34 で妥当な Track Namespace を生成して通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.20 / §10.2 / §2.4.1
- `MESSAGE_PARAMETER_VALUE_ENCODING` / `encodeMessageParameter` / `decodeMessageParameter`
- `encodeParameterTrackNamespace` / `getParameterTrackNamespace`
- `bidiSendNamespaceRequestUpdate`（`src/session/bidi.ts`）
- `src/message/parameter.prop.ts` / `src/message/subscribe.prop.ts`
- `issues/closed/0229-draft-18-add-track-namespace-prefix-parameter.md` / `issues/closed/0233-draft-18-add-track-namespace-prefix-parameter.md`

## 解決方法

- `src/message/parameter.ts` の `MessageParameterValueEncoding` に `"track-namespace"` を追加し、`MESSAGE_PARAMETER_VALUE_ENCODING` の 0x34 を `"length-prefixed"` から `"track-namespace"` に変更した。`encodeMessageParameter` は外側 Length を付与せず `encodeTrackNamespace` の出力をそのまま Value として書く。
- `decodeMessageParameter` に `track-namespace` 分岐を追加し、`decodeTrackNamespace` の消費バイト数で次の Type Delta の位置を確定する。`getParameterTrackNamespace` は従来どおり `decodeTrackNamespace(param.value)` を使う。
- `src/message/parameter.prop.ts` / `src/message/subscribe.prop.ts` の PBT arbitrary から 0x34 を `lengthPrefixedParameterArb` から外し、妥当な Track Namespace を生成する `trackNamespaceParameterArb` を追加した。`parameter.prop.ts` の 0x21 の分類誤記も直した。
- `src/message/parameter.test.ts` に外側 Length なしの固定バイト列テスト（encode / decode）と、`track-namespace` 分岐の破損系テストを追加した。
- `src/message/types.ts` と `encodeParameterTrackNamespace` / `getParameterTrackNamespace` の JSDoc に「外側 Length を付加しない」を明記した。
- `CHANGES.md` の `## develop` に `[CHANGE]` を追記した。
- 検証: `vp check` / `tsc --noEmit` / `vp test run`（1804 tests）が通る。
