# PUBLISH_OK / REQUEST_UPDATE 受信時の LOCATION_FILTER が値検証されず §5.1.2 の受信 MUST が効かない

- Created: 2026-08-29
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-ok-location-filter-validation
- Polished: 2026-09-01

## 目的

draft-ietf-moq-transport-19 §5.1.2 の「AbsoluteRange の End Group が 2^64-1 を超える Location Filter を受信した場合、endpoint は PROTOCOL_VIOLATION でセッションを閉じる MUST」は受信経路で成立しなければならない。LOCATION_FILTER (0x21) の値が無検証で受理されるランタイム受信経路は 2 つある。PUBLISH_OK (§10.2.9) と、publish ロール確立ストリーム上でピア subscriber が送る REQUEST_UPDATE (§10.9) である。現状どちらの経路も値のデコード検証が接続されておらず、超過を含む AbsoluteRange が黙って受理される。0426 で `decodeLocationFilter()` に関数レベルの検証を追加済みであり、本 issue はそれをセッション受信経路へ接続する。

## 現状

- `PUBLISH_OK_ALLOWED_PARAMS`（`src/message/parameterScope.ts`）は `MessageParameterType.LOCATION_FILTER` を含むため、スコープ検証は通過する。
- `bidiReadPublishResponse`（`src/session/bidi.ts`）の REQUEST_OK 受信分岐は `validateParameterScope` と `validateRangeFilterCombination` のみを行い、LOCATION_FILTER の値は `Parameter.value`（length-prefixed の生バイト）のままデコードされずに無視される。
- `bidiReadRequestStreamMessages`（`src/session/bidi.ts`）の REQUEST_UPDATE 受信分岐のうち publish ロール（確立済み publish ストリーム）も `validateParameterScope` と `validateRangeFilterCombination` のみを行い、LOCATION_FILTER の値をデコードせず、publisher が存在すれば無条件に REQUEST_OK を応答する。ピア subscriber はここで購読の更新として LOCATION_FILTER を送るため、§5.1.2 の MUST がこの経路でも成立していない。
- `decodeLocationFilterParameter()`（`src/message/parameter.ts`）は 0426 で End Group の 2^64-1 超過を `ProtocolViolationError` で拒否する検証を持つが、ランタイムの受信経路から呼ぶ箇所が無い（テストと PBT のみ）。
- 上記以外の受信経路は LOCATION_FILTER の値に到達しない。受信 PUBLISH ストリーム上の REQUEST_UPDATE（ケース 1、`bidiHandlePublishRequestUpdate`）は LOCATION_FILTER を含むと REQUEST_ERROR (NOT_SUPPORTED) で応答し、SUBSCRIBE ストリーム上の REQUEST_UPDATE は PROTOCOL_VIOLATION でセッションを閉じ、REQUEST_UPDATE の REQUEST_OK（`bidiHandleRequestUpdateOk`）は `REQUEST_UPDATE_OK_ALLOWED_PARAMS` に LOCATION_FILTER が無いためスコープ違反になる。

## 設計方針

- `bidiReadPublishResponse` の REQUEST_OK 受信分岐で、復号済みパラメータから `MessageParameterType.LOCATION_FILTER` のパラメータを `decodeLocationFilterParameter()` 経由でデコードする。超過は `ProtocolViolationError` を throw して既存の関数外側 catch に乗せ、`src/session/errors.ts` の `toProtocolViolationSessionError` が PROTOCOL_VIOLATION の `SessionError` へ変換し、後始末（`pendingPublish` 削除・`requestStreams` 削除・`pending.reject`・`closeWithError`）を行う。この後始末は同一分岐の `validateRangeFilterCombination` の `InvalidFilterError` 変換および破損ペイロードの変換と同一手順になる。
- `bidiReadRequestStreamMessages` の REQUEST_UPDATE 受信分岐（publish ロール）でも同様に LOCATION_FILTER を `decodeLocationFilterParameter()` でデコードし、超過は関数外側 catch の `toProtocolViolationSessionError` で PROTOCOL_VIOLATION にしてセッションを閉じる。REQUEST_OK の応答は検証通過後に限る。
- `decodeLocationFilterParameter` が `IncompleteDataError` 等のその他エラーを throw した場合も、両経路とも受信ループ既存の変換規則（`toProtocolViolationSessionError`）に乗せて PROTOCOL_VIOLATION とする。
- デコードしたフィルタ値の Publisher 側状態への反映（FORWARD / Expires と同様の反映）は行わない。反映は REQUEST_UPDATE 経由のフィルタ反映と併せて 0424 系の別論点であり、本 issue は受信 MUST の強制（検証のみ）に目的を限定する。
- 検証用のフィルタ構造は、正常系（AbsoluteStart / 域内 AbsoluteRange / 境界ちょうど 2^64-1）は送信経路と同様に `encodeLocationFilterParameter()` で組み立てる。2^64-1 超過の負テストは `encodeLocationFilter()` が送信前に `InvalidFilterError` で throw するためエンコーダで組み立てられない。そのため `encodeVarint` を直接使った手組みバイト列で構築する（`src/message/parameter.test.ts` の `decodeLocationFilter` 拒否テストと同じ流儀。Filter Type 0x04 + Group = MAX_VARINT + Object = 0 + End Group Delta = 1 の形で End Group = MAX_VARINT + 1 超過になる構成）。

## 完了条件

- PUBLISH_OK に End Group が 2^64-1 を超える AbsoluteRange の LOCATION_FILTER を載せて受信した場合、PROTOCOL_VIOLATION でセッションが閉じ、`pendingPublish` と `requestStreams` の該当エントリが残らないこと（`src/session/bidi.test.ts` の既存テスト「不正な Range Filter を含む PUBLISH_OK」および「破損 PUBLISH_OK」のパターンで結合テストを検証する）。
- 正常な LOCATION_FILTER（AbsoluteStart / 域内 AbsoluteRange / 境界ちょうど 2^64-1）を含む PUBLISH_OK 受信ではセッションが閉じず、従来どおり `pendingPublish` の解決（`pending.resolve` / `publishers` 登録）が行われること。
- publish ロール確立ストリーム上の REQUEST_UPDATE に End Group が 2^64-1 を超える LOCATION_FILTER を含めて受信した場合、PROTOCOL_VIOLATION でセッションが閉じ、REQUEST_OK が応答されないこと（`src/session/bidi.test.ts` の既存テスト「不正な Range Filter を含む REQUEST_UPDATE (publish ロール)」のパターンで検証する）。
- 正常な LOCATION_FILTER を含む REQUEST_UPDATE（publish ロール）では従来どおり REQUEST_OK が応答され、セッションが閉じないこと（回帰ガード）。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1.2 (Location Filters)
- draft-ietf-moq-transport-19 §10.2.9 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE)
- 関連: `issues/closed/0426-bug-absoluterange-end-group-overflow.md`（`decodeLocationFilter` 自体の検証追加。本 issue は受信経路への接続）
- 関連: `issues/0424-bug-request-update-location-filter-unapplied.md`（REQUEST_UPDATE 送信時のフィルタ反映漏れ。本 issue は受信側の検証のみを扱い、値の反映は対象外）
- 関連: `issues/0437-bug-request-update-raw-location-filter-bypass.md`（REQUEST_UPDATE 送信側の raw パラメータ経路の検証。本 issue は受信側）
- 関連: `issues/0439-bug-location-filter-parameter-consumed-check.md`（`decodeLocationFilterParameter` の宣言 Length 消費検証。本 issue の値域検証と相補的）
- 注: `refs/moq/` の一次資料は draft-20 に更新済みだが、現行実装は draft-19 ワイヤのままである（draft-20 移行は 0448 / 0452 等の open issue で計画中）。本 issue は現行 draft-19 実装に対する対応であり、draft-20 移行（0452 の PUBLISH_OK から LOCATION_FILTER を外す変更）で前提を更新する。

## 解決方法

未着手。
