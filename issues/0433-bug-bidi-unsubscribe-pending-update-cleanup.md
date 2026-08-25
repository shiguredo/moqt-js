# bidi 系 unsubscribe() (bidiCancelSubscription) が in-flight の REQUEST_UPDATE を掃除しない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-bidi-unsubscribe-pending-update-cleanup
- Polished: {YYYY-MM-DD}

## 目的

bidi 系 SUBSCRIBE の `Subscriber.unsubscribe()` (`bidiCancelSubscription`、`src/session/bidi.ts`) が `pendingRequestUpdate` を掃除しないため、in-flight の update() の Promise が未解決のまま残る問題を解消する。namespace / tracks 系の unsubscribe は closed issue 0414 で掃除済みだが、bidi 系は「未起票の別 issue で対応」と明記されたままである。

## 現状

- `bidiCancelSubscription` (`src/session/bidi.ts`) は `readable.cancel()` で受信方向を閉じ、subscribers / subscribersByAlias / requestStreams のエントリを削除するが、`pendingRequestUpdate` (当該 requestId を targetRequestId とするエントリ) を reject しない。
- 影響: unsubscribe() 後に `subscriber.update()` の Promise がセッション close まで未解決のまま残る。更新は「not active」で throw するため送信阻害は限定的だが、主たる害は update() の Promise 未解決。
- 416 により bidi 系は FIN (done) 経路の掃除が入ったが、unsubscribe 経路は `readable.cancel()` で受信方向を閉じるため FIN (done) ケースに到達せず解消されない (issue 0422 のスコープ外明記)。
- RESET_STREAM 経路も対象外 (issue 0432 で対応予定)。

## 設計方針

- `bidiCancelSubscription` で `rejectPendingRequestUpdates` (既存ヘルパー) により当該 requestId の保留中 REQUEST_UPDATE を reject してエントリを削除する。エラー文言は 0414 と同じ形式 ("stream closed before receiving update response" / 相当) に揃える。
- `SubscriberImpl.unsubscribe()` の既存動作 (state 遷移・エントリ削除・onUnsubscribe 呼び出し) は変更しない。
- 変更対象: `src/session/bidi.ts` (`bidiCancelSubscription`)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- in-flight の更新がある状態で unsubscribe() を呼ぶと、update() の Promise が reject されること。
- pendingRequestUpdate に当該 requestId のエントリが残らないこと。
- unsubscribe の既存処理 (state 遷移・エントリ削除・onUnsubscribe) が変わらないこと (回帰ガード)。
- fire-and-forget の update() が unhandled rejection にならないこと (0414 と同様の対応)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 / §10.9.1 (REQUEST_UPDATE の失敗時処理)
- 関連: `issues/closed/0414-bug-unsubscribe-pending-update-cleanup.md` (namespace / tracks 系の unsubscribe 掃除。bidi 系は本 issue の対象として記録)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md` (GOAWAY 掃除。共通の rejectPendingRequestUpdates を利用)
