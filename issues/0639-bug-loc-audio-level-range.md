# Audio Level の値域検証が無く 8 bit を超える値を黙って切り捨てる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-loc-audio-level-range
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 §2.3.3.2 は Audio Level の Value を「vi64 (1-2 bytes to encode values 0x00-0xFF)」と定める。値域外を受理すると誤った level と voiceActivity をアプリへ渡したうえ、draft-ietf-moq-transport-21 §8.3 が要求する KEY_VALUE_FORMATTING_ERROR での切断も行えない。

## 現状

- `src/loc.ts` の `decodeAudioLevelValue` は `Number(value & 0xffn)` で下位 8 bit だけを取り出すため、0xFF を超える値でも例外にならず、誤った level と voiceActivity を返す
- `decodeAudioLevel` は `decodeAudioLevelValue` を呼ぶだけで値域を検証しない
- `decodeAudioLevelValue` は `extractLocProperties` からも呼ばれる。こちらは「抽出不能・不正な Property は読み飛ばし、抽出できたフィールドのみを返す」という寛容な契約で、セッションを閉じない
- `src/properties.ts` の `assertKnownPropertyValueInObjectProperties` は既知 Type の varint が復号できるかしか見ておらず、値域は見ていない
- `src/loc.test.ts` には誤 ID と不完全 varint のテストはあるが、値域のテストは無い

## 設計方針

- `decodeAudioLevel` に値域検証を追加し、0xFF 超を KEY_VALUE_FORMATTING_ERROR 系の例外で拒否する
- `extractLocProperties` の寛容な契約は変えない。`decodeAudioLevelValue` 側に検証を置く場合は、この経路がセッションを閉じないことを保つ
- `src/loc.test.ts` に 0xFF (境界・成功)、0x100、0x1FF (失敗) のテストを追加する

## 完了条件

- 0xFF は成功し、0x100 と 0x1FF は拒否される
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level の Value は vi64 で 0x00-0xFF を符号化する)
- draft-ietf-moq-transport-21 §8.3 (型を理解しているのに Value または Length/Value がその型の serialization と一致しない場合、KEY_VALUE_FORMATTING_ERROR でセッションを閉じる MUST)

## 解決方法

{未着手}
