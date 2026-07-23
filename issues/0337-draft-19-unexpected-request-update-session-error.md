# 予期しない REQUEST_UPDATE 受信でセッションを PROTOCOL_VIOLATION で閉じる (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-request-update-session-error
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.9 (REQUEST_UPDATE) に、予期しない REQUEST_UPDATE の扱いが追加された。変更履歴は Appendix A.1 `#1784` ("Unexpected REQUEST_UPDATE is a session error")。

draft-19 Section 10.9 が許可する 2 ケース:

1. リクエスト送信側 (SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) が、同一 bidi ストリーム上で後から REQUEST_UPDATE を送る
2. subscriber が、PUBLISH で確立したサブスクリプションのパラメータを REQUEST_UPDATE で変更する

> An endpoint that receives a REQUEST_UPDATE other than in the two
> cases above MUST close the session with a PROTOCOL_VIOLATION.

必須応答の規則 (同一節):

> The receiver of a REQUEST_UPDATE MUST respond with exactly one
> REQUEST_OK or REQUEST_ERROR message indicating if the update was
> successful, unless it is coalescing failed updates to produce just
> one REQUEST_ERROR for multiple REQUEST_UPDATE messages.

coalescing 自体は Appendix A.2 `#1540` ("Allow coalescing REQUEST_UPDATE processing") で draft-17 → 18 に入った規定であり、draft-19 新設ではない。draft-19 で新規なのは上記 MUST close 側である。実装では両方を同時に扱う必要がある。

あわせて Section 10.9.1 (Updating Subscriptions) の失敗時クローズ:

> When a REQUEST_UPDATE fails for a SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS or
> PUBLISH_NAMESPACE, the responder MUST close the bidi stream (see
> Section 3.3.2).

## 優先度根拠

moqt-js は予期しない REQUEST_UPDATE を受けたときに REQUEST_ERROR を返してセッションを継続しており、Section 10.9 の MUST に違反する。プロトコル準拠違反だが、攻撃・誤動作ピアからの防御でありデータパスの相互運用は壊さないため Medium。

## 現状

- `src/session/bidi.ts`: PUBLISH リクエストストリームループの `case MessageType.REQUEST_UPDATE`。マッチする publisher が見つかれば FORWARD を反映し REQUEST_OK を返す
- 同箇所: publisher が見つからない場合に REQUEST_ERROR (INTERNAL_ERROR) を返すだけでセッションを閉じない。draft-19 では PROTOCOL_VIOLATION で閉じるべきケース
- `src/session/bidi.ts`: doc コメントが「MUST respond with exactly one」のみを引用しており、coalescing 例外が未反映
- `src/session.ts`: 送信側は `pendingRequestUpdate` で「1 REQUEST_UPDATE = 1 応答」を前提に管理している

## 設計方針

- 受信側: Section 10.9 の 2 ケースに該当しない REQUEST_UPDATE を受信したら、REQUEST_ERROR ではなく ProtocolViolationError でセッションを閉じる
- 送信側: 複数の REQUEST_UPDATE を送った際に、coalescing により単一の REQUEST_ERROR しか返らないケースで `pendingRequestUpdate` の解決漏れが起きないかを検証し、必要なら失敗時にまとめて reject する
- Section 10.9.1 に従い、SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE で REQUEST_UPDATE が失敗したら bidi ストリームを閉じる処理を受信・送信の双方で確認・実装する
- 仕様参照コメントを draft-19 Section 10.9 / 10.9.1 の文言に更新する

## 完了条件

- 対応するリクエストが存在しないストリームへの REQUEST_UPDATE 受信で、セッションが PROTOCOL_VIOLATION で閉じるテストがあること
- 複数 outstanding REQUEST_UPDATE に対して単一の REQUEST_ERROR が返った場合に、送信側の待機がリークしないテストがあること
- lint / build / typecheck / 既存テストが通ること
