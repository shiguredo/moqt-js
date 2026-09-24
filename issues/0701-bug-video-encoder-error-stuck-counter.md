# Worker 内の encoder が error で閉じた後、送信カウンタが張り付いて全フレームが破棄される

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-video-encoder-error-stuck-counter
- Polished: 2026-09-24

## 目的

closed の `0650-bug-video-encoder-backpressure.md` で Worker モードの `encodeQueueSize` を「Worker へ送信してまだ `encoded` 応答が返っていないフレーム数」にした。増加は `postMessage` の成功後、減算は `encoded` 応答の受信時だけである。

Worker 内の `VideoEncoder` が error で閉じると、Worker は `{type: "error", message}` を送るだけで `encoded` を返さない。カウンタは増える一方になり、数フレームで閾値 `2` を超えて以後すべてのフレームが破棄される。復帰しない相手への転送を止める安全側の挙動ではあるが、encoder の状態は `configured` のままで、`processVideoFrames` のループも回り続ける。利用者から見ると「配信は動いているのにフレームが 1 枚も送られない」状態になり、`droppedFrames` の増加でしか観測できない。

## 現状

- `src/codec/VideoEncoder.ts` の `encode` (140 行目) は Worker モードで `frame` を transfer して `postMessage` し (150-157 行目)、成功後に `this.sentFrames.increment()` する (159 行目)
- 同 `encodeQueueSize` (181 行目) は Worker モードで `this.sentFrames.size` を返す (182-184 行目)
- 減算は `configureWorker` の `handleWorkerData` (81 行目) の先頭の `this.sentFrames.decrement()` (84 行目) だけである。`configureWrapperWorker` へ渡す `dataTypes` は `["encoded"]` なので (78 行目)、`encoded` 以外の応答では減算されない
- `src/codec/workers/videoEncoder.worker.ts` は Worker 内の `VideoEncoder` の `error` コールバックで `workerErrorResponse(error)` を送る (70-71 行目)。`encode` ハンドラは `isCodecConfigured(videoEncoder)` が false なら `encode` を呼ばず `message.frame.close()` だけを行う (82-86 行目)。error 後に `VideoEncoder.state` は `"closed"` になるため `encoded` 応答は返らない
- `src/codec/workerConfigure.ts` の `configureWrapperWorker` (258 行目) は `"error"` 応答を `failConfigure` (302 行目) へ渡し、初期化完了後 (`gate.trySettle()` が false) は `options.notifyError(error)` を呼ぶ (307-309 行目)。`VideoEncoder.ts` の `notifyError` は `callbacks.error` へ流す (96 行目)
- その error は `src/createMediaPublisher.ts` の `VideoEncoderWrapper` 生成時の `error` コールバック (778-780 行目) から `callbacks.onError` に届くだけで、カウンタも `configured` も変更しない
- `src/codec/VideoEncoder.ts` の `close` は `sentFrames.reset()` を呼ぶ (195 行目)。`configure` も Worker の差し替え後に reset する (61 行目)。`sentFrames` を戻す経路はこの 2 つだけである
- `src/codec/workerConfigure.ts` の `SentFrameCounter` (168 行目) は `increment` (172 行目) / `decrement` (177 行目) / `reset` (184 行目) / `size` (189 行目) を持ち、0 未満にはならない。`src/codec/workerConfigure.test.ts` は増減 (243 行目) / 0 未満防止 (257 行目) / reset (268 行目) / ずれの無さ (283 行目) を固定するが、error 応答による凍結は扱わない
- `src/createMediaPublisher.ts` の `processVideoFrames` (837 行目) のループ条件は `encoder.state === "configured"` である (844-848 行目)。`VideoEncoderWrapper.state` (168 行目) は Worker モードで `codecStateLabel` (`src/codec/codecLifecycle.ts` 83 行目) に `configured` フラグを渡すため、error では変化しない (false にするのは `close` の 204 行目だけ)
- ループ本体は `encoder.encodeQueueSize <= 2` で投入を判定し (861 行目)、超えたフレームは `this.videoStats.droppedFrames++` を数えて `frame.close()` で破棄する (863-868 行目)。カウンタが閾値に張り付くと、ループ条件が真のまま全フレームが破棄される
- `src/codec/workerMessages.ts` の `WorkerErrorResponse` (59 行目) は初期化失敗と実行時エラーの両方に使う既存の応答型である。0650 の設計方針は「Worker プロトコル (`workerMessages.ts` の応答型) は変更しない」としており、error 応答の経路は既にある

## 設計方針

- error 応答を受けたら送信カウンタを凍結する。案: `SentFrameCounter` に `freeze()` を追加し、凍結後は `increment` を無視して `size` を凍結時の値 (または 0) に固定する。凍結は `reset` で解除できるようにし、復帰 (再 configure) で数え直す
- `VideoEncoderWrapper` の `notifyError` 経路 (96 行目) で凍結と状態の反映を行う。`configureWorker` の `notifyError` を `(error) => { this.sentFrames.freeze(); this.configured = false; this.callbacks.error(error); }` の形にする (初期化失敗時は `configure` が reject するため、この経路に来るのは初期化完了後の実行時エラーだけである)
- `configured` を false にすることで `state` が `"configured"` 以外になり、`processVideoFrames` のループ条件 (847 行目) が偽になってループが止まる。`encode` も先頭の `if (!this.configured)` (141-144 行目) で Worker へ送らなくなる
- Worker の破棄は `notifyError` では行わない。`notifyError` は失敗した Worker の参照を持たず、再 configure で新しい Worker が公開済みの場合にそれを壊す恐れがあるため、破棄は `close` (191-205 行目) と `configure` の差し替え (59-61 行目) に任せる
- 破棄されたフレームは既存の `droppedFrames` に含める (意味は「エンコードできずに捨てたフレーム数」であり、原因別の内訳は持たない)。原因別に区別したくなったら公開型 `VideoStats` の変更 (後方互換なし) になるため別 issue とする
- `src/codec/workerMessages.ts` の応答型は変更しない (既存の `WorkerErrorResponse` で足りる)
- 復帰は従来どおり再 configure、または `stop()` → `start()` とする (0650 の方針を維持)
- テストは純粋ロジックを `src/codec/workerConfigure.test.ts` に追加する (凍結後は増えない / `reset` で解除される / 凍結は 0 未満防止と干渉しない)。`VideoEncoderWrapper` の配線 (error 応答 → 凍結 → `configured = false`) は Worker と WebCodecs を要するため Node では駆動できない。e2e で Worker 内の encoder を error させる手段は現状無く (`tests/e2e/codec-wrappers.spec.ts` は正常系の契約を pin する)、再現手段を作る場合は同 spec と `devtools/src/codec-test/` に追加する
- 対象は `src/codec/workerConfigure.ts` / `src/codec/workerConfigure.test.ts` / `src/codec/VideoEncoder.ts` / `src/createMediaPublisher.ts` (JSDoc と統計の説明のみ) / `docs/HIGH_LEVEL_API.md` (`droppedFrames` の説明に失敗時の破棄を含める) / `CHANGES.md` とする
- 対象外: 直接実行モード (WebCodecs の `encodeQueueSize` は実キュー長であり、error 後は `encode` が例外を投げる経路になる)。音声エンコーダ (`AudioEncoderWrapper` は `encodeQueueSize` を公開しない)。devtools 本体の同型 (0678)

## 完了条件

- `SentFrameCounter` の凍結が `src/codec/workerConfigure.test.ts` で固定される (凍結後は `increment` しても `size` が増えない / `reset` で解除される / 0 未満防止は維持される)
- `VideoEncoderWrapper` は初期化完了後の `"error"` 応答でカウンタを凍結し、`configured` を false にしてから `callbacks.error` を通知する (順序を含めてコードで確認できる)
- 失敗後の `VideoEncoderWrapper.state` が `"configured"` にならず、`processVideoFrames` のループ (847 行目) が次の周回で終了する
- 失敗後は `VideoEncoderWrapper.encode` が Worker へ `postMessage` しない
- 統計は失敗後のフレームを `droppedFrames` として数え、`framesSent` は増えない
- 再 configure (`configure` の Worker 差し替え) でカウンタと `configured` が戻り、`encode` が再開できる
- `docs/HIGH_LEVEL_API.md` の `droppedFrames` の説明が失敗時の破棄を含む
- Worker と WebCodecs が要る配線 (error 応答から凍結までの接続) は e2e かコードレビューで確認し、e2e で再現できない場合はその旨を issue の解決方法に記録する
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed の `0650-bug-video-encoder-backpressure.md` (送信カウンタの導入と「error ではリセットしない」判断。「残した課題」に本件がある)
- 0680 (キュー超過で破棄されたフレームのキーフレーム要求。本 issue の破棄と同じ経路)
- 0678 (devtools 本体の同型のバックプレッシャ)
- WebCodecs の `VideoEncoder.encodeQueueSize` (https://w3c.github.io/webcodecs/#dom-videoencoder-encodequeuesize)
- `src/codec/workerConfigure.ts` の `SentFrameCounter` / `configureWrapperWorker`、`src/codec/workers/videoEncoder.worker.ts` の `error` 応答

## 解決方法

{未着手}
