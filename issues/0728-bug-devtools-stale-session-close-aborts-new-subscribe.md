# devtools の subscriber で、停止した購読の session の close が遅れて届くと、次に始めた購読を中断し「Connecting...」のまま止まる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-stale-session-close
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools で subscriber を停止してすぐに Start Subscribing を押すと、表示が「Connecting...」のまま進まないことがある。利用者から「一度停止して再度繋ごうとすると正常に接続できない」と報告があった。

停止した購読の WebTransport session の close のコールバックは、session の close が終わった時点 (relay との往復の後) で届く。そのときに新しい購読が始まっていると、コールバックは新しい購読の後始末 (`teardownSubscriber`) をして、新しい購読の AbortController を中断する。新しい購読は接続の後に中断を見て黙って戻るため、表示は「Connecting...」のまま残る。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は、`connect()` に渡す `close` / `error` のコールバックと、映像トラックの SUBSCRIBE の `end` のコールバックで、`teardownSubscriber()` を必ず呼ぶ (「abort 経路を維持するため常に呼ぶ」)。コールバックがどの回の購読のものかを見ない
- `teardownSubscriber` は `abortControllerRef.current` (今の購読の AbortController) を中断して `null` にし、`resetSubscriberState` で状態を戻す
- `stopSubscribing` は購読を解除して `teardownSubscriber` を呼び、`closeSubscriberResources` は session の `close()` を待たずに返す。停止が終わった時点で Start Subscribing を押せるが、前の session の close のコールバックはまだ届いていない
- `startSubscribing` は `connect()` の後の `checkAborted` で中断を見ると、session を閉じて戻る。status と statusMessage は「Connecting...」のまま更新しない
- 前の session の close のコールバックが新しい session の割り当ての後に届くと、`shouldApplyStatusUpdate` が真になり、新しい購読の表示を「Disconnected: ...」で上書きして後始末する

再現 (2026-09-25、配備 relay + 配備 moqt-devtools、偽カメラ):

- 停止が終わった直後に Start Subscribing を押す操作を 6 回くり返すと、2 回の実行のどちらでも 1 回ずつ「Connecting...」のまま止まった
- `AbortController.abort` の呼び出し元を記録すると、止まった回では、直前の Stop の約 0.3 秒後に、前の session の `close` のコールバックから `teardownSubscriber` が新しい購読の AbortController を中断していた

## 設計方針

- `startSubscribing` が登録するコールバック (session の `close` / `error`、映像トラックの SUBSCRIBE の `end`) は、登録した回の購読が今の購読のときだけ、表示を変えて後始末する。今の購読かは、その回の AbortSignal が `abortControllerRef.current` の signal と同じかで判定する
- 前の回のコールバックはデバッグログだけを残す (close は従来どおりログに出す)
- 今の回の購読の session が閉じた場合は、従来どおり後始末して進んでいる処理を中断する

## 完了条件

- 判定の関数の単体テストで、同じ回の AbortController が今のものなら真、別の回に替わったか後始末で `null` になったら偽を返すことを固定する
- sora-moq の相互運用 harness の E2E で、relay の前に片道 150 ms の遅延を入れ、停止が終わった直後に Start Subscribing を押す操作を 3 回くり返し、毎回購読が確立して復号することを確かめる。修正前はこの E2E が失敗することを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` が通る
