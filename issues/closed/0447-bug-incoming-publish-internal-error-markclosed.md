# 受信 PUBLISH ループの source なし内部エラーとセッション終了で subscriber が active のまま残る

- Created: 2026-08-31
- Updated: 2026-09-05
- Completed: 2026-09-05
- Branch: feature/fix-incoming-publish-internal-error-markclosed
- Polished: 2026-09-05

## 目的

受信 PUBLISH の後続メッセージループ (`runPublishStreamSubLoop`) が catch した source を持たない内部エラーとセッション終了起因エラーでは、アプリに error 通知する一方で subscriber の state を "active" のまま残す。受信 PUBLISH と namespace ループ (namespace / tracks) の対称化として、ストリームが死んだ後に state が active を名乗る不整合を解消する。subscribe ロール側の握りつぶしは本 issue では扱わず別途判断する。

## 現状

- `runPublishStreamSubLoop` の catch (`src/session.ts`) は、0428 の対応で source: "stream" (ピアの RESET_STREAM) を `bidi.notifySubscriberFailure` (error 通知 + markClosed) に統一したが、source を持たない内部例外の else 分岐は raw の `callbacks.error` を呼ぶだけで markClosed しない。ストリームはエラー終了しておりこれ以上の読み取りは起きないのに、subscriber は "active" のまま残る (セッション close まで state が誤ったまま)。
- subscribe ロール側 (`bidiReadRequestStreamMessages` の catch、`src/session/bidi.ts`) は source: "stream" 以外の内部例外では通知も markClosed も行わない (握りつぶし)。受信 PUBLISH 側は通知する点でさらに非対称。
- namespace ループ (namespace / tracks の 2 ループ。publication は `isSessionClosedError` ガードを持たず除外) は source を見ず、`subscription.state === "active" && !goawayReceived` なら一律で `subscription.state = "closed"` にしてから通知する (セッション終了時は通知しない)。受信 PUBLISH と namespace / tracks の対称化が本 issue の範囲である。
- 影響: `Subscriber` の state が active のまま残ると、アプリは `update()` / `unsubscribe()` を継続できると誤認する (`update()` は送信部で別途失敗する)。`handleObject` / `handleDatagram` はロックされている reader からの配信が止まるため実害は出ないが、state の意味論としては不整合。
- 変更対象: `src/session.ts` (`runPublishStreamSubLoop` の catch)、`src/session.test.ts` (既存テストの「source なしエラーでは state は active のまま」アサーションの追従を含む)、`CHANGES.md`。

## 設計方針

- namespace ループ (namespace / tracks) と同じ規則に揃える: catch したエラーは source を問わず、GOAWAY 受信済みでない限り error 通知の有無にかかわらず state を closed にする。source: "session" のときは通知せず markClosed する (セッション終了は `ConnectCallbacks.close` で検知されるが、request 単位の state を active に残す理由はない。`ConnectCallbacks.close` (セッション通知) と subscription の `callbacks.error` (購読通知) は別チャネルのため二重の失敗通知にはならないことは namespace ループの現行挙動が先例)。応答待ちの REQUEST_UPDATE は source を問わず通知より先に reject する (兄弟分岐・namespace ループと同順。reject しないと `update()` が永続ハングし、transport.closed ハンドラも `close()` も回収しないため)。
- 通知対象の分岐 (source: "stream" は `createResetStreamError` による errorCode 付き通知 + markClosed、source なしは raw 通知 + markClosed、source: "session" は無通知 + markClosed) と、GOAWAY 受信済みの抑止 (通知 / state 変更ともに行わない。外側の `!goawayReceived` ガードを維持) を現状の分岐構造のまま整理する。source なし分岐は `notifySubscriberFailure` の内部契約 (try/finally で markClosed 保証) に寄せ、`rejectPendingRequestUpdates` は通知より先に実行する (stream 分岐と同順。アプリの error コールバックが throw しても reject が実行される)。`toProtocolViolationSessionError` による `closeWithError` は現行維持する。
- subscribe ロール側 (`bidiReadRequestStreamMessages`) の内部例外の扱い (通知も state 変更もしない) を namespace ループ規則へ寄せるかは本 issue のスコープに含めない。寄せるなら別 issue で 3 経路を同時に扱う判断とする。

## 完了条件

- source を持たない内部エラーを catch した場合、error 通知されたうえで subscriber の state が closed になること。
- source: "session" のエラーでは従来どおり通知せず、state が closed になり、応答待ちの更新は reject されること (既存テスト「応答待ちの更新に触れない」は新規則へ追従させる)。
- source: "stream" (RESET) の挙動 (`createResetStreamError` による errorCode 付き通知 + markClosed) は変わらないこと (回帰ガード)。
- GOAWAY 受信済みでは通知も state 変更も行われないこと (現行維持)。
- `toProtocolViolationSessionError` による `closeWithError` は現行維持すること (PROTOCOL_VIOLATION 級では markClosed とセッション終了の両方が発火し得る)。
- `src/session.test.ts` の既存テスト「受信 PUBLISH ストリーム上の source なしエラーでは error 通知されるが state は active のまま」「同 source なしエラーで error コールバックが throw しても後始末は走る」およびセッション終了のテストが新しい規則へ追従していること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §3.5 (Termination: 「The Transport Session can be terminated at any point.」)
- draft-ietf-moq-transport-20 §5.1 (Subscriptions: Terminated への遷移。内部エラー → Terminated の写像は仕様の要請ではなく namespace ループとの対称化という実装上の判断)
- 関連: `issues/closed/0428-bug-incoming-publish-reset-markclosed-missing.md` (RESET 経路の markClosed 対称化。本 issue は残った source なし / source: "session" 経路を扱う)
- 関連: `issues/0444-bug-peer-session-close-markclosed-missing.md` (transport.closed 由来のセッション終了で markClosed が走らない問題。state を閉じる対象経路が重なるため実装順は 0444 の後に本 issue を行う)

## 解決方法

- `runPublishStreamSubLoop` の catch を再構成した。応答待ちの更新の reject を 3 分岐共通の先頭へ hoist し、source: "session" は通知なし + markClosed、source: "stream" は従来どおり通知 + markClosed、source なしは reject 先行 + 通知 + markClosed とした。未使用になった callbacks 引数を除去した。
- 磨き直しで session 分岐の保留 reject を設計に取り込んだ (レビューで検出した update() 永続ハングの防止。namespace ループと同順)。
- テストは `src/session.test.ts` の 2 件を追従させ、1 件を更新した (source なし 2 件・session 1 件)。
- 触ったファイル: `src/session.ts`、`src/session.test.ts`、`CHANGES.md`。
