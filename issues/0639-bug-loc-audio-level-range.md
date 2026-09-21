# Audio Level の値域検証が無く 8 bit を超える値を黙って切り捨てる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-loc-audio-level-range
- Polished: 2026-09-21

## 目的

draft-ietf-moq-loc-04 §2.3.3.2 は Audio Level の Value を「vi64 (1-2 bytes to encode values 0x00-0xFF)」と定める (TIMESTAMP や TIMESCALE は「vi64 (1-9 bytes)」であり、Audio Level だけが 0x00-0xFF に限られる)。値域外を受理すると下位 8 bit に丸めた誤った level と voiceActivity をアプリへ渡す。draft-ietf-moq-transport-21 §8.3 は「既知 Type の Value または Length/Value がその Type の serialization と一致しない場合、KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST」を定めるため、値域外はこの規則で拒否する。

## 現状

- `src/loc.ts` の `decodeAudioLevelValue` は `Number(value & 0xffn)` で下位 8 bit だけを取り出すため、0xFF を超える値でも例外にならず、誤った level と voiceActivity を返す (0x100 は level 0 / voiceActivity false になる)
- `decodeAudioLevelValue` は private で、受信経路は `resolveAudioProperties` → `decodeAudioProperties` → `extractLocProperties` → `decodeAudioLevelValue`。`src/createMediaSubscriber.ts` の `handleAudioObject` と devtools の subscriber がこの経路を通る
- `decodeAudioLevel` は単一 Property 前提のデコーダで、呼び出し元は `src/loc.prop.ts` と `src/loc.test.ts` のテストだけであり、実受信経路では使われない。値域検証も無い
- `extractLocProperties` は「抽出不能・不正な Property は読み飛ばし、抽出できたフィールドのみを返す (セッションを閉じない)」契約で、VIDEO_FRAME_MARKING は data 長が 1-4 バイトでなければ読み飛ばす。AUDIO_LEVEL には同じ値域の扱いが無い
- `src/properties.ts` の `assertKnownPropertyValueInObjectProperties` (Object Properties の検証。`src/dataStream/datagram.ts` / `subgroup.ts` / `fetch.ts` から呼ばれる) は既知 Type でも varint が完結するかと Length しか見ず、値域を見ない。既知 Type の集合 `KNOWN_PROPERTY_TYPES` は MOQT / Track Property の ID だけで、LOC の AUDIO_LEVEL (0x0C) を含まない
- subscriber コールバック内の throw はセッションを閉じず購読の error 通知になるため、値域違反でセッションを閉じるには Object Properties の検証層で弾く必要がある
- `src/loc.test.ts` には誤 ID と不完全 varint のテストはあるが、値域のテストは無い

## 設計方針

- 値域の規則は「Value は 0x00-0xFF」の 1 箇所に固定する。`decodeAudioLevelValue` を `AudioLevel | null` を返す形にし、0xFF 超は null にする
- `extractLocProperties` は null を読み飛ばして `audioLevel` を未設定にする (VIDEO_FRAME_MARKING の長さ検証と同じ寛容側の扱い)。この経路がセッションを閉じない契約は維持する。JSDoc に AUDIO_LEVEL の値域の扱いを追記する
- §8.3 の MUST は Object Properties の検証層で満たす。`assertKnownPropertyValueInObjectProperties` で偶数 Type の値を復号したあと、AUDIO_LEVEL (0x0C) が 0xFF を超える場合は `SessionError` + `SessionErrorCode.KEY_VALUE_FORMATTING_ERROR` を投げてセッションを閉じる。`KNOWN_PROPERTY_TYPES` には追加せず、値域だけを見る判定を足す (他の LOC 型の寛容な扱いを変えないため)
- `decodeAudioLevel` にも同じ値域検証を足し、0xFF 超は `SessionError` + `SessionErrorCode.KEY_VALUE_FORMATTING_ERROR` で拒否する (単体デコーダと受信経路で規則を揃える)
- `src/loc.test.ts` に 0xFF (境界・成功)、0x100、0x1FF のテストを追加し、`decodeAudioLevel` / `resolveAudioProperties` / `assertKnownPropertyValueInObjectProperties` のそれぞれで期待値を固定する

## 完了条件

- 0xFF は従来どおり level と voiceActivity が得られる
- Object Properties として 0x100 / 0x1FF の AUDIO_LEVEL を受信すると、セッションが KEY_VALUE_FORMATTING_ERROR で閉じる
- `resolveAudioProperties` / `decodeAudioProperties` に 0x100 / 0x1FF を渡すと `audioLevel` が未設定になり、誤った level を返さない (セッションは閉じない)
- `decodeAudioLevel` は 0x100 / 0x1FF を `SessionError` (KEY_VALUE_FORMATTING_ERROR) で拒否する
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level の Value は vi64 で 0x00-0xFF を符号化する)
- draft-ietf-moq-transport-21 §8.3 (型を理解しているのに Value または Length/Value がその型の serialization と一致しない場合、KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST)

## 解決方法

{未着手}
