# RESET_STREAM 経路 (bidi 系・受信 PUBLISH 系) で応答待ちの REQUEST_UPDATE がクリーンアップされない

- Created: 2026-08-25
- Completed: 2026-09-04
- Branch: feature/fix-reset-path-pending-request-update-leak
- Polished: 2026-08-28

## 目的

ピアの RESET_STREAM (source: "stream" の read 失敗) でストリームがエラー終了した場合、応答待ちの REQUEST_UPDATE の Promise (`pendingRequestUpdate`) がセッション close まで未解決のまま残る問題を解消する。FIN 経路 (closed issue 0422) と GOAWAY 受信時 (closed issue 0406) は掃除済みだが、RESET_STREAM 経路のみ未対応。RESET_STREAM は §3.3.3 で cancellation の手段として定義され、REQUEST_UPDATE の応答 (§10.9.1 の REQUEST_OK / REQUEST_ERROR 必須) は届かないため、§3.3.2 の failure 原則 (RESET は FIN よりも強い終了であり同原則が及ぶ) と併せて pending は失敗として reject する。

## 現状

- `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の外側 catch (1279-1302 行) は subscribe ロールのエラー終了通知 (closed issue 0410: `notifySubscriberFailure`) のみで、`pendingRequestUpdate` を触らない。RESET 経路は `try { notifySubscriberFailure(...) } catch { ... }` で通知の throw を吸収する構造。
- `runPublishStreamSubLoop` (`src/session.ts`) の外側 catch (3466-3480 行) も同様に error 通知のみ (`callbacks.error?.(normalizedError)`) で、`pendingRequestUpdate` を触らない。現状は `isPeerStreamError` で source を絞っていない (open issue 0428 で対称化予定)。
- 影響: ピアの RESET_STREAM 後に `subscriber.update()` の Promise が未解決のまま残る (アプリは update() の結果を待ち続ける)。
- 記録の経緯: issue 0410 の「残余リスク (RESET 経路の pending リーク)」および issue 0422 の「RESET_STREAM 経路は 0410 の対象」として記録されたが、両方 closed 済みで追跡先が消滅したため独立起票する。
- 既存のエラー文言: FIN 経路 (bidi.ts) はインライン文字列 `"stream closed before receiving update response"`、FIN 経路 (session.ts) は定数 `namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE`、GOAWAY 経路は `RequestError(GOING_AWAY, REQUEST_GOING_AWAY_REASON)` と形式が異なる (0422 で「reject エラー形式の混在は失敗種別に応じたもので許容」と整理済み)。

## 設計方針

- `bidiReadRequestStreamMessages` の外側 catch と `runPublishStreamSubLoop` の外側 catch で、`rejectPendingRequestUpdates` により当該 requestId の保留中 REQUEST_UPDATE を reject してエントリを削除する。
- reject エラー文言は FIN 経路と同じ `Error(namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE)` を採用する。失敗種別としては FIN と RESET はいずれも「応答未達によるストリーム終了」で同じ扱いにできるため、共通定数に揃える (subscriber への通知文言は 0410 の `RESET_REQUEST_STREAM_MESSAGE` で区別できる)。RESET 専用の新規定数は導入しない。あわせて bidi.ts の FIN 経路のインライン文字列も同一定数に揃える (陳腐化した命名を放置しない)。
- 配置は「アプリの通知が throw しても reject が実行される」ように、通知 (`notifySubscriberFailure` / `callbacks.error?.()`) の前に `rejectPendingRequestUpdates` を置く。
  - `bidiReadRequestStreamMessages`: 既存の `if (role === "subscribe" && isPeerStreamError(error))` 分岐の内側、`try { notifySubscriberFailure(...) }` の直前に `rejectPendingRequestUpdates(session, requestId, new Error(namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE))` を置く。`isPeerStreamError` で source: "session" は自然に弾かれる。
  - `runPublishStreamSubLoop`: 0428 実装後の catch を前提とし、`isPeerStreamError(err) && !isSessionClosedError(err)` 分岐の内側、`notifySubscriberFailure` (0428 で導入) の直前に `rejectPendingRequestUpdates` を置く。GOAWAY 受信済みは `!goawayReceived` ガード (0428 と共通) で弾く。
- 完了条件の「reject されない」は「rejectPendingRequestUpdates の呼び出し自体が起きない」と定義する。GOAWAY 掃除の競合による二度呼び自体は no-op (エントリ削除済み) だが、意図としては source: "session" / goawayReceived の分岐外で呼ばれないこと。
- 対象: subscribe ロール (bidi 系) と受信 PUBLISH の subscriber (runPublishStreamSubLoop)。publish ロールは pending が発生しない (`pendingRequestUpdate` の populate は SUBSCRIBE ロール側の `bidiSendRequestUpdate` / namespace 系 send 経由のみ) ため no-op。
- 実装順序: 0428 (受信 PUBLISH 経路の RESET markClosed 対称化) の後に本 issue を実装する。0428 が catch に `isPeerStreamError` 分岐を導入し `notifySubscriberFailure` を呼ぶ構造に整えるため、そこに reject を追加する形が bidi 側との対称になる。0428 より前に実装すると、`impl.state === "active" && !goawayReceived && !isSessionClosedError` の現行ガード下に reject を置くことになり、0428 実装時に配置換えが必要になる。
- 変更対象: `src/session/bidi.ts` (RESET 分岐に reject 追加、FIN 経路のインライン文字列を定数化) / `src/session.ts` (0428 実装後の RESET 分岐に reject 追加)、`src/session/bidi.test.ts` / `src/session.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- RESET_STREAM 相当のエラー終了 (`isPeerStreamError` true) で、該当 requestId の pendingRequestUpdate が reject され、エントリが削除されること (bidi 系 / 受信 PUBLISH 系の両方)。reject エラーは `Error(namespaceLoops.REQUEST_UPDATE_STREAM_CLOSED_MESSAGE)`。
- `subscriber.update()` の Promise が上記 reject 後に settle されること (同じ Error インスタンス)。
- 通知 (`notifySubscriberFailure` / `callbacks.error?.()`) が throw しても reject が既に実行済みで pending エントリが削除されていること。
- GOAWAY 受信済み (`goawayReceivedOnRequestStreams` に登録済み) では `rejectPendingRequestUpdates` の呼び出し自体が起きないこと (既存 GOAWAY 掃除に委ねる)。
- セッション終了 (source: "session" のエラー) では `rejectPendingRequestUpdates` の呼び出し自体が起きないこと (`isPeerStreamError` false により分岐外)。
- FIN 経路の既存挙動 (reject エラー文言含む) が変わらないこと。ただしインライン文字列 → `REQUEST_UPDATE_STREAM_CLOSED_MESSAGE` 定数への置き換えは同一文字列であるため回帰しない。
- 上記を検証するテストがあること (実 W3C ストリーム注入方式で bidi 系は `bidi.test.ts`、受信 PUBLISH 系は `session.test.ts` に追加)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure / 「An endpoint that receives a FIN before all required messages have arrived treats the request as failed.」RESET_STREAM は FIN よりも強い終了であり同原則が及ぶ)
- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM / STOP_SENDING の cancellation 手段としての定義)
- draft-ietf-moq-transport-19 §10.9.1 (Updating Subscriptions / REQUEST_UPDATE の応答 MUST および coalescing。応答未達は失敗確定)
- 関連: `issues/closed/0422-bug-fin-path-pending-request-update-leak.md` (FIN 経路の掃除。reject を先とする順序と reject エラー形式の混在許容の先例)
- 関連: `issues/closed/0410-bug-subscribe-error-end-not-notified.md` (RESET 通知の実装。「残余リスク (RESET 経路の pending リーク)」として記録)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md` (GOAWAY 掃除の先例)
- 関連: `issues/0428-bug-incoming-publish-reset-markclosed-missing.md` (受信 PUBLISH 経路の RESET markClosed 対称化。本 issue の実装順序の前提)

## 解決方法

`bidiReadRequestStreamMessages` (subscribe ロール) と `runPublishStreamSubLoop` の RESET_STREAM 分岐で、通知より先に `rejectPendingRequestUpdates` を呼ぶようにした。

- reject 文言は FIN 経路と同じ共通文言を採用し、bidi 側のインライン文字列も同一定数に揃える
- bidi 側は GOAWAY 受信済みを分岐条件で抑止し、セッション終了起因は `isPeerStreamError` で弾く。受信 PUBLISH 側は既存の GOAWAY・セッション終了ガードに委ねる
- 共通文言の定義は循環参照を避けて `src/session/errors.ts` に移し、`namespaceLoops.ts` から再公開する (既存参照は維持)
- テストは `src/session/bidi.test.ts` に 4 本、受信 PUBLISH 系は `src/session.test.ts` に 4 本追加する (正常掃除・throw 時の順序・GOAWAY 後と終了起因の非掃除)
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
