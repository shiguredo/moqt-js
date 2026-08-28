# AbsoluteRange の End Group が 2^64-1 を超える場合の検証がない

- Created: 2026-08-22
- Completed: 2026-08-29
- Branch: feature/fix-absoluterange-end-group-overflow
- Polished: 2026-08-28

## 目的

draft-ietf-moq-transport-19 §5.1.2 の「If the resulting Group ID would be greater than 2^64 - 1, the endpoint MUST close the session with a PROTOCOL_VIOLATION.」という MUST を満たす検証が未実装である。AbsoluteRange フィルタの End Group（Start Location の Group + End Group Delta）が 2^64-1 を超えた場合に、仕様どおり PROTOCOL_VIOLATION で拒否する。

## 現状

- `decodeLocationFilter()`（`src/message/parameter.ts`）は AbsoluteRange の Start Location + End Group Delta が 2^64-1 を超えていても検証せずに受理する。受信した SUBSCRIBE / FETCH / REQUEST_UPDATE の不正な AbsoluteRange がそのまま通過し、§5.1.2 の MUST（PROTOCOL_VIOLATION でセッションを閉じる）に反する。
- `encodeLocationFilter()`（`src/message/parameter.ts`）にも送信前検証が無く、2^64-1 を超える AbsoluteRange をそのまま送信してしまう。
- `resolveFilter()`（`src/filter.ts`）は AbsoluteRange で `start.group + endGroupDelta` を無検証のまま計算する（bigint のためオーバーフローはしない）。上流のデコード段階で 2^64-1 超過が拒否されないと、仕様外の End Group がフィルタ解決へ流れ込み、後続のマッチング動作の前提が壊れる。
- `MAX_VARINT`（2^64-1）は `src/varint.ts` で export 済みであり、`src/message/parameter.ts` の Range Filter の 2^64-1 超過検証（`InvalidFilterError`）でも利用されている。
- `InvalidFilterError`（`src/error.ts`）の doc comment は現状「不正な Range Filter (§5.1.3 / §10.2.12-14)」に限定されており、Location Filter は対象外である。

## 設計方針

- 受信経路のデコード（`decodeLocationFilter`）で Start Location の Group + End Group Delta を検証し、2^64-1 超過は `ProtocolViolationError` を throw する。§5.1.2 の MUST は PROTOCOL_VIOLATION 一択であり、INVALID_FILTER 応答パスは存在しないため `InvalidFilterError` は使わない。
- 送信前にも駆動経路（`encodeLocationFilter` / `encodeLocationFilterParameter`）で同一規則を適用し、2^64-1 超過のフィルタは `InvalidFilterError` を throw する（既存の Range Filter 送信前検証と同じ流儀）。あわせて `InvalidFilterError` の doc comment を「Range Filter および Location Filter」に拡張する。
- 検証は `MAX_VARINT`（`src/varint.ts`）を使って行う。
- `resolveFilter()` の AbsoluteRange はデコード段階で 2^64-1 超過が拒否されていることを前提とし、フィルタ解決処理に重複した検証を持ち込まない。

## 完了条件

- `start.group + endGroupDelta > 2^64-1` の AbsoluteRange を含む受信メッセージが PROTOCOL_VIOLATION で拒否されること（デコードの単体テスト、可能なら受信処理の結合テストで検証する）。
- 送信側で 2^64-1 超過の AbsoluteRange が throw されること（エンコードの単体テストで検証する）。
- 境界値 (`2^64-1` ちょうど) は受理されること。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)

## 解決方法

- `decodeLocationFilter()`（`src/message/parameter.ts`）の ABSOLUTE_RANGE 分岐で、Start Location の Group + End Group Delta が `MAX_VARINT`（2^64-1）を超える場合に `ProtocolViolationError` を throw するようにした。§5.1.2 の MUST（超過は PROTOCOL_VIOLATION でセッションを閉じる）をデコード段階の検査として実装する位置づけ。受信経路に載った場合は既存の `toProtocolViolationSessionError` 変換規則で PROTOCOL_VIOLATION になる。比較は仕様どおり `>`（ちょうど 2^64-1 は受理）。
- `encodeLocationFilter()`（同ファイル）の AbsoluteRange 分岐で同一条件を送信前に検証し、超過は `InvalidFilterError` を throw するようにした。`encodeLocationFilterParameter()` は内部で `encodeLocationFilter()` を呼ぶため、SUBSCRIBE 送信の駆動経路（`buildSubscribeParameters` → `encodeLocationFilterParameter`）でも同じ検証が効く。
- `InvalidFilterError`（`src/error.ts`）の doc comment を「不正な Range Filter および Location Filter」に拡張し、Location Filter 関連用途は送信前検証専用である旨を明記した。
- `Session.subscribe()`（`src/session.ts`）で `buildSubscribeParameters(options)` の呼び出しを `pendingSubscribe.set`（SUBSCRIBE_OK Promise 作成）より前へ移動した。送信前検証が throw した際に pending エントリと未解決 Promise が残るのを防ぐ（`fetch()` の既存手順と対称）。副次的に、構築系の既存 throw（validateNonNegative / encodeRangeFilter など）による pending 残留も同時に解消される。
- `LocationFilter` 型と `SubscribeOptions.filter` の doc に End Group の制約と送信前 throw を追記し、実装の適用範囲（和検証、個別負値・object 単体超過は encodeVarint 由来 Error）をコメントに正確に反映した。
- テスト: `src/message/parameter.test.ts` に decode の拒否 2 件（group 側から超過、delta 単体最大 + group>=1）・受理 3 件（ちょうど 2^64-1、delta 単体最大 + group=0、group 最大 + delta=0）、encode の拒否 1 件、encodeLocationFilterParameter の拒否 1 件、境界 round-trip 1 件を追加。`src/session/params.test.ts` に buildSubscribeParameters の拒否・受理（LOCATION_FILTER パラメータ化）の 2 件、`src/session.test.ts` に subscribe() 統合テスト（InvalidFilterError で reject かつ pendingSubscribe に残らない）を 1 件追加。
- 検証結果: `vp lint` / `tsc --noEmit` / `vp test run`（1319 件）すべて通過。

### 設計方針からの補足（レビューで判明した実態）

- 「INVALID_FILTER 応答パスは Location Filter には存在しない」は厳密には不正確で、§5.1.2 が Location Filter に対して定める REQUEST_ERROR は充足不能範囲に対する INVALID_RANGE である（超過に対する応答は PROTOCOL_VIOLATION のみ）。コメント・doc はこの正確な根拠で記述した。
- 本ライブラリの受信処理は現状 LOCATION_FILTER の値を `decodeLocationFilter` 経由でパースしない（`decodeParameters` の length-prefixed 生バイトとして保持）ため、受信 MUST のセッションレベルでの適用は LOCATION_FILTER を解釈する受信経路が接続された際に効く。接続は本 issue の設計方針の範囲外であり、REQUEST_UPDATE 経由のフィルタ反映と合わせて別途対応すべき論点（残課題として issue 化候補）。
- `RequestUpdateOptions.parameters` の raw `Parameter[]` 経路（bidi.ts）は `encodeLocationFilterParameter` を通さないため、手組みの超過 LOCATION_FILTER を載せられる構造が残る。公開 API のraw パラメータ設計全体の論点として残課題。
- 受信 PUBLISH 系・RESET 系の pending クリーンアップや unhandled rejection 抑制は別 issue の管轄であり本 issue では扱わない。
