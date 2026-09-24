# 表示待ちフレームを 1 枚だけにすると到着のゆらぎで表示フレームが落ちる

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-frame-jitter-buffer
- Polished: {YYYY-MM-DD}

## 目的

実回線 (配備 relay) では 60 fps の配信でも表示フレーム数が 42 fps 程度まで落ちる。Object の到着が少しゆらぐ (20 ms の間に 2 から 3 Object がまとまって届く) ため、表示待ちフレームを 1 枚だけにすると、同じ表示周期に入った 2 枚目が捨てられ、落ちた枚数だけ表示フレームが減る。配信は 60 fps で届いているのに再生が 42 fps に見えるため、滑らかさの要件 (表示上限の 7 割以上) を満たせない。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `presentFrame` は復号済みフレームを 1 枚だけ保持し、新しいフレームが届くと古い方を `close()` する。表示は requestAnimationFrame で 1 周期 1 枚である
- 配備 relay + moqt-devtools の実測 (2026-09-24): 60 fps の配信で `objectsReceived` は 59.9/s、rAF は 74.4/s であるのに `framesDecoded` は 41.9 fps。20 ms ごとの Object 到着数は 0 が 130、1 が 320、2 が 124、3 以上が 26 であり、まとまって届く区間がある
- ローカル (loopback) では到着のゆらぎが小さく、この欠陥は目立たない

## 設計方針

- 表示待ちフレームを小さなキュー (`MAX_PENDING_FRAMES` = 3) で保持し、requestAnimationFrame ごとに 1 枚ずつ古い順に表示する
- キューがあふれたら古い方から捨てる。これにより、配信 fps が表示 fps を超える場合 (120 fps の入力) と cache replay の追い上げ中は常に最新側へ追いつき、早送りにもならない
- teardown ではキューの全フレームを破棄し、予約した描画を取り消す
- 遅延は最大 3 枚 (60 fps で約 50 ms) に抑える

## 完了条件

- 配備 relay + moqt-devtools の 60 fps 購読で、表示フレーム数が表示上限 (配信 fps とディスプレイ fps の小さい方) の 7 割以上になることを実測する
- 120 fps の購読でも表示が表示周期どおりに回り、早送りにならないことを E2E で固定する (sora-moq の `test_moqtjs_smoothness.py`)
- `vp check` と全テスト (vitest) が通る

## 参照

- `devtools/src/hooks/useSubscriber.ts` の `presentFrame` / `clearPendingFrame`
- sora-moq の `e2e-test/browser/relay_interop/test_moqtjs_smoothness.py`
