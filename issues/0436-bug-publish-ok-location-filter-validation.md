# PUBLISH_OK 受信時の LOCATION_FILTER が値検証されず §5.1.2 の受信 MUST が効かない

- Created: 2026-08-29
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-ok-location-filter-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §5.1.2 の「AbsoluteRange の End Group が 2^64-1 を超える Location Filter を受信した場合、endpoint は PROTOCOL_VIOLATION でセッションを閉じる MUST」は受信経路で成立しなければならない。LOCATION_FILTER (0x21) は PUBLISH_OK (§10.2.9) で受理される唯一のランタイム受信経路だが、現状は値のデコード検証が接続されておらず、超過を含む AbsoluteRange が黙って受理される。0426 で `decodeLocationFilter()` に関数レベルの検証を追加済みであり、本 issue はそれをセッション受信経路へ接続する。

## 現状

- `PUBLISH_OK_ALLOWED_PARAMS`（`src/message/parameterScope.ts`）は `MessageParameterType.LOCATION_FILTER` を含むため、スコープ検証は通過する。
- `bidiReadPublishResponse`（`src/session/bidi.ts`）の REQUEST_OK 受信分岐は `validateParameterScope` と `validateRangeFilterCombination` のみを行い、LOCATION_FILTER の値は `Parameter.value`（length-prefixed の生バイト）のままデコードされずに無視される。
- `decodeLocationFilterParameter()`（`src/message/parameter.ts`）は 0426 で End Group の 2^64-1 超過を `ProtocolViolationError` で拒否する検証を持つが、ランタイムの受信経路から呼ぶ箇所が無い（テストと PBT のみ）。
- REQUEST_UPDATE_OK の許可パラメータ（`REQUEST_UPDATE_OK_ALLOWED_PARAMS`）は LOCATION_FILTER を含まず、受信 PUBLISH / SUBSCRIBE は NOT_SUPPORTED 応答のため、moqt-js が対向の Location Filter 値を実際に受け取る唯一の経路は PUBLISH_OK である。

## 設計方針

- `bidiReadPublishResponse` の REQUEST_OK 受信分岐で、復号済みパラメータから LOCATION_FILTER を `decodeLocationFilterParameter()` 経由でデコードし、`ProtocolViolationError` を `SessionError`（PROTOCOL_VIOLATION）へ変換してセッションを閉じる。後始末（`pendingPublish` 削除・`requestStreams` 削除・`pending.reject`・`closeWithError`）は同一分岐の `validateRangeFilterCombination` の `InvalidFilterError` 変換と同一手順に揃える。
- `decodeLocationFilterParameter` が `IncompleteDataError` 等のその他エラーを throw した場合も、受信ループ既存の変換規則（`src/session/errors.ts` の `toProtocolViolationSessionError`）に乗せて PROTOCOL_VIOLATION とする。
- デコードしたフィルタ値の Publisher 側状態への反映（FORWARD / Expires と同様の反映）は行わない。反映は REQUEST_UPDATE 経由のフィルタ反映と併せて 0424 系の別論点であり、本 issue は受信 MUST の強制（検証のみ）に目的を限定する。
- 検証用のフィルタ構造は送信経路と同様に `encodeLocationFilterParameter()` で組み立てる（テストでも手組みバイト列を使わず既存エンコード関数を利用する）。

## 完了条件

- PUBLISH_OK に End Group が 2^64-1 を超える AbsoluteRange の LOCATION_FILTER を載せて受信した場合、PROTOCOL_VIOLATION でセッションが閉じ、`pendingPublish` と `requestStreams` の該当エントリが残らないこと（`src/session/bidi.test.ts` の既存 GOAWAY / InvalidFilterError 変換テストのパターンで結合テストを検証する）。
- 正常な LOCATION_FILTER（AbsoluteStart / 域内 AbsoluteRange / 境界ちょうど 2^64-1）を含む PUBLISH_OK 受信ではセッションが閉じず、従来どおり SUBSCRIBE_OK 相当の解決が行われること。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-19 §10.2.9 (LOCATION FILTER Parameter)
- 関連: `issues/closed/0426-bug-absoluterange-end-group-overflow.md`（`decodeLocationFilter` 自体の検証追加。本 issue は受信経路への接続）
- 関連: `issues/0424-bug-request-update-location-filter-unapplied.md`（REQUEST_UPDATE 送信時のフィルタ反映漏れ。本 issue は受信側の検証のみを扱い、値の反映は対象外）

## 解決方法

未着手。
