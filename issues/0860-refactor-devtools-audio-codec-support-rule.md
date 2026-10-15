# devtools の codec テストの音声対応確認を共有の判定関数に寄せる

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-devtools-audio-codec-support-rule

## 目的

WebCodecs の設定対応確認の規則が実装ごとに違うため、同じブラウザでも「対応しているか」の判定が経路によって変わる。音声エンコーダーの判定を `src/codec/configSupport.ts` の共有関数に寄せ、判定規則を 1 箇所にする。

## 現状

- `src/codec/configSupport.ts` の `isAudioEncoderConfigSupported` は、`supported` が明示的に true のときだけ対応とみなし、`isConfigSupported` の reject も非対応として扱い、`AudioEncoder` が無い環境は非対応 codec と区別できる文言で失敗させる
- `devtools/src/codec-test/support.ts` の `selectSupportedAudioCodec` は `AudioEncoder.isConfigSupported` を直接呼び、`!encoderSupport.supported` の truthy 判定で候補を除外する。reject した Promise を捕捉しないため、`isConfigSupported` が reject するブラウザでは候補の除外ではなくテストページの `runCodecTest` ごと reject する
- devtools の映像側は `isVideoDecoderConfigSupported` を `src/codec/configSupport.ts` から import しており (「規則は configSupport.ts を正本とする」と明記)、音声側だけ規則が揃っていない
- `AudioDecoder` 側の対応確認には共有関数が無い (`src/codec/configSupport.ts` は映像デコーダーと音声エンコーダーのみ)
- 候補の採用判定には実符号化のプローブ (`probeAudioEncoding`) があり、`isConfigSupported` の結果だけでは符号化の成否を保証しないことは 0634 で確認済みである

## 設計方針

- `selectSupportedAudioCodec` の `AudioEncoder` の判定を `isAudioEncoderConfigSupported` (`getAudioEncoderConfig` の結果を渡す) に置き換える
- reject は非対応として扱われ、除外理由 (`encoder unsupported`) に記録して次の候補へ進む。`AudioEncoder` が無い環境は共有関数のエラーになり、テストページのエラーとして読める
- 実符号化のプローブ (`probeAudioEncoding`) と候補順の解決 (`resolveAudioCodecCandidates`) は現状維持
- `AudioDecoder` 側の規則を共通化するかは、共有関数を足すかどうかを含めて実装時に判断する (この issue の対象外にしてよい)

## 完了条件

- `devtools/src/codec-test/support.ts` の音声候補の選定が `isAudioEncoderConfigSupported` を使っていること
- `isConfigSupported` が reject する場合も候補を非対応として除外し、テストページ全体を reject させないこと (除外理由が結果から読めること)
- `devtools/src/codec-test/support.test.ts` と実 Chromium の `tests/e2e/codec-wrappers.spec.ts` が通ること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 参照

- `src/codec/configSupport.ts` の `isAudioEncoderConfigSupported` / `isVideoDecoderConfigSupported`
- `devtools/src/codec-test/support.ts` の `selectSupportedAudioCodec` / `probeAudioEncoding` / `resolveAudioCodecCandidates`
- `devtools/src/codec-test/support.test.ts`
- `tests/e2e/codec-wrappers.spec.ts`
- `issues/closed/0634-bug-codec-wrappers-aac-flakiness.md` (実符号化のプローブを入れた経緯)
