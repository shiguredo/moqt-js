# PUBLISH_OK 書き込み失敗が無音で後始末をスキップし subscriber が残存する

- Created: 2026-08-31
- Updated: 2026-09-05
- Completed: 2026-09-05
- Branch: feature/fix-publish-ok-write-failure-cleanup
- Polished: 2026-09-05

## 目的

受信 PUBLISH 処理で PUBLISH_OK の書き込みが失敗した場合、後続の後始末 (subscribers / subscribersByAlias / requestStreams の削除とロック解放) がまとめてスキップされ、しかも unhandled rejection になる問題を修正する。残存した subscriber は後続の重複 Track Alias 判定で誤検出を起こす。

## 現状

- `handleIncomingBidirectionalStream` (`src/session.ts`) は `subscribers` / `subscribersByAlias` / `requestStreams` への登録と `impl.onUnsubscribe` / `impl.onUpdate` の配線、`pendingSubgroupBuffer.notifyAlias` の後に、ブロック内で `await subWriter.write(framed)` (PUBLISH_OK 送信、§5.1 MUST) を実行するが、この await は try で守られていない。
- `write()` の失敗は writable がエラー状態 (ピアの RESET_STREAM / セッション終了等) の場合に起きる (`src/session/incoming.ts` の `incomingSendRequestErrorAndClose` のコメントが同じ前提を明記している)。reject すると `handleIncomingBidirectionalStream` の Promise 自体が reject し、直後の後始末 (`requestStreams.delete` / `subscribers.delete` / alias の splice / `subReader.releaseLock()` / `subWriter.releaseLock()`) がすべてスキップされる。
- 呼び出し元は `startIncomingBidirectionalStreamLoop` の `void this.handleIncomingBidirectionalStream(stream)` (fire-and-forget) で、`.catch` が無いため unhandled rejection になる。`runPublishStreamSubLoop` の catch 経路でアプリの error コールバック例外を吸収したのと同じ被害の別経路が塞がれていない。
- 残存の実害: `SessionImpl.close()` は `subscribers` の `markClosed` はするが Map から削除しないため、死んだ subscriber がセッション寿命中残る。同一セッションでピアが別 Track に同一 Track Alias を再割り当てすると、`handleIncomingBidirectionalStream` の重複 Track Alias 検証が死んだ subscriber と突き合わせて `DUPLICATE_TRACK_ALIAS` でセッションを閉じる誤検出を起こし得る。§11.1 は同時使用 (simultaneous) のみを禁じ、終了済み購読後の再使用は completely closed (Map 削除) を条件に許容する (SHOULD NOT ... unless completely closed)。`markClosed` だけでは足りず Map 削除が必須である。
- 変更対象: `src/session.ts` (`handleIncomingBidirectionalStream`)、`src/session.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- 登録以後の一連の処理 (`PUBLISH_OK 送信` + `runPublishStreamSubLoop` + 後始末) を try/finally に組み替え、後始末 (3 マップの削除 + fill 関連付けの掃除 (`deleteFillTargetsForSubscriber`)、`subReader.releaseLock()`、`subWriter.releaseLock()`) を exit 経路に依らず必ず実行する。既に `notifySubscriberFailure` の内部 try/finally で守っている RESET / FIN 通知意味論は変えない。通知は Map 削除より前に行う（`notifySubscriberFailure` は `subscribers.get` で対象を引くため、削除後では無操作になる）。
- PUBLISH_OK の書き込みが失敗した場合は失敗として扱う。書き込みが失敗した以上 §5.1 MUST の PUBLISH_OK は送信できておらず、その subscription を active のまま残す意味がないため、いずれの source でも `markClosed` する。通知の有無は source で分ける: source が "stream" または source なしの場合は `bidi.notifySubscriberFailure` で error 通知 + state closed、source が "session" の場合は通知せず state closed とする（0447 の source なしは通知 + closed、`source: "session"` は無通知 + closed の規則と整合）。「無音」とは `error` 通知抑止とセッション非閉鎖を指し、unhandled rejection の観測可能性とは別である。構造的なリーク防止 (finally 化) が主目的で、通知の追加は従属的な判断としてレビューで確認する。
- `handleIncomingBidirectionalStream` 自体は throw させないことを設計として確定する（0428 の吸収一本化と同形）。fire-and-forget の呼び出し側での吸収は行わず、関数内で完結させる。

## 完了条件

- PUBLISH_OK の `write()` が reject する場合、`handleIncomingBidirectionalStream` の Promise が unhandled rejection を発生させないこと (テスト側で await して reject しないことを検証)。
- 同ケースで `subscribers` / `subscribersByAlias` / `requestStreams` のエントリが残らず、ロックが解放されること。
- source が "stream" または source なしの書き込み失敗では subscriber に error 通知が入り state が closed になること。source が "session" の失敗では通知せず state が closed になること。注入する失敗値の `source` 分類は `src/session/errors.ts` の既存判定に従い、"stream" 系は `source: "stream"` 付き WebTransportError、"session" 系と source なし系を別ケースとして用意すること。
- 残存が消えた結果、別 Track への同一 Track Alias の後続 PUBLISH が `DUPLICATE_TRACK_ALIAS` で誤検出されないことを検証するテストがあること。
- 実 W3C ストリーム注入方式のテストがあること (書き込み失敗を再現する writable を注入する。失敗値の `source` 付き・なしを作り分ける)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1 (Subscriptions: PUBLISH_OK の MUST、subscriber による解除は STOP_SENDING)
- draft-ietf-moq-transport-20 §11.1 (Track Alias: 同時使用の禁止。終了済み購読後の再使用は SHOULD NOT ... unless completely closed の条件付きで許容)
- 関連: `issues/closed/0428-bug-incoming-publish-reset-markclosed-missing.md` (サブループ側の catch 経路でアプリ例外を吸収した対応。本 issue は同じ失敗モードの PUBLISH_OK 書き込み経路を扱う)
- 関連: `issues/closed/0107-bug-session-close-leaks-streams.md` (セッション close 時のストリームリーク追跡の先例)

## 解決方法

- `handleIncomingBidirectionalStream` の登録以後 (PUBLISH_OK 送信 + サブループ + 後始末) を try/finally 化し、後始末を `cleanupIncomingPublish()` に抽出して exit 経路に依らず必ず実行するようにした。関数は throw しない。
- PUBLISH_OK 書き込み失敗時は source 別に処理する (session は通知なし + markClosed、stream / なしは通知 + closed)。ピア stream エラーは subloop の RESET 経路と同じ文言に正規化する。
- テストは `src/session.test.ts` に 5 件追加した (stream / なし / 非 Error / session / alias 再利用)。
- 触ったファイル: `src/session.ts`、`src/session.test.ts`、`CHANGES.md`。
