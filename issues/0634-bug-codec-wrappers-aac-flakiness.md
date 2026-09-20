# codec-wrappers の AAC 符号化テストが稀に失敗する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-codec-wrappers-aac-flakiness
- Polished: {YYYY-MM-DD}

## 目的

`tests/e2e/codec-wrappers.spec.ts` の音声テストが、手元の Chromium で稀に失敗する。`AudioEncoder.isConfigSupported` が true を返す設定 (AAC-LC、48000 Hz、2ch、64000 bps) でも、符号化が `EncoderStatus::Internal Error` で `EncodingError` / `OperationError` になることがあり、同じ条件で成功する回もある。

失敗すると、そのテストだけでなく後続の `devtools-audio.spec.ts` なども巻き込んで E2E ジョブが不安定になる。原因を特定し、テストが環境依存で落ちないようにする。

## 現状

- `tests/e2e/codec-wrappers.spec.ts` の `AudioEncoderWrapper 直接モード / Worker モード` は、`devtools/src/codec-test/support.ts` の `selectSupportedAudioCodec` が選んだ codec で符号化する。候補は `opus` → `aac` の順で、opus が対応していれば AAC は選ばれない
- 手元の実測では opus は常に成功し、AAC は「同じ条件で成功する回と `EncoderStatus::Internal Error` になる回がある」ことを確認している (Chromium のログに `WARNING:media/mojo/clients/mojo_audio_encoder.cc:159] EncoderStatus::Internal Error.` が出る)
- `npx vp run e2e-test` を繰り返すと、AAC を含むテストが時々失敗する。CI (GitHub Actions) では再現していない
- `isConfigSupported` は対応可否しか返さず、実際の符号化の成否は保証しない (devtools の publisher も同じ前提で、`AudioEncoder` の error コールバックでエラーを扱っている)

## 設計方針

- まず原因を切り分ける: `AudioData` の投入間隔 (エンコーダのキュー詰まり)、`flush()` のタイミング、Worker モードと直接モードの差、`EncodedAudioChunkMetadata` の description の有無で再現率が変わるかを実測する
- テスト側で吸収できる原因 (タイミング依存) なら、`waitForCondition` の待ち方や `flush()` の位置を直す。環境 (Chromium のエンコーダ実装) 依存で回避できないなら、AAC を候補から外すのではなく「非対応としてスキップし、理由をログに残す」形にする (モックで隠さない)
- `selectSupportedAudioCodec` の候補順や、AAC を選んだときの期待値を変える場合は、opus で検証できている範囲を落とさないこと

## 完了条件

- 失敗の原因 (テスト側のタイミングか、ブラウザの実装依存か) が特定され、issue に記録される
- 原因に応じた修正により、`npx vp run e2e-test` を繰り返しても AAC を含むテストが安定して通る (または、環境依存として明示的にスキップされ、理由がログに残る)
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config: WebCodecs の `EncodedAudioChunkMetadata` の `AudioDecoderConfig.description` に対応する)

## 解決方法

{未着手}
