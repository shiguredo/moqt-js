# 既知 Type の Length 宣言超過が §8.3 の KEY_VALUE_FORMATTING_ERROR にならない

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-known-type-length-overrun-error
- Polished: 2026-09-12

## 目的

draft-ietf-moq-transport-21 §8.3 は、受信者が理解する (既知の) Type について Value または Length/Value が serialization に一致しない場合、KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST を定める。現在、既知 Type の Length が varint として完結しない場合は KEY_VALUE_FORMATTING_ERROR で閉じるが、Length の varint が完結したうえで宣言値が境界を超える場合は ProtocolViolationError (PROTOCOL_VIOLATION) になっている。**既知 Type の Length 宣言超過は KEY_VALUE_FORMATTING_ERROR とする** と確定し、コード・コメント・テストに固定する。

## 現状

- `decodeKnownPropertyVarint` (`src/properties.ts`) は varint がバッファ内で完結しない場合に限り、既知 Type なら `SessionError(KEY_VALUE_FORMATTING_ERROR)` を throw する。
- 奇数 Type の Length 宣言が残りバイトを超える切り詰めは、既知 / 未知を問わず `ProtocolViolationError` で拒否される (`decodeImmutableProperties` / `parseProperties` / `decodeProperties` の各残量検査)。
- この統一は closed 0475 が「非 tolerant デコーダでは Length 宣言超過を ProtocolViolationError とする」と決定した結果である。
- 一方 §8.3 は、PROTOCOL_VIOLATION を「Length が最大値 (2^16-1) を超える場合」の MUST として定めており、残量超過の切り詰めを PROTOCOL_VIOLATION とする明文はない。既知 Type の serialization 不一致は KEY_VALUE_FORMATTING_ERROR の MUST であり、宣言 Length が境界を超えて Value を読めない場合はこれに当たる。
- 0586 で `assertKnownPropertyValueInObjectProperties` を追加し、Object Properties 経路では既知 Type の Value / Length の varint 不一致を KEY_VALUE_FORMATTING_ERROR として検出するようにした。残量超過は未対応である。

## 設計方針

1. 既知 Type の Length 宣言超過 (Length の varint は完結するが宣言値が境界を超える) は `SessionError(KEY_VALUE_FORMATTING_ERROR)` とする。根拠は §8.3 の既知 Type の serialization 不一致 MUST であり、コメントに節番号と文面を残す。
2. Length が 2^16-1 を超える場合は §8.3 が明示的に PROTOCOL_VIOLATION と定めるため、既知 / 未知を問わず従来どおり `ProtocolViolationError` のままとする。
3. 未知 Type は受信者が理解しないため serialization の一致を要求できず、既知 Type 節の MUST は適用されない。Object Properties 経路では従来どおり寛容に打ち切り、厳密デコーダ (Track Properties 経路) ではフレーミングとして解釈できないため従来どおり `ProtocolViolationError` とし、その根拠をコメントに残す。
4. 実装は 0586 の `assertKnownPropertyValueInObjectProperties` の残量検査を変更する (既知 Type なら SessionError、未知 Type なら打ち切り)。厳密デコーダの残量検査は「既知 Type なら SessionError、未知 Type なら ProtocolViolationError」に切り分ける。
5. 対象は Key-Value-Pair の Length 宣言超過とする。値域検証 (`validateTrackPropertyValue`) は本 issue の対象外とする。
6. テストは、既知 Type の残量超過が KEY_VALUE_FORMATTING_ERROR になること、未知 Type が従来どおり (Object Properties は寛容打ち切り / 厳密デコーダは PROTOCOL_VIOLATION) であること、Length が 2^16-1 超なら PROTOCOL_VIOLATION のままであることを固定する。

## 完了条件

- 既知 Type の Length 宣言超過が、Object Properties 経路と厳密デコーダの両方で KEY_VALUE_FORMATTING_ERROR になること。
- 未知 Type の Length 宣言超過が、Object Properties 経路では従来どおり寛容に打ち切られ、厳密デコーダでは従来どおり PROTOCOL_VIOLATION になること。
- Length が 2^16-1 を超える場合は既知 / 未知を問わず PROTOCOL_VIOLATION のままであること。
- 上記を検証するテストがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に `[FIX]` を追加すること。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.3 (Key-Value-Pair Structure) / §12.2 (Session Termination Codes)
- `decodeKnownPropertyVarint` / `decodeProperties` / `decodeImmutableProperties` / `parseProperties` / `assertKnownPropertyValueInObjectProperties` (`src/properties.ts`)
- `issues/closed/0475-bug-message-slice-boundary-checks.md` (Length 宣言超過を ProtocolViolationError に統一した先行判断)
- `issues/closed/0562-bug-key-value-formatting-error-session-close.md` (varint 不完結を KEY_VALUE_FORMATTING_ERROR で閉じる経路)
- `issues/closed/0586-bug-object-property-known-type-kvf.md` (Object Properties の既知 Type 検証を追加した先行 issue。本 issue はその残量検査を拡張する)
