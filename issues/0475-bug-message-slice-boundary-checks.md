# Length 宣言 slice の境界検証欠落 (message 層・Properties 層)

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-message-slice-boundary
- Polished: 2026-09-06

## 目的

Length 宣言が残りバイトを超える切り詰め入力を、短い `slice` / `subarray` のまま後段に流し、別エラー (`IncompleteDataError` による待ち等) として報告する。制御ストリームは外側でフレーミング済みのため内側の不足は破損であり、宣言時点で `ProtocolViolationError` とする必要がある。

## 現状

- `src/message/parameter.ts` の `decodeParameter` (奇数型)、`decodeTrackNamespace` (element)、`decodeKeyValuePair`、`decodeMessageParameter` (uint8 分岐と length-prefixed 分岐) が残量検査なしに `slice` する。
- `src/message/session.ts` の `decodeRedirect` (uri / trackName)、`decodeGoawayPayload` (uri)、`decodeRequestErrorPayload` (reason) が残量検査なしに `slice` する。
- `src/message/subscribe.ts` の `decodeSubscribePayload`、`src/message/publish.ts` の `decodePublishPayload` (trackName) と `decodePublishDonePayload` (reason)、`src/message/fetch.ts` の `decodeFetchPayload` (trackName) が残量検査なしに `slice` する。
- `src/properties.ts` の `decodeImmutableProperties`、`parseProperties`、`decodeProperties` が残量検査なしに `subarray` / `slice` する。
- 正例として `decodeMessageParameter` の self-length-prefixed 分岐と `decodeObjectPropertiesTolerant` は残量超過を検出する。残余全体取得の `data.slice(offset)` 系と、`decodeMessageParameter` の value を入力とする `decodeLocationFilter` / `decodeRangeFilter` は対象外である。
- 最終的に `PROTOCOL_VIOLATION` で閉じる点では事故にならないが、原因が切り詰めではなく別エラーとして報告されうる。

## 設計方針

1. 列挙した非 tolerant デコーダで、Length 宣言が残りバイトを超える場合は `ProtocolViolationError` とする (正例パターンに統一)。
2. `subarray` 箇所も同等に検証する。
3. 切り詰め入力の単体テストを対象関数ごとに追加する。

## 完了条件

- 列挙した全関数で切り詰め入力が `ProtocolViolationError` になること (内側不足を `IncompleteDataError` にしないこと)。
- 既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
