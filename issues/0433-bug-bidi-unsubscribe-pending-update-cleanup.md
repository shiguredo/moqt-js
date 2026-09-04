# bidi 系 unsubscribe() (bidiCancelSubscription) が in-flight の REQUEST_UPDATE を掃除しない

- Created: 2026-08-25
- Completed: 2026-09-04
- Branch: feature/fix-bidi-unsubscribe-pending-update-cleanup
- Polished: 2026-08-28

## 目的

bidi 系 SUBSCRIBE の `Subscriber.unsubscribe()` (`bidiCancelSubscription`、`src/session/bidi.ts`) が `pendingRequestUpdate` を掃除しないため、in-flight の update() の Promise が未解決のまま残る問題を解消する。namespace / tracks 系の unsubscribe は closed issue 0414 で掃除済みだが、bidi 系は「未起票の別 issue で対応」と明記されたままである。

## 現状

- `bidiCancelSubscription` (`src/session/bidi.ts` 1826-1862 行) は `readable.cancel()` / `writer.abort()` で両方向を閉じ、subscribers / subscribersByAlias / requestStreams のエントリを削除するが、`pendingRequestUpdate` (当該 requestId を targetRequestId とするエントリ) を reject しない。
- `SubscriberImpl.unsubscribe()` (`src/subscriber.ts`) 側は state 遷移 ("closed") と onUnsubscribe 呼び出しのみで、上記のエントリ削除は `bidiCancelSubscription` の責務である。
- 影響: unsubscribe() 後に `subscriber.update()` の Promise がセッション close まで未解決のまま残る。更新は state === "closed" で throw するため送信阻害は限定的だが、主たる害は update() の Promise 未解決。
- 0422 により bidi 系は FIN (done) 経路の掃除が入ったが、unsubscribe 経路は `readable.cancel()` で受信方向を閉じるため FIN (done) ケースに到達せず解消されない (issue 0422 のスコープ外明記)。
- RESET_STREAM 経路も対象外 (open issue 0432 で対応予定)。
- `bidiCancelSubscription` の入り口は `SubscriberImpl` (SUBSCRIBE_OK 済みで `session.subscribers` に登録された後) のみのため、`pendingSubscribe` は既に resolve 済みで残らない。したがって本 issue のスコープは `pendingRequestUpdate` のみで、`pendingSubscribe` は対象外である。
- `bidiSendRequestUpdate` は 0406 実装で `promise.catch(() => {})` (`bidi.ts` 1511 行) を既に持ち、fire-and-forget の update() が unhandled rejection にならない基本の受け皿は用意されている。ただし `SubscriberImpl.update()` の async wrapper の扱いは open issue 0434 で別途整理される。

## 設計方針

- `bidiCancelSubscription` で `rejectPendingRequestUpdates` (既存 export ヘルパー) により当該 requestId の保留中 REQUEST_UPDATE を reject してエントリを削除する。
- reject エラー文言は `namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE` (`src/session/namespaceLoops.ts` の export 定数) を import して `new Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE)` を渡す。0414 / 0422 / 0432 と同一定数に統一する (0432 が bidi.ts の FIN 経路のインライン文字列を同定数に揃える方針と同一処置)。RESET 経路 (0432) と unsubscribe 経路 (本 issue) はいずれも「応答未達によるストリーム終了」で失敗種別が同じため文言も同じで問題ない。
- 配置は `bidiCancelSubscription` 内で `readable.cancel()` / `writer.abort()` 直後、subscribers / subscribersByAlias / requestStreams のエントリ削除より前に置く (通知系呼び出しは無いため順序制約は弱いが、副作用の集約として cancel 直後を推奨)。
- `SubscriberImpl.unsubscribe()` の既存動作 (state 遷移・onUnsubscribe 呼び出し) は変更しない。`bidiCancelSubscription` の既存動作 (readable.cancel / writer.abort / subscribers / subscribersByAlias / requestStreams 削除) も変更しない。
- fire-and-forget の update() の unhandled rejection 抑制は既存 `promise.catch(() => {})` (0406, bidi.ts 1511 行) で満たされる。本 issue で追加実装は不要で、回帰テストで担保するのみ。async wrapper 経路の整理は open issue 0434 のスコープ。
- 変更対象: `src/session/bidi.ts` (`bidiCancelSubscription` に `rejectPendingRequestUpdates` 呼び出し追加、`REQUEST_UPDATE_STREAM_CLOSED_MESSAGE` を `namespaceLoops` から import)、`src/session/bidi.test.ts` (テスト追加。既存 import に定数を追加)、`CHANGES.md`。

## 完了条件

- in-flight の REQUEST_UPDATE がある状態で unsubscribe() を呼ぶと、`update()` の Promise が `Error(REQUEST_UPDATE_STREAM_CLOSED_MESSAGE)` で reject されること。
- pendingRequestUpdate に当該 requestId (targetRequestId) のエントリが残らないこと。
- `SubscriberImpl.unsubscribe()` の既存処理 (state 遷移・onUnsubscribe 呼び出し) が変わらないこと (回帰ガード)。
- `bidiCancelSubscription` の既存処理 (readable.cancel / writer.abort / subscribers / subscribersByAlias / requestStreams 削除) が変わらないこと (回帰ガード)。
- fire-and-forget の update() 呼び出しが unhandled rejection にならないこと (既存 `promise.catch(() => {})` により担保。本 issue で追加実装は行わないため回帰確認のみ)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 / §10.9.1 (REQUEST_UPDATE の失敗時処理)
- 関連: `issues/closed/0414-bug-unsubscribe-pending-update-cleanup.md` (namespace / tracks 系の unsubscribe 掃除。bidi 系は本 issue の対象として記録)
- 関連: `issues/closed/0422-bug-fin-path-pending-request-update-leak.md` (bidi 系 FIN (done) 経路の掃除。先行の類例で reject を先とする順序の確立)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md` (GOAWAY 掃除。共通の rejectPendingRequestUpdates を利用。`bidiSendRequestUpdate` の `promise.catch(() => {})` を導入)
- 関連: `issues/0432-bug-reset-path-pending-request-update-leak.md` (RESET_STREAM 経路の掃除。本 issue と独立トリガー。同一定数 `REQUEST_UPDATE_STREAM_CLOSED_MESSAGE` を採用)
- 関連: `issues/0434-bug-unobserved-update-rejection-not-suppressed.md` (bidi 系 `SubscriberImpl.update()` の async wrapper 経路の整理。本 issue の新規 reject トリガーに対する async wrapper 側の受け皿)

## 解決方法

`src/session/bidi.ts` の `bidiCancelSubscription` で、ストリーム破棄より前に `rejectPendingRequestUpdates` を呼ぶようにした。

- reject 文言は FIN / RESET 経路と同じ共通文言を採用する
- 対象 requestId の複数件を掃除し、別対象は温存する。FETCH は対象とする送信経路が存在しないため掃除対象外である旨をコメントに明記する
- fire-and-forget の wrapper 経路の抑制は 0434 の範囲であり、本 issue では送信関数の既存 catch を残すのみとする (実装中に内側 catch が外側 wrapper に及ばないことを確認し、0434 へ委ねる)
- テストは `src/session/bidi.test.ts` に 2 本追加する (掃除とスコープ・保留なし時の no-op)
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
