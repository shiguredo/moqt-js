# 映像エンコードキューの閾値 2 が名前付き定数になっていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-video-encode-queue-limit-constant
- Polished: 2026-09-24

## 目的

closed の `0650-bug-video-encoder-backpressure.md` の調査で、映像のエンコードキュー上限 `2` がコードのリテラルとドキュメント / CHANGES に散在していることが判明した。閾値の意味 (エンコード能力を超えた入力を待たずに破棄する境界) が名前で表されておらず、値を変える場合はコードと文書を突き合わせて回る必要がある。`VideoStats.droppedFrames` の説明からも閾値に辿れない。

同ファイルの他の既定値 (Publisher Priority) は名前付き定数として export され、「単体テストから値を固定するため export する (パッケージ公開 API には含めない)」という方針がコメントで明示されている。閾値だけがこの扱いから外れている。

## 現状

- `src/createMediaPublisher.ts` の `processVideoFrames` (837 行目) は `encoder.encodeQueueSize <= 2` で投入を判定する (861 行目)。`2` の説明は近傍のコメント (864-865 行目「エンコード能力を超えた入力はエンコードせず破棄する (待たない)」) にしかない
- 同ファイルの Publisher Priority は名前付き定数である: `PRIORITY_CATALOG` (54 行目) / `PRIORITY_VIDEO_KEY` (57 行目) / `PRIORITY_AUDIO` (60 行目) / `PRIORITY_VIDEO_DELTA` (63 行目)。`// デフォルト設定` の節 (46 行目) にまとめられ、48-51 行目のコメントで「単体テストから値を固定するため export する (パッケージ公開 API には含めない)」と方針が書かれている
- `src/index.ts` は `createMediaPublisher` と関連する型だけを再エクスポートしており (151 行目以降)、`PRIORITY_*` は公開 API に含まれない
- `docs/HIGH_LEVEL_API.md` の `VideoStats` (146-153 行目) は `droppedFrames` を「エンコードが追いつかないため待たずに破棄したフレーム数」と説明する (148-149 行目)。閾値の存在も値も書かれていない
- `CHANGES.md` の `## develop` は `createMediaPublisher` の `encodeQueueSize <= 2` の判定 (19 行目) と「閾値 (`<= 2`)」 (21 行目) という形でリテラルを書いている
- `src/createMediaPublisher.test.ts` の `createRecordingEncoder` (74 行目) は `encodeQueueSize` を引数で受け取り、テストはリテラルで閾値の内外を作る (186 行目のテスト名「閾値 (2) を超えたフレームは破棄され…」と 190 行目のコメント「3 > 2」、215-216 行目の「2 <= 2」)
- devtools 本体にも同じ閾値のリテラルがある (`devtools/src/hooks/usePublisher.ts` 484 行目の `encoderInstance.encodeQueueSize <= 2`)。0678 が扱う

## 設計方針

- `src/createMediaPublisher.ts` に名前付き定数を置き、`processVideoFrames` の判定を定数に置き換える。名前は「映像のエンコードキュー上限」を表すものにする (案: `MAX_VIDEO_ENCODE_QUEUE_SIZE`)。既存の `PRIORITY_*` と同じ `// デフォルト設定` の節に置き、同じ方針 (単体テストから値を固定するため export し、パッケージ公開 API には含めない) のコメントを付ける
- 定数の JSDoc に意味を書く。Worker モードの `encodeQueueSize` は Worker へ送信してまだ `encoded` 応答が返っていないフレーム数であり、Worker 内の実キュー長より多く見える安全側の近似であること (0650)、失敗した Worker では凍結する扱いになること (0701) を記述する
- 値は変えない (挙動を変えない純粋なリファクタとする)
- `docs/HIGH_LEVEL_API.md` の `droppedFrames` の説明を「キュー長が上限を超えたフレームを待たずに破棄する」の意味が分かる文に揃える。上限の値そのものはコードを正本とするため書かない
- `CHANGES.md` の `## develop` の該当 2 箇所 (19 行目 / 21 行目) を定数名の表記に揃える。未リリースの節の記述であり、新しいエントリは足さない (公開 API の変更ではないため)
- `src/createMediaPublisher.test.ts` は定数を import して閾値の内外を作る (テスト内にリテラル `2` を残さない)。テスト名とコメントも定数名に合わせる
- 対象は `src/createMediaPublisher.ts` / `src/createMediaPublisher.test.ts` / `docs/HIGH_LEVEL_API.md` / `CHANGES.md` とする
- 対象外: 閾値の値の見直し (挙動変更)、devtools 本体の同型 (0678)、キーフレーム要求の喪失 (0680)

## 完了条件

- `src/createMediaPublisher.ts` の `processVideoFrames` にリテラル `2` が残らず、名前付き定数を通る
- 定数が export され、`src/index.ts` の再エクスポートに含まれない (パッケージ公開 API が変わらない)
- `src/createMediaPublisher.test.ts` が定数を import し、閾値超過の破棄と閾値以内の encode を固定するテストにリテラル `2` が残らない
- `docs/HIGH_LEVEL_API.md` の `droppedFrames` の説明が閾値による破棄であることを述べ、実装と矛盾しない
- `CHANGES.md` の `## develop` の該当記述が定数名で揃う
- 閾値の値と挙動 (閾値超過で破棄し `droppedFrames` を数える) が変わらない
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed の `0650-bug-video-encoder-backpressure.md` (閾値 `<= 2` の由来と Worker モードの意味)
- 0678 (devtools 本体の同型のバックプレッシャ)
- 0680 (キュー超過で破棄されたフレームのキーフレーム要求)
- WebCodecs の `VideoEncoder.encodeQueueSize` (https://w3c.github.io/webcodecs/#dom-videoencoder-encodequeuesize)
- `docs/HIGH_LEVEL_API.md` の統計情報 (`VideoStats.droppedFrames`)、`CHANGES.md` の `## develop`

## 解決方法

{未着手}
