# Object Properties の既知 Type serialization 不一致が §8.3 の KEY_VALUE_FORMATTING_ERROR にならない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-object-property-known-type-kvf
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §8.3 は「If a receiver understands a Type, and the following Value or Length/Value does not match the serialization defined by that Type, the receiver MUST close the session with error code KEY_VALUE_FORMATTING_ERROR.」と定め、Key-Value-Pair は data plane と control plane の両方で使われると明記する。受信 Object の Object Properties (data plane) では、既知 Type の Value / Length が仕様の serialization に一致しない場合でも寛容デコードが失敗を吸収して配信を継続し、セッションが閉じない。§8.3 の MUST に対する適合方法 (KEY_VALUE_FORMATTING_ERROR とするか §12.1 の malformed track とするか) を一次資料に基づき確定し、実装とテストを揃える。

## 現状

- Object Properties の受信は `decodeObjectPropertiesTolerant` (`src/properties.ts`) で行われ、同関数は decode 中のすべての例外を catch し、`complete: false` と途中まで読めた Property 列を返す。失敗した Key-Value-Pair は Property 列に現れない。
- 受信経路の検証は `assertNoMandatoryTrackPropertyInObjectProperties` が `assertObjectPropertyList` で行い、Mandatory Track Property (0x4000-0x7FFF) の混入と IMMUTABLE_PROPERTIES の複数出現・再帰のみを検証する。既知 Type の serialization 不一致は検証しない。
- 既知 Type の serialization 不一致を `SessionError(KEY_VALUE_FORMATTING_ERROR)` にする処理は `decodeKnownPropertyVarint` 経由の厳密デコーダ (`decodeProperties` 等) にのみあり、Object Properties 経路からは呼ばれない。
- 受信経路は `decodeObjectDatagram` / `decodeFetchObjectFields` / `decodeObjectFields` (`src/dataStream.ts`) と `processSubgroupObjects` (`src/session/stream.ts`) が上記の検証関数を呼ぶ。
- 寛容契約は closed 0360 / 0361 / 0379 / 0537 で意図的に維持されており、delta の不完全・未知 Type・Mandatory Track Property の混入などは「不正データで停止して読めた分のみ返す」または `MalformedTrackError` で扱う。既知 Type の serialization 不一致をどう扱うかは未決定である。

## 設計方針

1. 一次資料 (§8.3 / §11.1.3 / §12.1) を読み、Object Properties の既知 Type 不一致を (a) KEY_VALUE_FORMATTING_ERROR でセッションを閉じる、(b) malformed track として購読 / FETCH を cancel する、(c) 現状の寛容継続を維持する、のいずれにするか決定し、根拠をコメントに残す。
2. 実装する場合は、既存の寛容契約 (未知 Type・delta の不完全で配信を継続する) と、既知 Type の検証を分離する。closed 0537 が確立した「寛容デコードの契約を変えず、専用の検証関数で検出する」方式に揃える。
3. `decodeObjectPropertiesTolerant` は失敗した Key-Value-Pair を結果に残さないため、既知 Type の不一致検出には生バイト列の再走査が必要になる点を設計に織り込む。Object Properties は §11.1.3 の Properties Length で境界が既知であるため、走査範囲はその内側に限定する。
4. subgroup / datagram / FETCH のすべての Object 受信経路で同一の判定になるようにする。
5. 既存の寛容契約のテスト (未知 Type・delta 不完全で継続) は変更しない。

## 完了条件

- Object Properties の既知 Type serialization 不一致の扱いが決定され、コード・コメント・テストに反映されていること。
- subgroup / datagram / FETCH の各経路で同一の結果になるテストがあること。
- 既存の寛容契約 (未知 Type・delta 不完全で配信を継続する) のテストが維持されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- コード変更を伴う場合は `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.3 (Key-Value-Pair Structure) / §11.1.3 (Object Properties) / §12.1 (Malformed Tracks) / §12.2 (KEY_VALUE_FORMATTING_ERROR)
- `decodeObjectPropertiesTolerant` / `assertNoMandatoryTrackPropertyInObjectProperties` / `assertObjectPropertyList` / `decodeKnownPropertyVarint` (`src/properties.ts`)
- `decodeObjectDatagram` / `decodeFetchObjectFields` / `decodeObjectFields` (`src/dataStream.ts`) / `processSubgroupObjects` (`src/session/stream.ts`)
- `issues/closed/0537-bug-object-mandatory-track-property.md` (寛容契約を維持した専用検証の先例)
- `issues/closed/0360-change-object-properties-delta-encoding.md` / `issues/closed/0361-change-loc-object-properties-delta-encoding.md` / `issues/closed/0379-moqt-draft-19-delta-type-overflow-validation.md` (寛容契約の先行判断)
- `issues/0568-bug-prior-gap-duplicate-not-detected.md` (同じ Object Properties 検証関数の拡張)
