# namespace / tracks ストリーム上の制御メッセージのデコード失敗が黙殺されセッションが閉じない

- Priority: Medium
- Created: 2026-08-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-stream-decode-failure-session-close
- Polished: {YYYY-MM-DD}

## 目的

`src/session/namespaceLoops.ts` の `namespaceStartStreamLoop` / `namespaceStartTracksStreamLoop` で、Body 短縮等によるデコード失敗 (`IncompleteDataError`) が外側 catch で黙殺され、セッションが開いたままになる問題を修正する。draft-ietf-moq-transport-19 §10 の MUST「If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.」の短縮方向を満たす。

## 現状

- 制御メッセージのデコーダは、Body 短縮 (varint 途中切れ・長さ宣言超過等) で `IncompleteDataError` を throw する (`src/varint.ts` の `decodeVarint` / `decodeVarintWithLength`、`src/message/parameter.ts` の各デコーダ)。
- `namespaceStartStreamLoop` (NAMESPACE / NAMESPACE_DONE ループ) の catch (`namespaceLoops.ts` の `toProtocolViolationSessionError` 呼び出し) は `ProtocolViolationError` のみ `SessionError (PROTOCOL_VIOLATION)` に変換し、`IncompleteDataError` は変換されず黙殺される。セッションは閉じず、subscription の error コールバック / reject のみが実行される。
- `namespaceStartTracksStreamLoop` (SUBSCRIBE_TRACKS ループ、PUBLISH_SKIPPED を処理) も同様の構造で、同じ問題を持つ。
- 対照的に `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` はデコード失敗を関数内で catch して PROTOCOL_VIOLATION でセッションを閉じる方式を採用済み (closed issue 0373 由来)。`bidiReadRequestStreamMessages` 側の同種問題は issue 0409 で対応中であり、本 issue のスコープ外。
- 影響: ピアが不正な Length 付きメッセージ (Body 短縮) を namespace / tracks ストリームに送ると、受信ループが静かに終了し、セッションは PROTOCOL_VIOLATION で閉じられない。draft-19 §10 の MUST 違反。

## 設計方針

- `IncompleteDataError` も `ProtocolViolationError` と同様に PROTOCOL_VIOLATION の SessionError に変換してセッションを閉じる。
- 対応方式は実装時に確定する:
  - (a) `src/session/errors.ts` の `toProtocolViolationSessionError` で `IncompleteDataError` も PROTOCOL_VIOLATION に変換する (bidi 側に波及するため影響範囲の検討が必要。0409 の (b) 方式と整合させること)
  - (b) 各ループの catch で `IncompleteDataError` を明示的に処理する (namespace ループに限定できる)
- いずれも `toProtocolViolationSessionError` の既存テスト (`src/session/errors.test.ts`) を更新し、`IncompleteDataError` 変換のテストを追加する。
- 正常なストリーム終了 (FIN / RESET_STREAM / セッションクローズ起因の read 失敗) を PROTOCOL_VIOLATION に誤変換しないこと。`IncompleteDataError` はデコード失敗のみを表すため、`isSessionClosedError` 等の既存判定との整合を確認する。
- 他のメッセージのデコード失敗 (bidi 側) は issue 0409 に委譲する。

## 完了条件

- namespace / tracks ストリームで Body 短縮のメッセージを受信した場合、黙殺されず PROTOCOL_VIOLATION でセッションが閉じること。
- 上記を検証するテストがあること (namespace ループを駆動し、実ストリーム注入方式で短縮ペイロードを feed する)。
- 正常な NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED の既存処理が変わらないこと (回帰ガード)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

未着手。
