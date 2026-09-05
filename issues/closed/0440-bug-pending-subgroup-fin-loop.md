# pending mode で subscribers 未登録のピア FIN が無限ループになり abandon に到達しない

- Created: 2026-08-29
- Updated: 2026-09-05
- Completed: 2026-09-05
- Branch: feature/fix-pending-subgroup-fin-loop
- Polished: 2026-09-05

## 目的

`handleSubgroupStream` の pending mode (subscribers 未登録時) で、subscriber 登録前にピアが FIN した Subgroup ストリームを安全に abandon する。現状は `Promise.race` の再登録により chunk 分岐が常に勝って `end-of-stream` 通知が以後発火せず、`while (subscribers.length === 0)` ループがマイクロタスクを回り続けてイベントループを巻き込む。完了済みの単方向ストリームをピアが FIN だけで閉じられるため、悪意なく (あるいは単純な仕様準拠送信の実装差で) アプリ側をハングさせ得る重大な可用性欠陥である。

## 現状

- `handleSubgroupStream` (`src/session.ts`) の pending mode ループは `Promise.race([pendingRead.then(chunk), entry.notified.then(notify)])` で chunk 受信と subscriber 通知を並走させている。
- FIN 済み ReadableStream の `read()` は以後も即解決済みの `{done: true}` を返す。`Promise.race` の配列では `pendingRead.then(...)` が `entry.notified.then(...)` より先に登録されるため、両者が解決済みだと常に chunk 分岐が勝つ。
- chunk 分岐は `event.result.done` で `entry.notify("end-of-stream")` を呼ぶが、`entry.notified` は一度 resolve された Promise であり 2 周目以降は発火しない。`subscribers` が再代入されるのは notify 分岐のみなのでループ条件も永遠に変わらず、無限ループとなる。
- 実測 (issue 0427 レビュー時の再現プローブ): subscribers 未登録の Subgroup ヘッダー + FIN を `handleIncomingStream` に流すと `reader.read()` が数万回呼ばれて抜けない。`setTimeout(500)` 等のマクロタスクが餓死し、pending mode の 5 秒タイムアウト (`PendingSubgroupBuffer`) も発火しない。
- 本不具合は 0427 の変更以前から存在する (`handleSubgroupStream` の pending mode 導入時以来)。0427 のレビュー中に発見されたが、0427 の判定対象は subscriber mode に限定しているため挙動は従来どおりで、修正は本 issue の範囲。

## 設計方針

- chunk 分岐で `event.result.done` を検出した時点で、その場で abandon を完了させる (race の再登録を待たない)。手順は既存の abandon 経路と同一とし、`entry.notify("end-of-stream")` → `pendingSubgroupBuffer.remove(entry)` → `cancelStreamQuiet(reader, ...)` → return の順で行う。FIN 済みストリームに対する `cancelStreamQuiet` は実質 no-op だが、経路統一のため省略せず必ず呼ぶ。pending mode は payload を decode しないため draft-ietf-moq-transport-20 §11.4 の SHOULD (FIN が Object 途中の場合の PROTOCOL_VIOLATION) の判定ができず、0427 の対象外とした判断を継承して abandon する。subscribers 未登録のためアプリへのオブジェクト欠落は発生しない。
- FIN と subscriber 登録が同時解決した場合は subscriber 合流を優先する。chunk `done` 検出時も abandon 前に `subscribersByAlias` を再取得し、非空なら pending chunks を結合して subscriber mode へ合流し、空の場合のみ abandon する。同時解決時に chunk 分岐が常に勝つ飢餓を避けるための規則であり、`entry.notified` 側が先に勝つ既存経路の挙動は変えない。
- `PendingSubgroupEntry.notify` が多重 resolve されない構造 (`notified` Promise 1 個) であることは現状で確認済み。修正後の notify 呼び出し順序が timeout / overflow / session-close 通知と競合しても idempotent に abandon 完結することを守る。
- 修正の対称性として、`entry.notified` 側が先に勝つ既存経路 (subscriber 通知など) の挙動は変更しない。

## 完了条件

- subscribers 未登録の Subgroup ストリームにヘッダーのみを流したあと FIN すると、無限ループにならず `handleIncomingStream` が 5 秒以内に解決すること (実 W3C ReadableStream 注入、待機側は `Promise.race` で 5 秒タイムアウトを付けて検証する)。ヘッダー + 完全 Object 1 件 + FIN の形でも `end-of-stream` で abandon することを検証する。上限超過サイズは `overflow` 理由になるため本条件では扱わない。
- FIN 時に pending entry が `pendingSubgroupBuffer` から削除されること。
- pending 中に subscriber が登録された場合は pending chunks を結合して subscriber mode へ合流すること（新規テストで検証する。既存の subscriber mode FIN テストだけでは合流パスを guard できないため）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §11.4.2 (Subgroup Header / unknown Track Alias では abandon MAY)
- draft-ietf-moq-transport-20 §11.4.3 (Closing Subgroup Streams)
- 関連: `issues/closed/0427-bug-data-stream-fin-incomplete-object.md`（解決方法の「pending mode の FIN 処理の実態」項で発掘を記録）

## 解決方法

- `handleSubgroupStream` の pending mode で chunk の `done` を検出した時点で、その場で完結させるようにした。FIN 検出時に `subscribersByAlias` を再取得し、非空なら pending chunks を結合して subscriber mode へ合流し、空の場合のみ `entry.notify("end-of-stream")` → `remove` → `cancelStreamQuiet` → return で abandon する。
- テストは `src/session.test.ts` に 4 件追加した (ヘッダーのみ FIN・完全 Object 付き FIN・未完成 FIN の abandon と待機中 subscriber 登録の合流)。
- 触ったファイル: `src/session.ts`、`src/session.test.ts`、`CHANGES.md`。
