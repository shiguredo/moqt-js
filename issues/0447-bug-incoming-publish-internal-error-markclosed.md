# 受信 PUBLISH ループの source なし内部エラーで subscriber が active のまま残る

- Created: 2026-08-31
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-incoming-publish-internal-error-markclosed
- Polished: {YYYY-MM-DD}

## 目的

受信 PUBLISH の後続メッセージループ (`runPublishStreamSubLoop`) が catch した source を持たない内部エラーでは、アプリに error 通知する一方で subscriber の state を "active" のまま残す。3 つの購読経路 (受信 PUBLISH / subscribe ロール / namespace ループ) のうちこの 1 経路だけ例外扱いになっており、ストリームが死んだ後に state が active を名乗る非対称を解消する。

## 現状

- `runPublishStreamSubLoop` の catch (`src/session.ts`) は、0428 の対応で source: "stream" (ピアの RESET_STREAM) を `bidi.notifySubscriberFailure` (error 通知 + markClosed) に統一したが、source を持たない内部例外の else 分岐は raw の `callbacks.error` を呼ぶだけで markClosed しない。ストリームはエラー終了しておりこれ以上の読み取りは起きないのに、subscriber は "active" のまま残る (セッション close まで state が誤ったまま)。
- subscribe ロール側 (`bidiReadRequestStreamMessages` の catch、`src/session/bidi.ts`) は source: "stream" 以外の内部例外では通知も markClosed も行わない (握りつぶし)。受信 PUBLISH 側は通知する点でさらに非対称。
- namespace ループ (`src/session/namespaceLoops.ts` の catch、namespace / tracks / publication の 3 ループ) は source を見ず、`subscription.state === "active" && !goawayReceived` なら一律で `subscription.state = "closed"` にしてから通知する (セッション終了時は通知しない)。3 経路中、内部エラーで state を閉じるのは namespace ループだけである。
- 影響: `Subscriber` の state が active のまま残ると、アプリは `update()` / `unsubscribe()` を継続できると誤認する (`update()` は送信部で別途失敗する)。`handleObject` / `handleDatagram` はロックされている reader からの配信が止まるため実害は出ないが、state の意味論としては不整合。
- 変更対象: `src/session.ts` (`runPublishStreamSubLoop` の catch)、`src/session.test.ts` (既存テストの「source なしエラーでは state は active のまま」アサーションの追従を含む)、`CHANGES.md`。

## 設計方針

- namespace ループと同じ規則に揃える: catch したエラーは source を問わず、GOAWAY 受信済みでない限り error 通知の有無にかかわらず state を closed にする。source: "session" のときは通知せず markClosed だけする (セッション終了は `ConnectCallbacks.close` で検知されるが、request 単位の state を active に残す理由はない。この通知 / state の組み合わせが `ConnectCallbacks.close` と二重の失敗通知にならないことは namespace ループの現行挙動が先例)。
- 通知対象の分岐 (source: "stream" は固定文言 + markClosed、source なしは raw 通知 + markClosed、source: "session" は無通知 + markClosed) と、GOAWAY 受信済みの抑止 (通知 / state 変更ともに行わない) を現状の分岐構造のまま整理する。
- subscribe ロール側 (`bidiReadRequestStreamMessages`) の内部例外の扱い (通知も state 変更もしない) を namespace ループ規則へ寄せるかは本 issue のスコープに含めない。寄せるなら別 issue で 3 経路を同時に扱う判断とする。

## 完了条件

- source を持たない内部エラーを catch した場合、error 通知されたうえで subscriber の state が closed になること。
- source: "session" のエラーでは従来どおり通知せず、state だけが closed になること。
- source: "stream" (RESET) の挙動 (固定文言 + markClosed) は変わらないこと (回帰ガード)。
- GOAWAY 受信済みでは通知も state 変更も行われないこと (現行維持)。
- `src/session.test.ts` の既存テスト「受信 PUBLISH ストリーム上の source なしエラーでは error 通知されるが state は active のまま」「同 source なしエラーで error コールバックが throw しても後始末は走る」およびセッション終了のテストが新しい規則へ追従していること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §3.5 (Termination: 「The Transport Session can be terminated at any point.」)
- draft-ietf-moq-transport-20 §5.1 (Subscriptions: Terminated への遷移。内部エラー → Terminated の写像は仕様の要請ではなく namespace ループとの対称化という実装上の判断)
- 関連: `issues/closed/0428-bug-incoming-publish-reset-markclosed-missing.md` (RESET 経路の markClosed 対称化。本 issue は残った source なし / source: "session" 経路を扱う)
- 関連: `issues/0444-bug-peer-session-close-markclosed-missing.md` (transport.closed 由来のセッション終了で markClosed が走らない問題。state を閉じる対象経路が重なるため実装順は本 issue → 0444 が自然)
