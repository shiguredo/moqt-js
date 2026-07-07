# 予期しない REQUEST_UPDATE 受信でセッションを PROTOCOL_VIOLATION で閉じる (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-request-update-session-error
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 Section 10.9 (REQUEST_UPDATE) に、予期しない REQUEST_UPDATE の扱いが新規追加された (draft-18 → 19 変更履歴 "Unexpected REQUEST_UPDATE is a session error (#1784)")。

draft-19 Section 10.9:

> An endpoint that receives a REQUEST_UPDATE other than in the two
> cases above MUST close the session with a PROTOCOL_VIOLATION.

(two cases = 同一リクエストストリーム上でのリクエスト変更、および PUBLISH で確立したサブスクリプションの subscriber による変更)

あわせて必須応答の規則が緩和された (PR #1648):

> The receiver of a REQUEST_UPDATE MUST respond with exactly one
> REQUEST_OK or REQUEST_ERROR message ... unless it is coalescing
> failed updates to produce just one REQUEST_ERROR for multiple
> REQUEST_UPDATE messages.

draft-18 にはこの MUST close 規定と coalescing の例外句は存在しない。

## 優先度根拠

moqt-js は予期しない REQUEST_UPDATE を受けたときに REQUEST_ERROR を返してセッションを継続しており、draft-19 の MUST に違反する。プロトコル準拠違反だが、攻撃・誤動作ピアからの防御の話でありデータパスの相互運用は壊さないため Medium。

## 現状

- `src/session/bidi.ts:703-771`: PUBLISH リクエストストリームループの `case MessageType.REQUEST_UPDATE`。マッチする publisher が見つかれば FORWARD を反映し REQUEST_OK を返す (`src/session/bidi.ts:728-746`)
- `src/session/bidi.ts:747-769`: publisher が見つからない場合に REQUEST_ERROR (INTERNAL_ERROR) を返すだけでセッションを閉じない。draft-19 では PROTOCOL_VIOLATION でセッションを閉じるべきケース
- `src/session/bidi.ts:710-712`: doc コメントが draft-18 の「MUST respond with exactly one」を引用しており、coalescing 例外が未反映
- `src/session.ts:937`: 送信側は `pendingRequestUpdate` で「1 REQUEST_UPDATE = 1 応答」を前提に管理している

## 設計方針

- 受信側: draft-19 Section 10.9 の 2 ケースに該当しない REQUEST_UPDATE を受信したら、REQUEST_ERROR ではなく ProtocolViolationError でセッションを閉じるように変更する
- 送信側: 複数の REQUEST_UPDATE を送った際に、coalescing により単一の REQUEST_ERROR しか返らないケースで `pendingRequestUpdate` の解決漏れ (宙吊りの Promise) が起きないかを検証し、必要なら失敗時にまとめて reject する処理を入れる
- あわせて draft-19 Section 10.9.1 で REQUEST_UPDATE 失敗時の双方向ストリームクローズ対象に SUBSCRIBE_TRACKS が追加された点 (draft-18 は SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE のみ) を受信・送信処理に反映する
- 仕様参照コメントを draft-19 Section 10.9 の文言に更新する

## 完了条件

- 対応するリクエストが存在しないストリームへの REQUEST_UPDATE 受信で、セッションが PROTOCOL_VIOLATION で閉じるテストがあること
- 複数 outstanding REQUEST_UPDATE に対して単一の REQUEST_ERROR が返った場合に、送信側の待機がリークしないテストがあること
- lint / build / typecheck / 既存テストが通ること
