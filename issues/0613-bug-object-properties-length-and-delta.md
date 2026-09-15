# Object Properties の Length 上限と Delta overflow を検証しない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-object-properties-length-and-delta
- Polished: 2026-09-15

## 目的

draft-ietf-moq-transport-21 §8.3 の Key-Value-Pair はデータプレーンにも適用される。Delta Type の累積が 2^64-1 を超える場合と、奇数 Type の Length が 2^16-1 を超える場合にセッションを閉じる MUST が定められているが、Object Properties 経路はどちらも検証しない。壊れた・悪意あるピアに対して仕様が要求するセッション終了を行えない。

## 現状

- `decodeObjectPropertiesTolerant` と `assertKnownPropertyValueInObjectProperties` (`src/properties.ts`) は、delta の累積上限と Length 上限を検査しない。`decodeObjectPropertiesTolerant` は寛容デコーダであり、JSDoc に「Delta Type オーバーフロー / Length 上限などの §8.3 の MUST 検証は行わない」と明記されている。`assertKnownPropertyValueInObjectProperties` の JSDoc にも「delta のオーバーフローと Length 上限 (2^16-1 超) の検証は本関数の対象外とする」と明記されている
- delta の累積上限 (`MAX_VARINT` との比較) は `decodeProperties` / `parseProperties` / `decodeImmutableProperties` の 3 つが検査しており、Object Properties 経路だけが検査しない。Track Properties と Object Properties で非対称
- Length 上限 (2^16-1 超) は `decodeProperties` が全奇数 Type について検査する。`decodeImmutableProperties` は自身 (IMMUTABLE_PROPERTIES コンテナ) の Length で検査し、内側の KVP は外側 Length が 65535 以下であることから間接的に上限内に収まる。`parseProperties` は IMMUTABLE_PROPERTIES の外側 Length と内側 KVP だけを検査し、汎用奇数分岐には Length 上限の検査がない
- 呼び出し元は Object Datagram / Subgroup Object / Fetch Object の 3 経路 (`decodeObjectDatagram` / `decodeObjectFields` / `decodeFetchObjectFields`)
- 上限超過でも宣言 Length が残りバイト内に収まっていれば素通りする。`assertKnownPropertyValueInObjectProperties` は残量検査が先にあり、上限超過の判定は「既知 Type かつ上限内」のときにだけ発火する条件 (`isKnownPropertyLengthOverrun`) に委ねられている。この述語は名前が上限超過の判定を連想させるが、実際に返すのは「既知 Type かつ上限内か」である
- 既知 Type の Length が残りバイトを超える場合は KEY_VALUE_FORMATTING_ERROR になるが、上限超過は対象外
- §8.3 の上限超過の MUST は Type の既知 / 未知を問わない。Object Properties 経路は上限超過の判定自体を持たないため、宣言 Length が残りバイト内に収まっていればそのまま受理し、収まっていなければ残量超過として (既知 / 未知を問わず) 寛容に打ち切る。いずれの場合も仕様が要求するセッション終了を行えない

draft-ietf-moq-transport-21 §8.3:

> The previous Type value plus the Delta Type MUST NOT be greater than 2^64 - 1. If a Delta Type is received that would be too large, the Session MUST be closed with a PROTOCOL_VIOLATION.

> Length: Only present when Type is odd. Specifies the length of the Value field in bytes. The maximum length of a value is 2^16-1 bytes. If an endpoint receives a length larger than the maximum, it MUST close the session with a PROTOCOL_VIOLATION.

## 設計方針

- 検証は `assertKnownPropertyValueInObjectProperties` (`src/properties.ts`) に置く。受信 3 経路は既にこの関数を呼んでいるため、呼び出し側の追加は不要である。経路ごとの検証関数や新しい呼び出し箇所は作らない (同関数の内部で使う判定用の述語は、続く上限値の判定の項目で定義する)
- `decodeObjectPropertiesTolerant` は変更せず、throw も追加しない。同関数は不正な delta / Length の例外を catch して「不完全データ」と同一視する契約であり、検証を置いても仕様が要求する PROTOCOL_VIOLATION が送出されない。加えて送信経路の `appendGreaseObjectProperty` / `mergeDeliveryTimeoutObjectProperties` (`src/session/publish.ts` から呼ばれる)、`OBJECT_PROPERTY_FILTER` の評価 (`src/filter.ts`)、LOC 抽出 (`src/loc.ts`)、delivery timeout の抽出が同じ寛容契約に依存している
- 上限値の判定は厳密デコーダと共有する。既存の `isKnownPropertyLengthOverrun` は名前と実際の意味 (「既知 Type かつ上限内か」) が一致していないため、意味に合う名前へ改名する。上限値そのものの判定は Type に依存しない述語として切り出し、厳密デコーダ側の既存の上限比較 (`decodeProperties` / `parseProperties` / `decodeImmutableProperties` にある `Number(length) > 65535` の比較) と `assertKnownPropertyValueInObjectProperties` の両方から呼ぶ。上限定数は `src/properties.ts` の `MAX_PROPERTY_VALUE_LENGTH` (65535n) を使う
- 検証の順序は次のとおり。(1) delta の累積が `MAX_VARINT` (2^64-1) を超えたら `ProtocolViolationError`。(2) 奇数 Type の宣言 Length が 2^16-1 を超えたら、Type の既知 / 未知を問わず `ProtocolViolationError`。上限超過の判定は残量検査より先に行う。(3) 残量検査は従来どおりとし、既知 Type は `SessionError(KEY_VALUE_FORMATTING_ERROR)`、未知 Type と不完全データは寛容に打ち切り
- 寛容デコードの契約 (不完全データでは読めた分だけ返す) は維持する。上限超過は「不完全データ」ではなく仕様違反として区別する
- 3 経路から共通の検証を呼び、経路ごとの検証漏れを作らない
- `assertKnownPropertyValueInObjectProperties` の JSDoc にある「Object Properties 経路では上限超過を検証しない」旨の記述と、同関数の内部コメントにある同じ趣旨の記述は、実装後に事実と異なるため同時に更新する

## 完了条件

- Object Properties で delta の累積が 2^64-1 を超えると `ProtocolViolationError` が送出され、受信経路 (`toSessionCloseError`) で PROTOCOL_VIOLATION のセッション終了になる
- Object Properties で奇数 Type の Length が 2^16-1 を超えると、Type の既知 / 未知を問わず `ProtocolViolationError` が送出され、受信経路で PROTOCOL_VIOLATION のセッション終了になる
- 既存の KEY_VALUE_FORMATTING_ERROR の判定が変わらないこと。既知 Type の Value と Length の varint が完結しない場合、および既知 Type の上限内 Length が宣言どおり残りバイトを超える場合は、従来どおり `SessionError(KEY_VALUE_FORMATTING_ERROR)` になる
- 未知 Type と不完全データは従来どおり寛容に打ち切られる。`decodeObjectPropertiesTolerant` は不完全データで例外を送出せず、読めた分の `properties` と `complete: false` を返す
- Object Datagram / Subgroup Object / Fetch Object の 3 経路すべてで検証される
- `src/properties.test.ts` に `assertKnownPropertyValueInObjectProperties` の単体テストを追加する。delta = `MAX_VARINT` の Value を消費させた直後に delta = 1 を置くと加算結果が 2^64 になり `ProtocolViolationError`、奇数 Type の Length = 65536 (以前は素通りしていた入力) は既知 / 未知を問わず `ProtocolViolationError`、既知 Type の上限内 Length の残量超過は `SessionError(KEY_VALUE_FORMATTING_ERROR)`、未知 Type の上限内 Length の残量超過と不完全データは throw しない、を検証する。最初の入力は既存の `decodeProperties: delta 加算結果が 2^64-1 を超えると ProtocolViolationError` テストと同じ並び (`encodeVarint(MAX_VARINT)` + `encodeVarint(0n)` + `encodeVarint(1n)`) を使う
- 受信 3 経路のテスト (`src/dataStream.datagram.test.ts` / `src/dataStream.subgroup.test.ts` / `src/dataStream.fetch.test.ts`) に、上限超過 Length と delta 累積超過の入力で `ProtocolViolationError` が送出されるケースを追加する。セッション終了コードまで確認する場合は既存の `src/session.test.ts` / `src/session/incoming.test.ts` の検証方法に合わせる
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure)
- draft-ietf-moq-transport-21 §8.4 (Track and Object Properties)
- draft-ietf-moq-transport-21 §11.1.3 (Object Properties)
- `issues/closed/0586-bug-object-property-known-type-kvf.md` (Object Properties 経路に既知 Type の検証を追加した先行 issue。§8.3 の MUST がデータプレーンにも適用されることを確定した)
- `issues/closed/0587-bug-known-type-length-overrun-error.md` (既知 Type の残量超過を KEY_VALUE_FORMATTING_ERROR とした先行 issue。当時は「上限超過の MUST は Track Properties の厳密デコーダのみ」と整理して閉じたが、§8.3 の上限超過の MUST はデータプレーンにも適用されるため、例外として残っていた穴を本 issue が埋める)
- `issues/closed/0379-moqt-draft-19-delta-type-overflow-validation.md` (`decodeObjectPropertiesTolerant` と利用経路を検証対象外とした先行判断。本 issue は寛容デコーダを変更せず、受信 3 経路の検証関数に検証を置くことでこの判断を維持する)
- `src/session/errors.ts` の `toSessionCloseError` (受信経路で `ProtocolViolationError` を PROTOCOL_VIOLATION のセッション終了にする)

## 補足

- `parseProperties` の汎用奇数分岐には Length 上限 (2^16-1 超) の検査がない。ID 0x0D (未知 odd Type) + Length 65536 + 65536 バイトを渡すと throw しない。本 issue は Object Properties 経路だけを扱い、この穴は別 issue とする。なお、本 issue が Length 上限の判定を `src/properties.ts` の共有述語として切り出すため、別 issue での解消はその述語を `parseProperties` から呼ぶだけで済む
- 受信 3 経路のすべてが `assertKnownPropertyValueInObjectProperties` を呼ぶ。fill fetch は通常の FETCH と同じ `decodeFetchObjectFields` を通るため、検証は共有される
- delta の累積超過を再現する入力は「delta = `MAX_VARINT` (2^64-1、奇数 Type) に Value を消費させた後に delta = 1 を置く」である。`MAX_VARINT` は奇数 Type のため Length を伴い、Length と Value を消費させないと次の delta が読まれない。`decodeVarint` が返す値は単体では 2^64-1 を超えないため、加算結果で判定する必要がある。既存の `decodeProperties` のテストは `encodeVarint(MAX_VARINT)` + `encodeVarint(0n)` + `encodeVarint(1n)` で同じ超過を再現している
- 上限超過 Length の入力を作るテストでは、Value の内側バイト列が `assertNoMandatoryTrackPropertyInObjectProperties` の走査 (Mandatory Track Property / IMMUTABLE_PROPERTIES の再帰) に掛からないバイト列を選ぶ。掛かった場合は `MalformedTrackError` (セッションは閉じない) が先に発火する
