# Object Properties の既知 Type serialization 不一致が §8.3 の KEY_VALUE_FORMATTING_ERROR にならない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-object-property-known-type-kvf
- Polished: 2026-09-12

## 目的

draft-ietf-moq-transport-21 §8.3 は「Key-Value-Pair is used in both the data plane and control plane」と明記したうえで、「If a receiver understands a Type, and the following Value or Length/Value does not match the serialization defined by that Type, the receiver MUST close the session with error code KEY_VALUE_FORMATTING_ERROR.」と定める。受信 Object の Object Properties (data plane) では、既知 Type の Value が仕様の serialization に一致しない場合でも寛容デコードが失敗を吸収して配信を継続し、セッションが閉じない。§11.1.3 にも Object Properties を例外とする規定はなく、§12.1 の malformed track (購読 / FETCH の cancel) は例示であって §8.3 の MUST を置き換えない。したがって **既知 Type の Value 不一致は KEY_VALUE_FORMATTING_ERROR でセッションを閉じる** と確定し、実装とテストを揃える。

## 現状

- Object Properties の受信は `decodeObjectPropertiesTolerant` (`src/properties.ts`) で行われ、同関数は decode 中のすべての例外を catch し、`complete: false` と途中まで読めた Property 列を返す。失敗した Key-Value-Pair は Property 列に現れない。
- 受信経路の検証は `assertNoMandatoryTrackPropertyInObjectProperties` が `assertObjectPropertyList` で行い、Mandatory Track Property (0x4000-0x7FFF) の混入と IMMUTABLE_PROPERTIES の複数出現・再帰、Prior Gap の複数出現を検証する。既知 Type の serialization 不一致は検証しない。
- 既知 Type の serialization 不一致を `SessionError(KEY_VALUE_FORMATTING_ERROR)` にする処理は `decodeKnownPropertyVarint` 経由の厳密デコーダ (`decodeProperties` 等) にのみあり、Object Properties 経路からは呼ばれない。
- 受信経路は `decodeObjectDatagram` / `decodeFetchObjectFields` / `decodeObjectFields` (`src/dataStream.ts`) と `processSubgroupObjects` (`src/session/stream.ts`) が上記の検証関数を呼ぶ。
- 寛容契約は closed 0360 / 0361 / 0379 / 0537 で意図的に維持されており、delta の不完全・未知 Type・Mandatory Track Property の混入などは「不正データで停止して読めた分のみ返す」または `MalformedTrackError` で扱う。この寛容契約は未知 Type (受信者が理解しない) と不完全データに対するものであり、既知 Type の MUST を免除するものではない。

## 設計方針

1. 既知 Type の serialization 不一致は `SessionError(KEY_VALUE_FORMATTING_ERROR)` でセッションを閉じる。根拠は §8.3 の既知 Type に関する MUST であり、data plane の Object Properties にも適用される (Key-Value-Pair は両プレーンで使われる)。コードコメントに節番号と文面を残す。
2. `decodeObjectPropertiesTolerant` の挙動は変えない (寛容デコードの契約を維持する)。closed 0537 が確立した方式に揃え、生バイト列を再走査する専用の検証関数を新設して既知 Type の不一致のみを検出する。
3. 検出対象は Value 側の不一致とする。既知 even Type (`KNOWN_PROPERTY_TYPES`) の Value が Properties Length の内側で varint として完結しない場合に `SessionError(KEY_VALUE_FORMATTING_ERROR)` を送出する。既知判定は `decodeKnownPropertyVarint` と同じ基準を使う。
4. 走査範囲は §11.1.3 の Properties Length で与えられる境界の内側に限定する。境界を越える Value は不一致として扱う。
5. 呼び出しは既存の検証と同じ箇所に置き、subgroup / datagram / FETCH のすべての受信経路で同一の判定にする。送出した `SessionError` は既存の受信経路の catch が `toSessionCloseError` でそのまま取り出し、セッションを閉じる既存経路に乗せる。
6. Length 宣言超過 (既知 odd Type の Length が宣言する Value が残りバイトを超える場合) は `issues/0587-bug-known-type-length-overrun-error.md` で扱う。本 issue では Value 側の不一致のみを対象とし、0587 の実装は本 issue の検証関数に残量検査を追加する形にする (実施順は 0586 → 0587)。
7. 未知 Type・不完全 delta の寛容継続は変更しない。既存の寛容契約テスト (未知 Type・delta 不完全で配信を継続する) はそのまま維持する。
8. テストは `src/properties.test.ts` (検証関数の単体) と、subgroup / datagram / FETCH の各経路のテストファイルに追加する。既知 Type の不一致で `SessionError(KEY_VALUE_FORMATTING_ERROR)` になること、未知 Type の不正 Value では従来どおり配信が継続することを検証する。

## 完了条件

- Object Properties に既知 Type の Value 不一致 (varint が Properties Length の内側で完結しない) を含む Object を subgroup / datagram / FETCH の各経路で受信したとき、セッションが KEY_VALUE_FORMATTING_ERROR で閉じること。
- 未知 Type の不正 Value と不完全 delta では、従来どおり読めた分の配信を継続すること (既存テストが変更なく通ること)。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.3 (Key-Value-Pair Structure) / §11.1.3 (Object Properties) / §12.1 (Malformed Tracks) / §12.2 (KEY_VALUE_FORMATTING_ERROR)
- `decodeObjectPropertiesTolerant` / `assertNoMandatoryTrackPropertyInObjectProperties` / `assertObjectPropertyList` / `decodeKnownPropertyVarint` / `KNOWN_PROPERTY_TYPES` (`src/properties.ts`)
- `decodeObjectDatagram` / `decodeFetchObjectFields` / `decodeObjectFields` (`src/dataStream.ts`) / `processSubgroupObjects` (`src/session/stream.ts`)
- `issues/closed/0537-bug-object-mandatory-track-property.md` (寛容契約を維持した専用検証の先例)
- `issues/closed/0360-change-object-properties-delta-encoding.md` / `issues/closed/0361-change-loc-object-properties-delta-encoding.md` / `issues/closed/0379-moqt-draft-19-delta-type-overflow-validation.md` (寛容契約の先行判断)
- `issues/0568-bug-prior-gap-duplicate-not-detected.md` (同じ Object Properties 検証関数の拡張)
- `issues/0587-bug-known-type-length-overrun-error.md` (Length 宣言超過。本 issue の検証関数に追加する)
