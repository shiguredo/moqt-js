# PUBLISH_NAMESPACE の送信待ちに GOAWAY が届いた場合の扱いを決める

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/update-publish-namespace-goaway-during-send
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

draft-ietf-moq-transport-23 §9.2 は、制御ストリームで GOAWAY を受信した endpoint が新しいリクエストを開始しない SHOULD NOT を定める。`Session.publishNamespace()` は呼び出し時点の `receivedGoaway` を検査して拒否するが、ストリーム作成と write の await の間に GOAWAY を受信した場合は検査しないまま送信する。0890 では、この再検査を issue の完了条件外として実装しなかった。本 issue で判断を記録し、必要なら実装する。

## 現状

- `src/session/namespaces.ts` の `namespacesPublishNamespace` は冒頭で `receivedGoaway` を検査して拒否する
- detached な `namespacesSendPublishNamespace` は、ストリーム作成後と write 完了後に Session の状態 (`closed`) だけを再確認し、`receivedGoaway` は再確認しない
- `docs/LOW_LEVEL_API.md` の GOAWAY 節は「`goawayReceived` が立った後は新しい Namespace 系 request を拒否する」と記載している
- 0890 では、この再検査を issue の範囲外として実装しなかった (0890 の解決方法は「API 呼び出し時点で開始済みと解釈する」と記録している)
- `subscribeNamespace` / `subscribeTracks` にも同じ窓がある。共用の `namespacesSendSubscription` は、ストリーム作成後と write 完了後に Session の状態 (`closed`) だけを再確認し、`receivedGoaway` は再確認しない (closed の `issues/closed/0933-bug-subscribe-namespace-pending-settle.md` がこの論点を 0938 の判断に委ねている)

## 設計方針

次のいずれかを選び、判断と根拠を issue の「解決方法」に記録する。namespace 系全体 (`publishNamespace` / `subscribeNamespace` / `subscribeTracks`) で同じ扱いに揃える。

- 案 A: ストリーム作成後と write 完了後に `receivedGoaway` を再確認し、受信していれば reject してストリームを解放する。API 呼び出し時点で「開始済み」と解釈する案より仕様の SHOULD NOT に忠実
  - 確認位置は、`createBidirectionalStream` の await を抜けた直後と `writer.write` の await を抜けた直後とする
  - ストリーム作成後に受信していれば write せずに、write 完了後に受信していれば既に送信済みのため応答を待たずに、それぞれの送信待ちの Map (`pendingNamespacePublication` / `pendingNamespaceSubscription` / `pendingTracksSubscription`) から削除して reject し、ストリームを解放する
  - reject の理由は入口の検査と同じ API ごとの文言 (`cannot publish namespace after receiving GOAWAY` / `cannot subscribe namespace after receiving GOAWAY` / `cannot subscribe tracks after receiving GOAWAY`) とする
  - write 前に検出した場合、予約済みなら認可トークンの予約を取り消す。write 後に検出した場合は送信済みのため取り消さない
  - 後始末は既存の Session の `closed` 再確認と同じ経路 (`requestsReleaseUnlockedStream` / `namespacesCleanupSendFailure`) を使い、cancel / abort の理由は `received GOAWAY` とする
  - `docs/LOW_LEVEL_API.md` の GOAWAY 節と「Namespace 系の扱い」、`Session.publishNamespace` / `subscribeNamespace` / `subscribeTracks` の JSDoc に「ストリーム作成後または write 完了後に GOAWAY を受信した場合は reject する」と明記する
- 案 B: API 呼び出し時点で開始済みと解釈し、呼び出し後の GOAWAY (ストリーム作成 / write の await 中を含む) では拒否せず、送信と応答待ちを継続する
  - `docs/LOW_LEVEL_API.md` の GOAWAY 節と「Namespace 系の扱い」、`Session.publishNamespace` / `subscribeNamespace` / `subscribeTracks` の JSDoc に「呼び出し後に GOAWAY を受信しても、送信待ちのリクエストは送信と応答待ちを継続する」と明記する

案 A を選ぶ場合は、`namespacesSendPublishNamespace` と `namespacesSendSubscription` の両方で、0933 の `namespacesSendSubscription` の手順 2 / 5 の Session 状態確認と同じ箇所に `receivedGoaway` の確認を加える。案 B を選ぶ場合は実装を変えず、docs / JSDoc だけを更新する。

## 完了条件

- 送信待ちの GOAWAY の扱いが決まり、選んだ案と根拠が issue の「解決方法」に記録されている
- 選んだ案に応じて、実装または docs / JSDoc が更新されている
- 選んだ案の挙動をテストで固定する。案 A は、ストリーム作成待ちの間に GOAWAY を受信したときは write されずに reject してストリームを解放し、write 待ちの間に受信したときは送信済みのまま reject してストリームを解放することを固定する。案 B は、呼び出し後の GOAWAY でも送信と登録が継続することを固定する
- `docs/LOW_LEVEL_API.md` の GOAWAY 節と「Namespace 系の扱い」、`Session.publishNamespace` / `subscribeNamespace` / `subscribeTracks` の JSDoc が実装と一致する
- `vp check` と `vp test run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesSendPublishNamespace` / `namespacesSendSubscription`
- `src/session.ts` の `SessionImpl.handleGoaway`
- `src/session/lifecycle.ts` の `sessionHandleGoaway` / `sessionGoaway`
- `docs/LOW_LEVEL_API.md` の GOAWAY 節と「Namespace 系の扱い」
- `src/session.test.ts` の `createHeldBidiStreamTransport` / `createPendingNamespaceTransport`
- `issues/closed/0933-bug-subscribe-namespace-pending-settle.md`
- draft-ietf-moq-transport-23 §9.2 / §6.6.1
