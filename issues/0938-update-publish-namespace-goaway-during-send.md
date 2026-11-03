# PUBLISH_NAMESPACE の送信待ちに GOAWAY が届いた場合の扱いを決める

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/update-publish-namespace-goaway-during-send
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §9.2 は、制御ストリームで GOAWAY を受信した endpoint が新しいリクエストを開始しない SHOULD NOT を定める。`Session.publishNamespace()` は呼び出し時点の `receivedGoaway` を検査して拒否するが、ストリーム作成と write の await の間に GOAWAY を受信した場合は検査しないまま送信する。0890 でこの再検査を実装したが issue の完了条件外だったため削除した。判断を記録し、必要なら実装する。

## 現状

- `src/session/namespaces.ts` の `namespacesPublishNamespace` は冒頭で `receivedGoaway` を検査して拒否する
- detached な `namespacesSendPublishNamespace` は、ストリーム作成後と write 完了後に Session の状態 (`closed`) だけを再確認し、`receivedGoaway` は再確認しない
- `docs/LOW_LEVEL_API.md` の GOAWAY 節は「goawayReceived が立った後は新しい Namespace 系 request を拒否する」と記載している
- 0890 の実装では再検査を追加したが、issue の範囲外として削除した
- `subscribeNamespace` / `subscribeTracks` にも同じ窓がある (`issues/0933`)

## 設計方針

次のいずれかを選び、判断と根拠を記録する。

- 案 A: ストリーム作成後と write 完了後に `receivedGoaway` を再確認し、受信していれば送信せずに reject してストリームを解放する。API 呼び出し時点で「開始済み」と解釈する案より仕様の SHOULD NOT に忠実
- 案 B: API 呼び出し時点で開始済みと解釈し、送信中の GOAWAY では拒否しない。この場合、docs の GOAWAY 節に「送信開始後の GOAWAY では送信を継続する」と明記する

namespace 系全体 (subscribeNamespace / subscribeTracks) と揃える。案 A を選ぶ場合は 0933 と同じ形で実装する。

## 完了条件

- 送信待ちの GOAWAY の扱いが決まり、実装または docs に反映されている
- 選んだ案の挙動をテストで固定する
- `docs/LOW_LEVEL_API.md` の GOAWAY 節と `Session.publishNamespace` の JSDoc が実装と一致する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesPublishNamespace` / `namespacesSendPublishNamespace`
- `src/session/lifecycle.ts` の `sessionHandleGoaway` / `sessionGoaway`
- `docs/LOW_LEVEL_API.md` の GOAWAY 節
- `issues/0933-bug-subscribe-namespace-pending-settle.md`
- draft-ietf-moq-transport-22 §9.2 / §6.6.1
