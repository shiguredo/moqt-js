# Subscriber の終了通知に PUBLISH_DONE の status code と reason を載せる

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
- Branch: feature/change-subscriber-publish-done-reason
- Polished: {YYYY-MM-DD}

## 目的

`Subscriber` の終了通知 (`endCallback`) は引数を持たないため、アプリは購読がなぜ終わったのかを知れない。PUBLISH_DONE の status code (draft-ietf-moq-transport-22 §12.4) は `TRACK_ENDED` / `GOING_AWAY` / `EXPIRED` / `TOO_FAR_BEHIND` / `INTERNAL_ERROR` などを区別する情報であり、moqt-devtools が購読の終了理由を表示するために必要である。`SubscriberImpl.handleEnd` は status code と reasonPhrase を受け取っているので、通知側で落とさないようにする。

## 現状

- `src/subscriber.ts` の `SubscriberImpl` は `endCallback?: (() => void)` を持ち、`handleEnd(statusCode?, reasonPhrase?)` はエラーを示す code のときだけ `errorCallback` にエラーを渡し、その後に引数なしの `endCallback` を呼ぶ
- エラーかどうかの判定は `isPublishDoneErrorStatus` による。`TRACK_ENDED` (0x2) などはエラーとみなさず、受け取った code はどこにも渡らない
- `src/session/bidi.ts` の `bidiHandlePublishDone` は `normalizePublishDoneCode` で正規化した code と reasonPhrase を `handleEnd` に渡している (§13 の Grease 対応)
- このため devtools の `trackCallbacks.end` (`devtools/src/hooks/useSubscriber.ts`) は理由を受け取れず、表示は「Stream ended」固定である
- エラー status の PUBLISH_DONE では、`handleEnd` が `errorCallback` → `endCallback` の順に呼ぶため、devtools の表示は「Subscribe error: ...」の後に「Stream ended」で上書きされる。エラーが正常終了に見える

## 設計方針

- 終了通知に PUBLISH_DONE の status code と reasonPhrase を渡す。code は `PublishDoneStatusCode` の値、reason は文字列とする
- 通知の形は、`end(statusCode, reasonPhrase)` に変えるか、エラーと正常を 1 つの通知にまとめるかを決める。`errorCallback` との関係を整理し、同じ終了を二重に通知しない (今はエラー時に 2 回呼ばれる)
- 下位互換は保たない (`CODEBASE.md` の「破壊的変更は積極的に行う」)。利用箇所は `devtools/src/hooks/useSubscriber.ts` と `src/createMediaSubscriber.ts` を確認して追従させる
- `Subscriber` の公開インターフェース (`src/session/publicTypes.ts` など) と `docs/LOW_LEVEL_API.md` を更新する
- 理由の表示 (devtools の UI) は `0839-bug-devtools-track-end-teardown.md` で扱う。本 issue は通知までとする
- 対象外: セッション終了 (`markClosed`) の通知。今は `end` コールバックを呼ばない方針であり、これを変えない

## 完了条件

- `Subscriber` の終了通知から PUBLISH_DONE の status code と reasonPhrase が取得できる
- エラー status の PUBLISH_DONE が、正常終了と区別できる形で 1 回だけ通知される
- 既存の利用箇所が新しい通知に追従し、`npx vp check` / `npx vp test --run` が通る
- `src/subscriber.test.ts` と `src/session/bidiPublishDone.test.ts` の終了通知のテストが新しい形に追従する

## 参照

- `0839-bug-devtools-track-end-teardown.md`
- `src/subscriber.ts` の `SubscriberImpl` (`endCallback` / `handleEnd` / `isPublishDoneErrorStatus`)
- `src/session/bidi.ts` の `bidiHandlePublishDone`
- `src/session/bidiPublishDone.test.ts`
- `docs/LOW_LEVEL_API.md`

## 解決方法

{未着手}
