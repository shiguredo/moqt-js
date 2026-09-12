# 既知 Type の Length 宣言超過が §8.3 の KEY_VALUE_FORMATTING_ERROR にならない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-known-type-length-overrun-error
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §8.3 は、受信者が理解する (既知の) Type について Value または Length/Value が serialization に一致しない場合、KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST を定める。現在、既知 Type の Length が varint として完結しない場合は KEY_VALUE_FORMATTING_ERROR で閉じるが、Length の varint が完結したうえで宣言値が残りバイトを超える場合は ProtocolViolationError (PROTOCOL_VIOLATION) になっている。セッションは閉じるものの、エラーコードが §8.3 の文言と一致するかを確定し、コード・コメント・テストに固定する。

## 現状

- `decodeKnownPropertyVarint` (`src/properties.ts`) は varint がバッファ内で完結しない場合に限り、既知 Type なら `SessionError(KEY_VALUE_FORMATTING_ERROR)` を throw する。
- 奇数 Type の Length 宣言が残りバイトを超える切り詰めは、既知 / 未知を問わず `ProtocolViolationError` で拒否される (`decodeImmutableProperties` / `parseProperties` / `decodeProperties` の各残量検査)。
- この統一は closed 0475 が「非 tolerant デコーダでは Length 宣言超過を ProtocolViolationError とする」と決定した結果である。
- §8.3 は「Length の最大値 (2^16-1) 超過は PROTOCOL_VIOLATION」と明記する一方、既知 Type の serialization 不一致は KEY_VALUE_FORMATTING_ERROR と定めており、残量超過の切り詰めがどちらに当たるかは文言上自明でない。§8.3 の「Key-Value-Pairs are always parsed with a known byte length, which bounds the sequence.」との関係も整理が必要である。

## 設計方針

1. 一次資料 (§8.3 / §9 のメッセージ長の扱い) を読み、既知 Type の Length 宣言超過を KEY_VALUE_FORMATTING_ERROR にするか PROTOCOL_VIOLATION のままとするかを決定し、根拠をコードコメントに残す。
2. KEY_VALUE_FORMATTING_ERROR に変更する場合は、既知 Type と未知 Type の切り分け (`decodeKnownPropertyVarint` と同じ基準) を残量検査にも適用する。
3. PROTOCOL_VIOLATION のままとする場合は、§8.3 のどの文言で説明するかをコメントに明記し、既存テストで固定する。
4. 対象は Key-Value-Pair の Length 宣言超過とする。値域検証 (`validateTrackPropertyValue`) は本 issue の対象外とする。

## 完了条件

- 既知 Type の Length 宣言超過のエラーコードが決定され、コード・コメント・テストに反映されていること (変更不要と判断した場合も根拠コメントとテストが揃っていること)。
- 既知 / 未知 Type の切り分けがテストで固定されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- コード変更を伴う場合は `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.3 (Key-Value-Pair Structure) / §12.2 (Session Termination Codes)
- `decodeKnownPropertyVarint` / `decodeProperties` / `decodeImmutableProperties` / `parseProperties` (`src/properties.ts`)
- `issues/closed/0475-bug-message-slice-boundary-checks.md` (Length 宣言超過を ProtocolViolationError に統一した先行判断)
- `issues/closed/0562-bug-key-value-formatting-error-session-close.md` (varint 不完結を KEY_VALUE_FORMATTING_ERROR で閉じる経路)
