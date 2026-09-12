# 既知 Type の Length 宣言超過が §8.3 の KEY_VALUE_FORMATTING_ERROR にならない

- Created: 2026-09-12
- Completed: 2026-09-12
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

## 解決方法

- `src/properties.ts` に `MAX_PROPERTY_VALUE_LENGTH` (2^16-1)、判定 `isKnownPropertyLengthOverrun`、`SessionError` 生成 `knownPropertyLengthOverrunError`、送出 `throwLengthOverrunError` を追加した。Length の varint は完結したが宣言値が残りバイトを超える場合、既知 Type は `SessionError(KEY_VALUE_FORMATTING_ERROR)`、未知 Type は `ProtocolViolationError` とし、Length が最大値を超える場合は最大値超過の MUST を優先して既知 Type でも `ProtocolViolationError` とする。
- 厳密デコーダの残量検査 7 箇所 (`decodeImmutableProperties` の外側と内側、`parseProperties` の外側・内側・未知奇数、`decodeProperties` の本体と入れ子走査) を `throwLengthOverrunError` に置き換えた。未知 Type のメッセージは従来どおり。
- Object Properties 経路の `assertKnownPropertyValueInObjectProperties` の残量検査を、既知 Type なら `KEY_VALUE_FORMATTING_ERROR`、未知 Type と上限超過なら寛容打ち切りに変更した。あわせて JSDoc を実態に合わせ、Object Properties 経路では上限超過を検証しないこと (上限超過の MUST は Track Properties の厳密デコーダのみ) を明記した。
- `src/session.ts` の fill fetch ストリーム受信 catch が `toProtocolViolationSessionError` を使っており `SessionError` を握り潰していたため、`toSessionCloseError` に変更し、他の受信経路と同じくエラーコードを保持して閉じるようにした。
- テスト: `src/properties.test.ts` に宣言超過 (既知 Type × 厳密デコーダ 3 種 / Object Properties 経路)、未知 Type の寛容打ち切り、最大値超過の回帰、境界値 (Length が残りバイトちょうど) を追加。`src/dataStream.datagram.test.ts` / `src/dataStream.subgroup.test.ts` / `src/dataStream.fetch.test.ts` に各デコーダ経由の宣言超過を追加。受信経路の終了コードは `src/session.test.ts` (fill fetch / Subgroup) と `src/session/incoming.test.ts` (datagram) で検証する。
- `CHANGES.md` の `## develop` に [FIX] を 2 件追加した。
