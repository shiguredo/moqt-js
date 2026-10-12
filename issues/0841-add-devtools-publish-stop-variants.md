# moqt-devtools の publish 停止に、止め方のバリエーションを足す

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-publish-stop-variants
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の Stop Publish は「各トラックに PUBLISH_DONE (TRACK_ENDED) を送ってから publisher のセッションを閉じる」の 1 通りしかない。publisher の止め方によって、購読者に届く終了通知は変わる (PUBLISH_DONE が届く場合と、何も届かず購読が残る場合がある)。切り分けツールとして、これらの止め方を意図的に再現できるようにする。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `stopPublishing` は、complete catalog を送ってから、catalog / 映像 / 音声 / event の publisher に対して `done()` を呼び、`cleanupPublisher` で `pubSession` を閉じる。`src/publisher.ts` の `done()` は PUBLISH_DONE (TRACK_ENDED) を送る
- PUBLISH_DONE を送らずにセッションだけを閉じる経路と、何も送らずに配信だけを止める経路は、UI から再現できない
- 前者では購読者に PUBLISH_DONE が届くが、後者では購読者に何も届かず購読が残る。どちらも他実装との interop や、relay が publisher の離脱をどう扱うかの確認で必要になる
- 実リレーでの確認は `TEST_MOQT_URI` を渡す E2E (`tests/e2e/relay/`) で行う

## 設計方針

- Stop の止め方を UI から選べるようにする。候補は次の 3 つ
  - PUBLISH_DONE を送って止める (既定。今の挙動)
  - PUBLISH_DONE を送らずにセッションを閉じる
  - 何も送らずに配信だけ止める (セッションは維持)
- 「配信だけ止める」は、publisher のセッションを維持したまま、オブジェクトの送信とフレームの読み出しを止める。購読者に何も届かない状態が続くことを確かめられるようにする
- 既定は今の挙動のままにして、既存の操作の意味を変えない
- devtools の UI は英語表記とする (`CODEBASE.md`)
- 対象外
  - ライブラリの API 追加。今の `Publisher` の API で足りる範囲で実装する
  - relay 側の挙動の変更

## 完了条件

- 3 つの止め方を UI から選べ、それぞれで送られるメッセージの違いを Debug パネルのログで確認できる
- PUBLISH_DONE を送らずにセッションを閉じた場合と、何も送らずに止めた場合とで、購読者の表示が変わることを実リレーで確認する
- 既定の止め方は従来と同じメッセージを送る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `0839-bug-devtools-track-end-teardown.md`
- `devtools/src/hooks/usePublisher.ts` の `stopPublishing` / `cleanupPublisher`
- `devtools/src/components/PublisherPanel.tsx`
- `src/publisher.ts` の `PublisherImpl.done`
- `tests/e2e/relay/`

## 解決方法

{未着手}
