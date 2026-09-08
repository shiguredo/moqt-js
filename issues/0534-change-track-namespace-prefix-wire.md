# TRACK_NAMESPACE_PREFIX のワイヤ形式から外側 Length を削除する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/change-track-namespace-prefix-wire
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-20 §10.2.20 に適合させ、TRACK_NAMESPACE_PREFIX (0x34) の送受信を他実装と相互運用可能にする。現状は外側 Length を付与しており、仕様準拠のピアと namespace を破壊し合う。

## 現状

- `src/message/parameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` が 0x34 を `"length-prefixed"` として扱い、`encodeMessageParameter` が `Value` の前に Length を付与する。
- `encodeParameterTrackNamespace` / `getParameterTrackNamespace` は `encodeTrackNamespace` / `decodeTrackNamespace` の出力を Value として扱う。
- 仕様 §10.2.20 は「The TRACK_NAMESPACE_PREFIX parameter (Parameter Type 0x34) uses the Track Namespace encoding described in Section 2.4.1.」とのみ定める。Length 前置を明示するのは §10.2.2 AUTHORIZATION TOKEN、§10.2.9 LOCATION FILTER、§10.2.15 FILL PARAMETERS だけであり、0x34 にはその記述がない。
- Track Namespace は §2.4.1 の「Number of Track Namespace Fields + 各フィールドの Length + Value」で自己区切りになるため、外側 Length は不要。
- 結果として、送信ワイヤは `Type Delta + 外側 Length + Track Namespace` となり、仕様準拠の受信側は外側 Length をフィールド数と誤解釈する。

## 設計方針

1. `MESSAGE_PARAMETER_VALUE_ENCODING` に 0x34 専用の自己区切り種別（仮称 `"track-namespace"`）を追加し、外側 Length を付与せず `encodeTrackNamespace` の出力をそのまま Value として書く。
2. デコードは同種別で `decodeTrackNamespace` を呼び、その消費バイト数で次の Type Delta の位置を確定する。`getParameterTrackNamespace` は `decodeTrackNamespace` をそのまま使う。
3. 実装前に他実装（moq-rs 等）が送る 0x34 の実バイトを確認し、`Type Delta + Track Namespace` で一致することを確かめる。仕様文面の解釈が確定しない場合は、ワイヤを固定バイト列でピン留めするテストを先に書いて合意を取る。
4. `self-length-prefixed`（LOCATION_FILTER / Range Filter）と混同しないよう、種別の意味をコメントに明記する。

## 完了条件

- 0x34 のエンコード結果が `Type Delta (vi64) + Track Namespace`（外側 Length なし）になること。
- 0x34 のデコードが外側 Length を要求せず、Track Namespace を復元できること。
- 固定バイト列のワイヤテストと round-trip テストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2.20 / §10.2 / §2.4.1
- `MESSAGE_PARAMETER_VALUE_ENCODING` / `encodeMessageParameter` / `decodeMessageParameter`
- `encodeParameterTrackNamespace` / `getParameterTrackNamespace`
- `bidiSendNamespaceRequestUpdate`（`src/session/bidi.ts`）
