# RESET_STREAM 経路 (bidi 系・受信 PUBLISH 系) で応答待ちの REQUEST_UPDATE がクリーンアップされない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-reset-path-pending-request-update-leak
- Polished: {YYYY-MM-DD}

## 目的

ピアの RESET_STREAM (source: "stream" の read 失敗) でストリームがエラー終了した場合、応答待ちの REQUEST_UPDATE の Promise (`pendingRequestUpdate`) がセッション close まで未解決のまま残る問題を解消する。FIN 経路 (closed issue 0422) と GOAWAY 受信時 (closed issue 0406) は掃除済みだが、RESET_STREAM 経路のみ未対応。

## 現状

- `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の外側 catch は subscribe ロールのエラー終了通知 (closed issue 0410: `notifySubscriberFailure`) のみで、`pendingRequestUpdate` を触らない。
- `runPublishStreamSubLoop` (`src/session.ts`) の外側 catch も同様に error 通知のみで、`pendingRequestUpdate` を触らない。
- 影響: ピアの RESET_STREAM 後に `subscriber.update()` の Promise が未解決のまま残る (アプリは update() の結果を待ち続ける)。
- 記録の経緯: issue 0410 の「残余リスク (RESET 経路の pending リーク)」および issue 0422 のスコープ外として記録されたが、両方 closed 済みで追跡先が消滅したため独立起票する。

## 設計方針

- `bidiReadRequestStreamMessages` の外側 catch と `runPublishStreamSubLoop` の外側 catch で、`rejectPendingRequestUpdates` により当該 requestId の保留中 REQUEST_UPDATE を reject してエントリを削除する (GOAWAY 掃除 / FIN 掃除と同じヘルパー・同じ形式のエラー文言)。
- 配置は 0422 と同様に「アプリの error コールバックが throw しても reject が実行される」順序 (reject を先) とする。
- 対象: subscribe ロール (bidi 系) と受信 PUBLISH の subscriber (runPublishStreamSubLoop)。publish ロールは pending が発生しないため no-op。
- 変更対象: `src/session/bidi.ts` / `src/session.ts` (catch)、`src/session/bidi.test.ts` / `src/session.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- RESET_STREAM 相当のエラー終了で、該当 requestId の pendingRequestUpdate が reject され、エントリが削除されること (bidi 系 / 受信 PUBLISH 系の両方)。
- `subscriber.update()` の Promise が reject 後に settle されること。
- エラーコールバックが throw しても reject が実行されること。
- GOAWAY 受信済み・セッション終了 (source: "session") では reject されないこと (既存ガードの維持)。
- 上記を検証するテストがあること (実 W3C ストリーム注入方式)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM)
- 関連: `issues/closed/0422-bug-fin-path-pending-request-update-leak.md` (FIN 経路の掃除)
- 関連: `issues/closed/0410-bug-subscribe-error-end-not-notified.md` (RESET 通知の実装。残余リスクとして記録)
