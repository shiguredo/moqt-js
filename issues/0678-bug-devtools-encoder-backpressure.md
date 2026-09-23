# devtools 本体でも Worker モードの映像エンコーダのバックプレッシャが無効になっている

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-encoder-backpressure
- Polished: 2026-09-23

## 目的

`devtools/src/utils/EncoderWrapper.ts` の `encodeQueueSize` は Worker モードで 0 を返し、`devtools/src/hooks/usePublisher.ts` は `encoderInstance.encodeQueueSize <= 2` で投入を抑止する。0 固定のため判定が常に真になり、破棄されずに全フレームが Worker へ送られる。1080p の `VideoFrame` 1 枚は NV12 で 1920 * 1080 * 1.5 = 3,110,400 バイト (約 3.1 MB) あり、破棄の判定が働かない影響は大きい。0650 はライブラリ側 (`src/`) を対象とし、devtools 本体の同型は対象外とされている。

## 現状

- `devtools/src/utils/EncoderWrapper.ts` の `encodeQueueSize` getter は `useWorker` のとき 0 を返し、コメントにも「Worker モードでは直接 encodeQueueSize を取得できないため 0 を返す」と書く
- 同じファイルの `encode` は Worker モードで `frame` を transfer して `postMessage` するだけである。キュー長を main 側へ返す経路が無い
- 同じファイルの `configureWorker` は `this.worker = new EncoderWorker()` を代入するだけで、再 configure のときに旧 Worker を `terminate()` しない。旧 Worker の `onmessage` は残るため、旧世代の `encoded` が `callbacks.output` を呼び続ける
- `devtools/src/hooks/usePublisher.ts` は `encoderInstance.encodeQueueSize <= 2` のときだけ `encode` し、超えたフレームは `frame.close()` で破棄する
- `EncoderWrapper` を使うのは `devtools/src/hooks/usePublisher.ts` だけである。`devtools/src/webcodecs-devtools/signals.ts` は `EncoderWrapper` を使わず、独自の Worker と `VideoEncoder` を直接扱う (`new Worker` を自前で生成する)。`encodeQueueSize` の参照も投入の抑止も無いため本 issue の対象外である
- 0650 は `src/codec/VideoEncoder.ts` の `encodeQueueSize` と `src/createMediaPublisher.ts` の閾値判定を直す計画で、未着手である。現状のライブラリ側は Worker モードで 0 を返したままである。0650 も「devtools 本体の `EncoderWrapper` / `usePublisher` の同種の欠陥は 0678 で扱う」としている
- `devtools/src/utils/EncoderWrapper.test.ts` は configure / encode / Worker 往復を Node の vitest では実行できないと明記し、未設定時の状態機械だけを固定している。同ファイルのコメントには「Worker モードはキューを Worker 内部で管理するため常に 0 になる契約」と 0 固定の契約が書かれている
- `tests/e2e/codec-wrappers.spec.ts` が実ブラウザで駆動するのはライブラリ側の `src/codec/VideoEncoder.ts` であり、devtools の `EncoderWrapper` を駆動する経路は無い
- devtools の統計は `devtools/src/signals/publisher.ts` の独自 signal (`framesEncoded` / `chunksEncoded` / `encodeErrors` など) で、`devtools/src/components/PublisherPanel.tsx` と `devtools/src/components/DebugPanel.tsx` が表示する。`devtools/src/testApi.ts` が公開するのは `framesEncoded` 系の一部だけで、`chunksEncoded` / `encodeErrors` は公開していない。破棄したフレームを数える項目は無い

## 設計方針

- 0650 の完了後に実装する (0680 と同じ扱い)。送信中フレーム数のカウンタは 0650 が切り出す純粋な部分をそのまま import して使う (0650 は `src/codec/workerConfigure.test.ts` で増減・リセット・0 未満防止を固定すると定めている。モジュールのファイル名は 0650 の完了時に確定する)。devtools は既に `src/` から import しているため、devtools 用に別実装を作らない (二重管理にしない)
- `devtools/src/utils/EncoderWrapper.ts` の `encodeQueueSize` は Worker モードで送信中のフレーム数を返す。0 固定の契約とコメントを直す
- 増加は Worker への `postMessage` が成功した後に数え、減算は `callbacks.output` を呼ぶ前に済ませる (`output` が例外を投げても数が戻るようにする)
- 再 configure では旧 Worker を `terminate()` してから作り直す。現行は代入するだけで旧 Worker を破棄せず、旧世代の `encoded` が新しいカウンタを減らしてしまう。`close()` と同じ後始末を再 configure の前に行う。カウンタは 0 未満にしない
- `configure` と `close` でカウンタを 0 にリセットする。リセットしないと再 configure 後にカウンタが閾値を超えたまま張り付き、以後すべてのフレームが破棄される
- `devtools/src/hooks/usePublisher.ts` の閾値 `<= 2` と破棄の挙動は変えない。破棄したフレームは `devtools/src/signals/publisher.ts` に `droppedFrames` signal を足して数え、`PublisherPanel.tsx` と `DebugPanel.tsx` の既存の統計表示に出す。配信開始時に他の統計を 0 に戻している箇所 (`devtools/src/hooks/usePublisher.ts` の `pub.framesEncoded.value = 0` などが並ぶリセット) に `droppedFrames` も加える。リセットしないと前回の配信の破棄数が残る (0650 がライブラリの `VideoStats.droppedFrames` で同じ意味の値を足す)
- 配線の検証は次の 3 段で行う
  - 送信中カウンタの純粋部分は 0650 の `src/codec/workerConfigure.test.ts` が固定する。0678 は新しいカウンタ実装を追加しない
  - devtools の `EncoderWrapper` の配線は `devtools/src/codec-test/` のテストページに devtools の `EncoderWrapper` を Worker モードで駆動する runner を足し、`tests/e2e/codec-wrappers.spec.ts` で固定する
  - `devtools/src/utils/EncoderWrapper.test.ts` は configure / encode / Worker 往復を Node で実行できないため、状態機械の検証にとどめる。configure 前は `encodeQueueSize` が 0 という期待値は現行のまま成立するので検証内容は変えず、「常に 0 になる契約」という旧契約のコメントだけを、0 を返す条件 (未設定、または送信中 0 件) を書く形に直す
- `devtools/src/webcodecs-devtools/signals.ts` と `src/` は変更しない。ライブラリ側は 0650 が扱う
- 対象は `devtools/src/utils/EncoderWrapper.ts` / `devtools/src/utils/EncoderWrapper.test.ts` / `devtools/src/hooks/usePublisher.ts` / `devtools/src/signals/publisher.ts` / `devtools/src/components/PublisherPanel.tsx` / `devtools/src/components/DebugPanel.tsx` / `devtools/src/codec-test/` / `tests/e2e/codec-wrappers.spec.ts` / `CHANGES.md` とする
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する

## 完了条件

- devtools の Worker モードで `encodeQueueSize` が送信中のフレーム数を返し、`encoded` 応答のたびに減る
- 再 configure で旧 Worker が破棄され、旧世代の `encoded` が新しいカウンタを減らさない (減算は 0 で止まるため e2e では判別できない。破棄の配線はレビューで確認する)
- `configure` と `close` でカウンタが 0 に戻り、0 未満にならない
- 閾値 2 を超えたフレームが破棄され、`droppedFrames` が増えて `PublisherPanel` / `DebugPanel` の統計に出る。配信開始時に 0 に戻る。破棄の発生は devtools アプリの映像配信を起動する経路が Node にも e2e にも無いため、レビューと画面表示で確認する
- 直接モード (Worker を使わない経路) の挙動が変わらない
- `devtools/src/codec-test/` の追加 runner と `tests/e2e/codec-wrappers.spec.ts` で、Worker モードの投入直後の `encodeQueueSize` が投入フレーム数、出力待機後が 0、再 configure 後が 0 になることが固定される
- 送信中カウンタの純粋部分の増減・リセット・0 未満防止が 0650 の `src/codec/workerConfigure.test.ts` で固定されており、0678 がカウンタの実装を追加していない
- `devtools/src/utils/EncoderWrapper.test.ts` の旧契約のコメントが、0 を返す条件 (未設定、または送信中 0 件) を書く形に更新される
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- 0650 (ライブラリ側の同型。0650 の完了後に着手する。カウンタと `VideoStats.droppedFrames` の出所)
- 0680 (0650 の完了後に実装する書き方の出所)
- 0677 (codec-test + e2e で配線を固定する前例)
- `devtools/src/hooks/usePublisher.ts` は既に `src/createMediaPublisher.ts` から import しており、devtools が `src/` の純粋ロジックを使う前例になっている
- `devtools/src/utils/EncoderWrapper.ts` / `devtools/src/hooks/usePublisher.ts` / `devtools/src/signals/publisher.ts` / `devtools/src/codec-test/video.ts` / `tests/e2e/codec-wrappers.spec.ts`

## 解決方法

{未着手}
