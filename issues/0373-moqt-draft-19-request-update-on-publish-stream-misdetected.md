# 受信 PUBLISH ストリーム上の REQUEST_UPDATE を PROTOCOL_VIOLATION で誤検知する

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-request-update-on-publish-stream-misdetected
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.9 のケース 1「リクエスト送信者 (PUBLISH を送った publisher) は同じ bidi ストリーム上で REQUEST_UPDATE を送信できる」を正しく処理する。現在は SUBSCRIBE_TRACKS 経由で受信した PUBLISH ストリーム上で REQUEST_UPDATE を受信すると「unknown message type」として PROTOCOL_VIOLATION でセッションを閉じる。

## 優先度根拠

SUBSCRIBE_TRACKS 経由の受信 PUBLISH は §10.19 で定義される正規のフローであり、その publisher が REQUEST_UPDATE を送るのは §10.9 で明示的に許可されている。現状の実装は合法メッセージをプロトコル違反として誤検知し、セッション全体を切断する。Medium。

## 現状

- `src/session.ts:3232-3237` (`runPublishStreamSubLoop`) で、PUBLISH_DONE / GOAWAY / REQUEST_OK / REQUEST_ERROR 以外のメッセージを「unknown message type on publish stream」として `closeWithError(PROTOCOL_VIOLATION)` する。
- REQUEST_UPDATE はこの分岐に該当し、§10.9 ケース 1 (sender of the request が同じ bidi stream で REQUEST_UPDATE を送る) の合法メッセージを誤検知する。
- 主目的の #1784 対応 (SUBSCRIBE ストリーム上の予期しない REQUEST_UPDATE → PROTOCOL_VIOLATION) は `bidi.ts:704-708` に実装済み。

## 設計方針

- `runPublishStreamSubLoop` に REQUEST_UPDATE のケースを追加し、パラメータスコープ検証後に REQUEST_OK または REQUEST_ERROR を応答する。
- SUBSCRIBE_TRACKS 経由の受信 PUBLISH に対する REQUEST_UPDATE は、Location Filter 等のパラメータ更新として扱う (SubscriberImpl への反映方針は受信 PUBLISH の FORWARD 反映 issue と整合させる)。
- 応答は §10.9 の「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR」に従う。

## 完了条件

- 受信 PUBLISH ストリーム上で REQUEST_UPDATE を受信してもセッションが閉じず、REQUEST_OK または REQUEST_ERROR が応答されること。
- パラメータスコープ違反の REQUEST_UPDATE は REQUEST_ERROR で応答されること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE)
- draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS)

## 解決方法

未着手。
