# ライブラリの映像エンコードキューの閾値 2 が名前付き定数になっていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-video-encode-queue-limit-constant
- Polished: 2026-10-26

## 目的

closed の `0650-bug-video-encoder-backpressure.md` の調査で、ライブラリの映像エンコードキュー上限 `2` が `src/createMediaPublisher.ts` のリテラルとして残っていることが判明した。閾値の意味 (エンコード能力を超えた入力を待たずに破棄する境界) が名前で表されておらず、値を変える場合はライブラリのコードとテスト、devtools の定数を突き合わせて回る必要がある。`VideoStats.droppedFrames` の説明からも閾値に辿れない。

0678 で devtools 側は `devtools/src/utils/encodeQueueBackpressure.ts` の `MAX_VIDEO_ENCODE_QUEUE_SIZE` として名前付き定数化されたが、ライブラリ側のリテラルとは別に定義されており、値を変えるときは両方を合わせる必要がある。ライブラリ側の定数化と同時に devtools の重複を解消できる。

同ファイルの Publisher Priority は名前付き定数として export され、「単体テストから値を固定するため export する (パッケージ公開 API には含めない)」という方針がコメントで明示されている。閾値だけがこの扱いから外れている。

## 現状

- `src/createMediaPublisher.ts` の `processVideoFrames` は `encoder.encodeQueueSize <= 2` で投入を判定する。`2` の説明は近傍のコメント「エンコード能力を超えた入力はエンコードせず破棄する (待たない)」にしかない
- 同ファイルの Publisher Priority は名前付き定数である: `PRIORITY_CATALOG` / `PRIORITY_VIDEO_KEY` / `PRIORITY_AUDIO` / `PRIORITY_VIDEO_DELTA`。`// デフォルト設定` の節にまとめられ、「単体テストから値を固定するため export する (パッケージ公開 API には含めない)」と方針が書かれている
- `src/index.ts` は `createMediaPublisher` と関連する型だけを再エクスポートしており、`PRIORITY_*` は公開 API に含まれない
- `docs/HIGH_LEVEL_API.md` の `VideoStats` は `droppedFrames` を「エンコード能力を超えたため、または実行時エラーでエンコーダーが使えなくなったために破棄したフレーム数」と説明する。キュー上限による破棄であることと上限の存在は書かれていない。音声の追いつきの節には `encodeQueueSize` が上限を超えたフレームを捨てる旨があるが、値は書いていない
- `CHANGES.md` の `## develop` には現在 `encodeQueueSize` の記述がない。0650 の `encodeQueueSize <= 2` に関する記述は既に削除されている
- `src/createMediaPublisher.test.ts` の `createRecordingEncoder` は `encodeQueueSize` を引数で受け取り、テストはリテラルで閾値の内外を作る。テスト名「processVideoFrames: encode キューの閾値 (2) を超えたフレームは破棄され droppedFrames に数える」、コメント「3 > 2 のため全フレームが破棄対象になる」「2 <= 2 のため破棄しない (droppedFrames は増えない)」「キューが閾値 (2) を超えた状態で新しい Group を要求する」、`injectVideoLoop(control, 3)` / `injectVideoLoop(control, 2)` が該当する
- devtools は `devtools/src/utils/encodeQueueBackpressure.ts` に `MAX_VIDEO_ENCODE_QUEUE_SIZE = 2` を定義し、`shouldDropFrame` で判定する。`devtools/src/hooks/usePublisher.ts` は `shouldDropFrame` を使う。0678 は closed であり、この定数のコメントは「ライブラリ側が上限を公開する定数を持てば、この値は削除してその定数を使う」と書いている
- `devtools/src/utils/encodeQueueBackpressure.test.ts` は境界判定と `MAX_VIDEO_ENCODE_QUEUE_SIZE === 2` を固定している

## 設計方針

- `src/createMediaPublisher.ts` に名前付き定数 `MAX_VIDEO_ENCODE_QUEUE_SIZE` を置き、`processVideoFrames` の判定を定数に置き換える。`// デフォルト設定` の節に置き、単体テストと devtools から参照するため export する (パッケージ公開 API には含めない) 旨のコメントを付ける
- 定数の JSDoc に意味を書く。Worker モードの `encodeQueueSize` は Worker へ送信してまだ `encoded` 応答が返っていないフレーム数であり、Worker 内の実キュー長より多く見える安全側の近似であること、Worker 内のエンコーダーが実行時エラーで閉じた後は凍結した値のままになり、エンコーダーの状態が `configured` でなくなるため処理ループが終了すること (以後のフレームは読み取らない。再 configure か close で数え直す) を記述する。JSDoc には issue 番号を書かず、意味そのものを書く
- 値は変えない (ライブラリも devtools も 2 のまま。挙動を変えない純粋なリファクタとする)
- `docs/HIGH_LEVEL_API.md` の `VideoStats.droppedFrames` の説明を、キュー長が上限を超えたフレームを待たずに破棄する意味が分かる文に揃える。現在の実行時エラーによる破棄の説明も残す。上限の値そのものはコードを正本とするため書かない
- `CHANGES.md` は変更しない。該当する `encodeQueueSize <= 2` の記述は既にない。公開 API の変更でもないため、新しいエントリも足さない
- `src/createMediaPublisher.test.ts` は定数を import して閾値の内外を作る。閾値の内外を作る箇所にリテラル `2` を残さない。テスト名とコメントも定数名に合わせる
- `devtools/src/utils/encodeQueueBackpressure.ts` は `../../../src/createMediaPublisher.ts` から `MAX_VIDEO_ENCODE_QUEUE_SIZE` を import し、devtools 側の同名定数の定義を削除する。`shouldDropFrame` は import した定数を使う。モジュールのコメントを、上限はライブラリの定数を使う旨に更新する
- `devtools/src/utils/encodeQueueBackpressure.test.ts` は `shouldDropFrame` の境界判定を維持し、`MAX_VIDEO_ENCODE_QUEUE_SIZE` を `../../../src/createMediaPublisher.ts` から import する。`MAX_VIDEO_ENCODE_QUEUE_SIZE === 2` の固定は削除する (同じ定数を使うため自明になる)
- 対象は `src/createMediaPublisher.ts` / `src/createMediaPublisher.test.ts` / `docs/HIGH_LEVEL_API.md` / `devtools/src/utils/encodeQueueBackpressure.ts` / `devtools/src/utils/encodeQueueBackpressure.test.ts` とする
- 対象外: 閾値の値の見直し (挙動変更)、`devtools/src/hooks/usePublisher.ts` の判定経路と `EncoderWrapper` の挙動 (0678 で完了済み)、キーフレーム要求の喪失 (0680 で完了済み)

## 完了条件

- `src/createMediaPublisher.ts` の `processVideoFrames` にリテラル `2` が残らず、名前付き定数を通る
- 定数が export され、`src/index.ts` の再エクスポートに含まれない (パッケージ公開 API が変わらない)
- `src/createMediaPublisher.test.ts` が定数を import し、閾値超過の破棄と閾値以内の encode を固定するテストのうち、閾値の内外を作る箇所にリテラル `2` が残らない。テスト名とコメントが定数名に合う
- `devtools/src/utils/encodeQueueBackpressure.ts` に `MAX_VIDEO_ENCODE_QUEUE_SIZE = 2` の定義が残らず、ライブラリの定数を使う。`shouldDropFrame` の境界挙動 (上限ちょうどは投入、超過は破棄) が変わらない
- `devtools/src/utils/encodeQueueBackpressure.test.ts` の境界判定がライブラリの定数を使い、リテラル `2` の比較が残らない
- `docs/HIGH_LEVEL_API.md` の `VideoStats.droppedFrames` の説明が、キュー上限による破棄と実行時エラーによる破棄の両方を述べ、実装と矛盾しない
- `CHANGES.md` が変更されていない
- 閾値の値と挙動 (閾値超過で破棄し `droppedFrames` を数える) がライブラリと devtools で変わらない
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed の `0650-bug-video-encoder-backpressure.md` (閾値 `<= 2` の由来と Worker モードの意味)
- closed の `0678-bug-devtools-encoder-backpressure.md` (devtools の `MAX_VIDEO_ENCODE_QUEUE_SIZE` と、ライブラリの定数を使う計画)
- closed の `0680-bug-dropped-keyframe-request.md` (キュー超過で破棄されたフレームのキーフレーム要求。本 issue の対象外)
- WebCodecs の `VideoEncoder.encodeQueueSize` (https://w3c.github.io/webcodecs/#dom-videoencoder-encodequeuesize)
- `docs/HIGH_LEVEL_API.md` の統計情報 (`VideoStats.droppedFrames`)
- `src/codec/VideoEncoder.ts` の `encodeQueueSize` の JSDoc (Worker モードの意味)
- `src/codec/workerConfigure.ts` の `SentFrameCounter` の `freeze` (実行時エラー後の凍結)
- `devtools/src/utils/encodeQueueBackpressure.ts` と `devtools/src/utils/encodeQueueBackpressure.test.ts`

## 解決方法

{未着手}
