# .session / 予約 namespace のリクエスト拒否が未実装

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/change-moqt-draft-19-session-level-namespace-not-rejected
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §3.2.1 / §3.2.2 の MUST 要件を満たす。`.session` 名前空間 (および `.` で始まる予約名前空間) へのリクエストを REQUEST_ERROR (DOES_NOT_EXIST) で拒否し、アプリケーションへ渡さない。現在はヘルパー関数が定義されているだけで実行パスに接続されていない。

## 優先度根拠

§3.2.2 は「The Application MUST NOT publish tracks or namespaces whose first field is .session.」と「An endpoint that receives a request for an unrecognized session-level track or namespace MUST reject it with REQUEST_ERROR using error code DOES_NOT_EXIST rather than passing it to the Application.」を定める。現在は受信 PUBLISH が `.session` namespace でもそのままアプリの `onPublish` に渡る。Medium。

## 現状

- `src/message/parameter.ts:368-387` に `isReservedNamespace()` / `isSessionLevelNamespace()` が定義され、`src/message/index.ts:60-61` で re-export されているが、実行パスから一切使用されていない。
- `publish()` / `subscribe()` / `fetch()` / `publishNamespace()` は `.session` 名前空間をブロックしない。
- 受信 PUBLISH が `.session` namespace でもアプリにそのまま渡る (DOES_NOT_EXIST 拒否なし)。

## 設計方針

- `isReservedNamespace()` / `isSessionLevelNamespace()` を送受信のリクエスト経路に接続する。
- 送信側: `.session` / 予約名前空間への publish / subscribe / fetch / publishNamespace をアプリ層で拒否する。
- 受信側: 受信 PUBLISH (および将来の受信リクエスト) が `.session` / 予約名前空間の場合、REQUEST_ERROR (DOES_NOT_EXIST) を返してストリームを閉じる。
- `.session` namespace の空 Track Name は §3.2.2 の「MUST be rejected with DOES_NOT_EXIST」に従う。

## 完了条件

- `.session` / 予約名前空間へのリクエストが送受信とも拒否されること。
- 受信側は REQUEST_ERROR (DOES_NOT_EXIST) で応答し、アプリに渡さないこと。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.2.1 (Reserved Namespaces)
- draft-ietf-moq-transport-19 §3.2.2 (Session-Level Tracks and Namespaces)

## 解決方法

未着手。
