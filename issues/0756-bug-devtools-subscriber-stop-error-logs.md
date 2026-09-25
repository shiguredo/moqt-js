# moqt-devtools の subscriber の Stop で、エラーのログが出る

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-subscriber-stop-error-logs
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の subscriber で Stop を押すと、自分から止めただけなのに、デバッグログに「webtransport error」が 2〜3 回と「DATAGRAM_LOOP_ERROR」が出る。本当のエラーと見分けがつかず、切り分けの邪魔になる。

## 現状

- 実測 (2026-09-25、手元の sora-moq の relay): 購読してから Stop を押すと、デバッグログに `[subscriber-...] webtransport error` が 2 回 (映像と音声の配信では 3 回)、`[subscriber-...] [RECV] DATAGRAM_LOOP_ERROR` が 1 回、`webtransport closed` が 1 回出る。映像だけ、音声だけのどちらでも出る
- `src/session/dataStreamIncoming.ts` の `dataStreamStartDatagramLoop` は、datagram の読み出しで例外が出ると `DATAGRAM_LOOP_ERROR` の debug を出し、`notifyErrorIfActive` を呼ぶ。session を閉じたときに読み出しが例外で終わる場合も、この経路を通るとみている
- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は、`connect` の `error` コールバックで「webtransport error」のログを出す

## 設計方針

- 自分から session を閉じたときに、どの経路が例外を出し、なぜ `error` コールバックまで届くのかを確かめる
- 自分から閉じたことによる終わりは、エラーとして通知しない (ログにも出さない)。相手や経路による本当のエラーは今と同じく通知する

## 完了条件

- Stop で「webtransport error」と「DATAGRAM_LOOP_ERROR」が出ない
- relay を止めるなど本当に切れたときは、今と同じくエラーを通知する
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
