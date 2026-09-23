# Audio Level の値域検証が無く 8 bit を超える値を黙って切り捨てる

- Created: 2026-09-21
- Completed: 2026-09-24
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

- 値域の規則 (ID 0x0C / 上限 0xFF) を `src/properties.ts` の `LOC_AUDIO_LEVEL_PROPERTY_ID` / `LOC_AUDIO_LEVEL_MAX_VALUE` と `isLocAudioLevelValueInRange` / `locAudioLevelValueRangeError` に集約し、`src/loc.ts` の `LOCPropertyId.AUDIO_LEVEL` と `decodeAudioLevelValue` がそれを参照する形にした (loc.ts → properties.ts の既存依存の向きを維持し、循環を作らない)
- `decodeAudioLevelValue` は `AudioLevel | null` を返し、0xFF 超は null にした。`decodeAudioLevel` は null のとき `SessionError` + `KEY_VALUE_FORMATTING_ERROR` を投げる
- `extractLocProperties` は null を読み飛ばして `audioLevel` を設定しない (VIDEO_FRAME_MARKING の長さ検証と同じ寛容側の扱い)。`resolveAudioProperties` / `decodeAudioProperties` は値域外でも誤った level を返さない
- `assertKnownPropertyValueInObjectProperties` の偶数 Type 分岐で、値が varint として読めたあとに AUDIO_LEVEL かつ 0xFF 超なら `SessionError` + `KEY_VALUE_FORMATTING_ERROR` を投げる。`KNOWN_PROPERTY_TYPES` への追加はせず、値域だけを見る判定にした
- 仕様解釈: LOC §2.3.3.2 の Value 行は "vi64 (1-2 bytes to encode values 0x00-0xFF)" と値域を限定しており、Description 行の "encoded in the least significant 8 bits of a vi64" は RFC6464 のビット配置 (下位 7 bit が level、bit 7 が voice activity) の説明である。8 bit を超える値は下位 8 bit に丸めると誤った level になるため値域外として扱う
- テストは、境界値 0x00 / 0xFF の受理、`decodeAudioLevel` の 0x100 / 0x1FF 拒否、抽出経路の読み飛ばし、検証層の拒否、AUDIO_LEVEL 以外の偶数 Type が値域の影響を受けないこと、2 件目以降 (Delta Type の累積) の AUDIO_LEVEL も検証されることを固定した。加えて `src/loc.prop.ts` に 0x100 から MAX_VARINT までの全域を拒否する PBT を足した
- テスト専用の例外検証ヘルパー (`captureThrownError` / `assertKeyValueFormattingError`) を `src/testSupport/helpers.ts` に集約し、`src/properties.test.ts` の重複実装を削除した
- `CHANGES.md` の `## develop` 先頭に `[FIX]` と `[UPDATE]` を追記した

### 検証

- `npx vp check` / `npx vp test --run` (122 files / 2511 tests) が通る
- 変異テストで、値域判定を外す / 上限を変える / 検証層の判定を外す / ガードを全偶数 Type に弱める / 累積 ID ではなく Delta Type を見る / `decodeAudioLevel` の throw を外す / 抽出経路で読み飛ばさない、のいずれでも対応するテストが失敗することを確認した
- Object Properties に値域外の AUDIO_LEVEL を含む Object は、datagram / subgroup / fetch (fill 含む) の各受信経路で配送前に拒否され、`toSessionCloseError` がコードを保持してセッションを閉じることを机上で確認した

## 残した課題

- Immutable Properties (0x0B) の内側の Property は `assertKnownPropertyValueInObjectProperties` が走査しないため、内側に置かれた値域外の AUDIO_LEVEL は拒否されない (既存の varint / Length 検証も同じ範囲)。draft-ietf-moq-transport-21 §10.7 は内側も Property として検索する MUST を定めており、`src/filter.ts` の `findPropertyValueRecursive` は既に内側を検索している。入れ子を含めた §8.3 の検証は別途扱う
- エンコード側の `encodeAudioLevel` は `level & 0x7f` で丸めるため、`level` の値域 (RFC6464 の 0-127) を検証しない。デコード側の厳格化とは非対称であり、別途扱う
- 値域外の AUDIO_LEVEL を含む Object を受信してセッションが閉じることを、dataStream の実ワイヤ構築で固定する統合テストは追加していない (検証層の throw → `toSessionCloseError` → `closeWithError` の機構は既存テストで実証済み)
- Track Property として届いた AUDIO_LEVEL は LOC Table 1 では Object スコープのため、値域検査も抽出もされない (誤った level を返す経路は無い)
