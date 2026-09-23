# Worker モードで映像エンコーダのバックプレッシャが無効になっている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-encoder-backpressure
- Polished: 2026-09-23

## 目的

`src/createMediaPublisher.ts` の映像処理ループは `encoder.encodeQueueSize <= 2` のときだけ `encode` し、超えたフレームは `frame.close()` で破棄する (待たない)。Worker モードでは `encodeQueueSize` が常に 0 を返すためこの判定が常に真になり、破棄されずに全フレームが Worker へ送られる。1080p の `VideoFrame` を 4:2:0 (NV12) で渡した場合は 1920 * 1080 * 1.5 = 3,110,400 バイト (約 3.1 MB) で、画素形式は取得経路と UA に依存するため 4:2:0 でなければさらに増える (RGBA なら 8,294,400 バイト)。エンコード能力を超えた入力が続くと Worker 側のキューが無制限に伸びる。

## 現状

- `src/codec/VideoEncoder.ts` の `encodeQueueSize` getter は Worker モードで「Worker モードでは直接取得できない」として 0 を返す
- `src/codec/VideoEncoder.ts` の `encode` は Worker モードで `frame` を transfer して `postMessage` するだけである
- `src/codec/workers/videoEncoder.worker.ts` の `encode` ハンドラは `isCodecConfigured` が真なら `videoEncoder.encode()` を呼び、真偽にかかわらず `message.frame.close()` を呼ぶ。キュー長を main 側へ返す経路が無い
- `src/codec/workerMessages.ts` の `VideoEncoderWorkerResponse` にキュー長を伝える応答型が無い
- `src/createMediaPublisher.ts` の `useWorker` の既定値は true のため、既定経路がこの状態になる
- `tests/e2e/codec-wrappers.spec.ts` は「Worker モードの encodeQueueSize は取得できないため常に 0 を返す契約」として `queueSizeAfterEncode` が 0 であることと、6 回の encode で 6 chunk が出ることを pin している。`devtools/src/codec-test/video.ts` がこの値を収集している
- `src/codec/types.ts` の `VideoStats` は `framesSent` / `keyFramesSent` / `bytesSent` / `currentGroupId` だけで、破棄したフレームを数えるフィールドが無い。`VideoStats` は `src/index.ts` から再エクスポートされる公開型である
- `devtools/src/utils/EncoderWrapper.ts` の `encodeQueueSize` も Worker モードで 0 を返し、`devtools/src/hooks/usePublisher.ts` が同じ判定を使う。devtools 本体の同型は 0678 が扱う

## 設計方針

- 方式は main 側で送信中のフレーム数を数える案を採る。`VideoEncoderWrapper` が Worker モードで `encode` した数を増やし、`encoded` 応答を受け取った数だけ減らす。`encodeQueueSize` は Worker モードでこの送信中のフレーム数を返す。Worker モードの値が 0 固定という現在の契約は捨て、`src/`・`tests/e2e/codec-wrappers.spec.ts`・`devtools/src/codec-test/` にある旧契約を前提にした記述とテストを直す (devtools 本体の `EncoderWrapper` / `usePublisher` は 0678 が扱う)
- 増加は `postMessage` が成功した後に数える (`postMessage` が throw した場合に減らない数を残さない)。減算は `callbacks.output` を呼ぶ前に済ませる。`output` の中身 (publisher 側の `LOC.encodeVideoProperties` / `sendObject`) が例外を投げても数が戻るようにする
- カウントは 0 未満にせず、`configure` で Worker を差し替えたとき (旧 Worker は terminate されて `encoded` が返らない) と `close` したときに 0 にリセットする。リセットしないと再 configure 後にカウントが閾値超のまま張り付き、以後すべてのフレームが破棄される
- Worker 内の encoder が error で閉じた後は `encoded` が返らずカウンタは増える一方になるため、遅くとも数フレームで閾値を超え、以後のフレームは破棄される。このときフレームは実際にエンコードされ得ない (`videoEncoder.worker.ts` の `encode` は `isCodecConfigured` が false なら `encode` を呼ばず `message.frame.close()` だけを行う) ため実害はなく、復帰しない相手への転送を止める安全側の挙動とする。error ではリセットしない。復帰は wrapper の再 configure、または `MediaPublisherImpl` の stop → start (`start` ごとに新しい wrapper を作る) で行う
- この値は Worker 内の `VideoEncoder.encodeQueueSize` そのものではなく、Worker のメッセージ待ち行列と encoder のキューを合わせた上限側の近似である。安全側 (実際より多く見える) に倒れるため、既存の閾値 `<= 2` をそのまま使う。Worker プロトコル (`workerMessages.ts` の応答型) は変更しない
- 閾値を超えたフレームは現行どおり破棄する (待たない)。破棄した数を `VideoStats` に `droppedFrames` として追加し、`docs/HIGH_LEVEL_API.md` の統計の記述にも載せる。`encodeQueueSize` の Worker モードの意味 (実キュー長ではなく送信中のフレーム数) を `src/codec/VideoEncoder.ts` の JSDoc に明記する
- `tests/e2e/codec-wrappers.spec.ts` は Worker モードの `queueSizeAfterEncode` を 0 から 6 へ更新し、旧契約を書いたコメント (「Worker モードの encodeQueueSize は取得できないため常に 0 を返す契約」) も直す。`devtools/src/codec-test/video.ts` / `types.ts` に出力待機後の `encodeQueueSize` の観測を足し、`encoded` 受信ごとの減算を pin する。出力待機前は直接モードと同じく投入フレーム数 (6)、出力待機後は 0 になる
- Worker 生成と WebCodecs はブラウザ依存で Node の単体テストでは動かせない。送信中カウンタは `src/codec/workerConfigure.ts` に置く。同モジュールの `WorkerConfigureGate` / `ConfigureGenerationTracker` と同じ、ブラウザ非依存の純粋な worker 契約ロジックとして扱い、モジュールのヘッダコメントを更新して送信キューのロジックも置くことを明記する。`src/codec/workerConfigure.test.ts` のヘッダコメントも送信キューのテストを含む形に更新する。増減・リセット・0 未満防止は `src/codec/workerConfigure.test.ts` で固定する。0678 はこのクラスをそのまま import する (`workerConfigure.ts` / `workerConfigure.test.ts` の位置は 0678 が既に前提にしている)
- 配線 (`VideoEncoderWrapper` からの増加・減算・リセットの呼び出し位置) はブラウザ依存のため e2e とレビューで確認する
- 対象は `src/codec/` / `src/createMediaPublisher.ts` / `src/index.ts` (公開型の再エクスポートは変更不要であることの確認) / `src/createMediaPublisher.test.ts` / `tests/e2e/codec-wrappers.spec.ts` / `devtools/src/codec-test/` / `docs/HIGH_LEVEL_API.md` / `CHANGES.md` とする
- `src/createMediaPublisher.test.ts` の記録用エンコーダーは `encodeQueueSize` を固定値で返すため、その値を可変にして閾値超過と破棄を固定できるようにする
- `CHANGES.md` の `## develop` の先頭に、`[FIX]` (Worker モードのバックプレッシャ修正) と `[ADD]` (`VideoStats.droppedFrames`) を追記する (セクション内は新しい順。2 件の前後は問わない)

## 完了条件

- Worker モードで `encodeQueueSize` が送信中のフレーム数を返し、`encoded` 応答のたびに減る (直接モードの実値と同じ契約で扱える)
- 送信中のフレーム数は `configure` による Worker 差し替え時と `close` 時に 0 に戻り、0 未満にならない。再 configure 後も `encode` が再開できる
- 送信中のフレーム数が閾値 `2` を超えたフレームは `encode` されずに破棄され、`videoStats.droppedFrames` が増える
- 直接モードの挙動 (閾値超過で破棄) が変わらない
- 純粋なカウンタの増減・リセット・0 未満防止が `src/codec/workerConfigure.test.ts` で、閾値超過の破棄と `droppedFrames` が `src/createMediaPublisher.test.ts` で固定される。`src/codec/workerConfigure.test.ts` のヘッダコメントも送信キューのテストを含む形に更新する
- `tests/e2e/codec-wrappers.spec.ts` の Worker モードの `queueSizeAfterEncode` が直接モードと同じ `6`、出力待機後が `0` になることを pin し、旧契約のコメントを更新する
- `docs/HIGH_LEVEL_API.md` の統計の記述に `droppedFrames` が載り、`src/codec/VideoEncoder.ts` の `encodeQueueSize` の JSDoc に Worker モードの意味が入る
- `CHANGES.md` の `## develop` の先頭に `[FIX]` と `[ADD]` が入る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `tests/e2e/codec-wrappers.spec.ts` (Worker モードの encodeQueueSize 契約を pin している既存テスト)
- 0678 (devtools 本体の同型。0650 の完了後に着手する。送信中カウンタを import する側。破棄数は devtools 側の signal で別に数える)
- 0680 (キュー超過で破棄したフレームのキーフレーム要求。0650 の完了後に実装する)
- `src/codec/VideoEncoder.ts` / `src/codec/workerConfigure.ts` / `src/createMediaPublisher.ts` の閾値判定 / `devtools/src/codec-test/video.ts`

## 解決方法

{未着手}
