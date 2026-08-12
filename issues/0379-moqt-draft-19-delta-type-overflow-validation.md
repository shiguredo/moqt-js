# Key-Value-Pair / Message Parameter / Track Property の Delta Type 加算の 2^64-1 超過検証がない

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-delta-type-overflow-validation
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §1.4.3 の「The previous Type value plus the Delta Type MUST NOT be greater than 2^64 - 1. If a Delta Type is received that would be too large, the Session MUST be closed with a PROTOCOL_VIOLATION.」と §10.2 の「If the resulting Type would be greater than 2^64 - 1, the endpoint MUST close the session with a PROTOCOL_VIOLATION.」を満たす。現在は `previousType + deltaType` の 2^64-1 超過チェックがなく、JS number 化による精度劣化も発生しうる。

## 優先度根拠

SETUP 経路 (Key-Value-Pairs) と Track Property のデコード経路で Delta Type を加算する際、2^64-1 を超える Type が生成されても検出されず、悪意のあるピアからの不正ワイヤを誤受理しうる (MUST 違反)。なお `decodeMessageParameter` 経路は未知型チェック (`getMessageParameterValueEncoding` の参照失敗) の副次保護により実害が限定される。仕様 MUST 違反ではあるが、既知型のみを扱う実装への実害は限定的。Medium。

## 現状

- `decodeKeyValuePair` (`src/message/parameter.ts`) で `paramType = previousType + Number(deltaType)` としており、2^64-1 超過の明示チェックがない。同関数は Key-Value-Pairs のデコードに使用され、Setup Options (§10.3.1 の「Setup Options are serialized as Key-Value-Pairs Figure 2」) を含む。
- `decodeMessageParameter` (`src/message/parameter.ts`) も同様。
- `src/properties.ts` のデコード経路 (`decodeProperties` / `parseProperties` / `decodeImmutableProperties`) も `previousId + deltaId` の 2^64-1 超過チェックがない (bigint 演算のため精度劣化はない)。`decodeProperties` 内の IMMUTABLE_PROPERTIES 再帰走査 (`innerId = innerPreviousId + deltaId`) も同様。
- `decodeObjectPropertiesTolerant` (`src/properties.ts`) は「寛容なデコード: 不完全・不正なデータではそこで停止し、complete=false で途中まで読めた Property 列を返す。Delta Type オーバーフロー / Length 上限などの §1.4.3 の MUST 検証は行わない」と明記された既存契約を持つ (本 issue の検証対象外)。
- 変更対象ファイル: `src/message/parameter.ts` (2 箇所の加算・検証)、`src/properties.ts` (3 経路 + 再帰走査の加算・検証)、`src/message/parameter.test.ts` / `src/properties.test.ts` (固定バイト列テスト追加)、`CHANGES.md`。

## 設計方針

- **加算結果の検証**: 各デコード経路で加算結果 (`previousType + deltaType`) の 2^64-1 超過を bigint で検証し、超過時は ProtocolViolationError を送出する。deltaType 単体の値では判定しない (deltaType 自体は varint であり、単体で 2^64-1 を超える値はワイヤ上に存在しない。1 個目のパラメータで previousType=0 のとき、deltaType が 2^64-1 なら加算結果も 2^64-1 で合法)。
- **bigint 演算**: デコードループの previousType アキュムレータは bigint で保持し、加算・検証・パリティ判定 (`% 2n`) を bigint で行ったうえで、検証通過後に `Parameter.type` (number) へ 1 回だけ変換する。2^53 超 Type の精度劣化は number で保持される限り残る (Parameter.type の bigint 化は本 issue のスコープ外)。
- **上限定数**: 超過判定の定数は 0363 で導入される `src/varint.ts` の `MAX_VARINT` (2^64-1) を参照する (独自定数を定義しない)。
- **decodeObjectPropertiesTolerant は対象外**: 同関数には検証を追加せず、既存の寛容契約を維持する。同関数を利用する Object 配信経路 (`readDeliveryTimeoutObjectProperties` / `mergeDeliveryTimeoutObjectProperties` / `appendGreaseObjectProperty` / LOC 抽出) は本 issue の検証対象外とする (0361 との調整。下記注記参照)。
- **テスト**: 固定バイト列で「加算結果が 2^64-1 を超える Delta Type」を検証するテストを追加する。境界条件: (a) deltaType 単体が 2^64-1 (previousType=0 で加算結果も 2^64-1) は違反にならない、(b) 加算結果が 2^64-1 ちょうどは違反にならない、(c) 加算結果が 2^64-1 を超える (例: previousType=1 + deltaType=2^64-1) は ProtocolViolationError。

## 完了条件

- 加算結果が 2^64-1 を超える Delta Type を受信した場合に ProtocolViolationError が送出されること (セッションクローズは受信ループの責務であり、本 issue の検証対象外)。
- 検証経路: `decodeKeyValuePair` (Setup Options を含む Key-Value-Pairs) / `decodeMessageParameter` / `decodeProperties` (IMMUTABLE_PROPERTIES 再帰走査を含む) / `parseProperties` / `decodeImmutableProperties` で検証されること。`parseProperties` / `decodeImmutableProperties` はプロダクションコードからは参照されないが、公開デコード関数として提供されており、受信データを扱う API の MUST 準拠を保つため対象に含める。ただし `decodeObjectPropertiesTolerant` とそれを利用する Object 配信経路は本 issue の検証対象外 (既存の寛容契約を維持)。
- 上記を検証する固定バイト列テストがあること (境界条件 (a)(b)(c) を含む)。
- 0361 との相互参照注記 (LOC 抽出経路の寛容維持) と 0363 との相互参照注記 (MAX_VARINT 参照) が本 issue に追加されていること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §1.4.3 (Key-Value-Pair Structure)
- draft-ietf-moq-transport-19 §2.5 (Properties / Key-Value-Pairs Figure 2 でシリアライズ)
- draft-ietf-moq-transport-19 §10.2 (Message Parameters)
- draft-ietf-moq-transport-19 §10.3.1 (Setup Options / Key-Value-Pairs Figure 2 でシリアライズ)
- 関連: `0363-bug-varint-overflow-wrap.md`（`MAX_VARINT` の導入。実装順は先に 0363。上限定数は 0363 導入の `MAX_VARINT` を参照する）
- 関連: `0361-change-loc-object-properties-delta-encoding.md`（`decodeObjectPropertiesTolerant` の寛容経路との調整。実装順は先に 0361）
- 関連: `0394-refactor-unify-max-varint-constant.md`（`MAX_VARINT` への重複定数統一）

## 注記 (0361 との調整)

- 本 issue は `decodeObjectPropertiesTolerant()` に Delta Type オーバーフロー検証を追加しない (同関数と利用経路 `readDeliveryTimeoutObjectProperties()` / `mergeDeliveryTimeoutObjectProperties()` / `appendGreaseObjectProperty()` / LOC 抽出は、既存の寛容契約「§1.4.3 の MUST 検証は行わない」を維持する)。これにより 0361 の「LOC 抽出経路は Delta Type オーバーフロー検証の例外を catch して寛容に扱う」という調整は発生しない (0361 の完了条件の趣旨を満たす)。
- 実装順: 0361 を先に実装する。

## 注記 (0363 との調整)

- 上限定数は 0363 で導入される `src/varint.ts` の `MAX_VARINT` を参照する (0379 が独自定数を定義しないための調整)。
- 実装順: 0363 を先に実装する。

## 解決方法

未着手。
