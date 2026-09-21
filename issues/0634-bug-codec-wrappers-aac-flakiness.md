# codec-wrappers の音声テストが AAC 選択時に符号化できず落ちる

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-codec-wrappers-aac-flakiness
- Polished: 2026-09-21

## 目的

`tests/e2e/codec-wrappers.spec.ts` の音声テストが手元の Chromium で稀に失敗するという観測があり、原因を特定する過程で codec 選択の欠陥が判明した。`selectSupportedAudioCodec` は `AudioEncoder.isConfigSupported` と `AudioDecoder.isConfigSupported` の結果だけを信用して候補を選ぶため、AAC しか対応しないと報告する環境では、符号化できない AAC を採用してからテストが失敗する。符号化の成否を実ブラウザで確かめたうえで候補を採用し、環境依存の失敗をタイムアウトではなく選択時点の明示的なエラーにする。

## 現状

- `tests/e2e/codec-wrappers.spec.ts` の `AudioEncoderWrapper 直接モード: 対応コーデックで chunk が出力される` / `AudioEncoderWrapper Worker モード: Worker 経由でも chunk が出力される` は、`devtools/src/codec-test/support.ts` の `selectSupportedAudioCodec` が選んだ codec を `devtools/src/codec-test/audio.ts` の `runAudioEncoderTest` で符号化する。判定に使う `AUDIO_CODEC_CANDIDATES` は `["opus", "aac"]` で、`AudioEncoder.isConfigSupported` と `AudioDecoder.isConfigSupported` の両方が true になった最初の候補を返す
- Chromium は opus に対応しているため、現行の e2e で AAC が選ばれることはない (候補順は導入時から変わっていない)。AAC を選ばせて実測すると、`isConfigSupported` は true を返すのに符号化は `EncodingError` になり、成功する回は無い (リポジトリ外の検証用ページで raw の `AudioEncoder` に 100 ms x 10 の無音を投入した実測。Playwright 1.63.0 の Chromium 153.0.8010.12 で AAC は 5 回試行して 5 回失敗、opus は同じ設定で 5 回とも成功する)
- AAC の `isConfigSupported` が true でも実際の encode が `EncodingError` になることは closed の 0495 と 0605 に記録済みで、`codec-wrappers.spec.ts` の音声テストにも同じ前提のコメントがある。しかし `selectSupportedAudioCodec` は今も符号化の成否を確かめないまま `isConfigSupported` の結果だけで選ぶため、opus が非対応のブラウザでは符号化できない AAC を採用して必ず失敗する。AAC の符号化が成功する環境では description が載って `expect(chunk.descriptionByteLength).toBeNull()` に落ち、失敗する環境では出力が 0 件のまま `runAudioEncoderTest` の `waitForQuiet` (既定 10 秒) がタイムアウトしてテストページの `runCodecTest` ごと reject し、アサーションには到達しない
- テストの失敗は E2E ジョブを赤くする。Playwright は `workers: 1` / `fullyParallel: false` でテストを独立に実行するため他ファイルのテストへは伝播せず、`devtools-audio.spec.ts` は `AudioEncoder` を構成しない。`codec-wrappers.spec.ts` 内では、同じ codec の参照 chunk を作る `AudioDecoderWrapper` の 2 件と「未設定時」のテストも同じ失敗で落ちる
- `npx vp run e2e-test` を繰り返しても AAC を含むテストは実行されないため、「稀に失敗する」の再現手順 (AAC を選ばせた方法) も失敗時の観測値も残っていない
- `isConfigSupported` は対応可否しか返さず、実際の符号化の成否を保証しない (devtools の publisher も `isConfigSupported` だけで判定し、エラーは `AudioEncoder` の error コールバックで扱っている)

## 設計方針

- `selectSupportedAudioCodec` の判定に実符号化の確認を加える。`AudioEncoder.isConfigSupported` と `AudioDecoder.isConfigSupported` の既存の確認は維持し、そのうえで候補ごとに短い `AudioData` を 1 回符号化し、`flush()` してから出力 chunk が得られた候補だけを採用する (`encode()` の出力は非同期に届くため到着を待つ必要があり、実測では短い入力だと `flush()` するまで 1 件も届かなかった)
- プローブは候補ごとに待ち上限を短く区切り (`waitForQuiet` の既定 10 秒は使わない)、error コールバックで失敗が確定した時点でその候補を除外する。プローブの `AudioEncoder` は必ず `close()` する (AAC の符号化失敗を短時間に繰り返すと Chromium の GPU プロセスが落ちることを実測している)
- 符号化に失敗した候補は非対応として扱い、codec 名とエラーを記録して次の候補へ進む。除外理由は `selectSupportedAudioCodec` の戻り値 (`AudioCodecType`) からは読めないため、選定結果を codec と除外理由の組で返すか、結果オブジェクト (`AudioEncoderTestResult` / `AudioDecoderTestResult`) に項目を足して、encoder / decoder 双方のテスト結果から読めるようにする
- 符号化できる codec が 1 つも無い場合だけ `selectSupportedAudioCodec` が Error を投げる現行の契約は維持する (非対応 codec を理由にテストを skip させない)
- 再現経路を用意する: 候補順を差し替えて AAC を先頭に固定する手段を足し、実際に選ばれた codec をテスト結果の `result.codec` で確認できるようにする。`codec-wrappers.spec.ts` は `CODEC_TEST_URL` 固定でページを開くため、ページ側にクエリパラメータを足すだけでは e2e から発動しない (ページに渡す経路までを変更対象に含める)
- タイミング依存 (キューの詰まり、Worker モードと直接モードの差) の切り分けは、再現経路ができてから `waitForQuiet` の待ち方と `feedSilentAudio` の投入間隔で行う
- opus で検証できている範囲 (chunk の契約、description を持たないこと) を落とさないこと。AAC が実際に符号化できる環境で AAC が採用された場合の `expect(chunk.descriptionByteLength).toBeNull()` は本 issue の対象外とする (現状でも同じ環境では落ちるため、別途扱う)

## 完了条件

- 符号化に失敗する codec が候補から除外され、除外理由 (codec 名とエラー) が encoder / decoder 双方のテスト結果から読める (テストは skip しない)
- 候補順を AAC 先頭に差し替えた状態で `npx vp run e2e-test` を実行しても、AAC が除外されて opus が選ばれ (`result.codec` が `opus`)、音声テストが通る
- 符号化できる codec が 1 つも無い環境では、テストのタイムアウトではなく選択時点の明示的な Error で失敗する (現行契約どおりテストは skip しない)
- 起点の観測 (音声テストが稀に失敗する) について、試行内容と再現有無を issue に記録する
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.1 (Audio Config: WebCodecs の `EncodedAudioChunkMetadata` の `AudioDecoderConfig.description` に対応する)
- closed 0495 / closed 0605 (AAC の `isConfigSupported` が true でも encode が `EncodingError` になる実測記録)

## 解決方法

{未着手}
