# devtools 本体でも Worker モードの映像エンコーダのバックプレッシャが無効になっている

- Created: 2026-09-23
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-encoder-backpressure
- Polished: {YYYY-MM-DD}

## 目的

`devtools/src/utils/EncoderWrapper.ts` の `encodeQueueSize` は Worker モードで 0 を返し、`devtools/src/hooks/usePublisher.ts` は `encoderInstance.encodeQueueSize <= 2` で投入を抑止する。0 固定のため判定が常に真になり、破棄されずに全フレームが Worker へ送られる。1080p の `VideoFrame` 1 枚は NV12 で約 3.1 MB あり、エンコード能力を超えた入力が続くと Worker 側のキューが伸び続ける。0650 はライブラリ側 (`src/`) を対象とし、devtools 本体の同型は対象外とされている。

## 現状

- `devtools/src/utils/EncoderWrapper.ts` の `encodeQueueSize` getter は `useWorker` のとき 0 を返し、コメントにも「Worker モードでは直接 encodeQueueSize を取得できないため 0 を返す」と書く
- 同じファイルの `encode` は Worker モードで `frame` を transfer して `postMessage` するだけである。キュー長を main 側へ返す経路が無い
- `devtools/src/hooks/usePublisher.ts` は `encoderInstance.encodeQueueSize <= 2` のときだけ `encode` し、超えたフレームは `frame.close()` で破棄する
- `devtools/src/webcodecs-devtools/signals.ts` も同じ `EncoderWrapper` を使うため、同じ判定の影響を受ける
- 0650 は `src/codec/VideoEncoder.ts` の `encodeQueueSize` と `src/createMediaPublisher.ts` の判定を直し、devtools 本体の同型は本 issue の対象としている

## 設計方針

- 0650 と同じ方式にする。送信中のフレーム数を main 側で数え (`encode` で増やし `encoded` 応答で減らす)、`encodeQueueSize` は Worker モードでその数を返す。Worker プロトコルは変更しない
- 増加は `postMessage` の成功後に数え、減算は `callbacks.output` を呼ぶ前に済ませる。`configure` による Worker の差し替えと `close` で 0 にリセットし、0 未満にしない
- 送信中カウンタはブラウザ依存の無い純粋な部分として切り出し、Node の単体テストで増減・リセット・0 未満防止を固定する
- 閾値 `<= 2` は変えない。破棄したフレームを devtools の統計に出すかは、0650 が `VideoStats` に足す `droppedFrames` と表示を揃えて決める
- ライブラリ側の 0650 と実装方針を揃え、二重管理にしない
- `CHANGES.md` の `## develop` に `[FIX]` を追記する

## 完了条件

- devtools の Worker モードで `encodeQueueSize` が送信中のフレーム数を返し、`encoded` 応答のたびに減る
- `configure` による Worker の差し替え時と `close` 時に 0 に戻り、0 未満にならない
- 閾値 2 を超えたフレームが破棄され、破棄が統計から判別できる
- 直接モード (Worker を使わない経路) の挙動が変わらない
- カウンタの挙動が Node の単体テストで固定される
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- 0650 (ライブラリ側の同型。devtools 本体が本 issue)
- `devtools/src/utils/EncoderWrapper.ts` / `devtools/src/hooks/usePublisher.ts` / `devtools/src/webcodecs-devtools/signals.ts`

## 解決方法

{未着手}
