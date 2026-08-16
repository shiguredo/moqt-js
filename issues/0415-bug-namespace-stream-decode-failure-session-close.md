# namespace / tracks / publish namespace ストリーム上の制御メッセージのデコード失敗が黙殺されセッションが閉じない

- Priority: Medium
- Created: 2026-08-13
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-namespace-stream-decode-failure-session-close
- Polished: 2026-08-16
- Updated: 2026-08-15

## 目的

`src/session/namespaceLoops.ts` の `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` で、Body 短縮等によるデコード失敗 (`IncompleteDataError`) が外側 catch で黙殺され、セッションが開いたままになる問題を修正する。draft-ietf-moq-transport-19 §10 の MUST「If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.」の短縮方向を満たす。

## 現状

- 制御メッセージのデコーダは、フィールド構造のデータ不足 (varint 途中切れ等) で `IncompleteDataError` を throw する (`src/varint.ts` の `decodeVarint`、`src/message/parameter.ts` の各デコーダ)。Body 長不一致の余剰方向 (trailing data) は closed issue 0378 で `ProtocolViolationError` として処理済みであり、長さ宣言超過は `ControlStreamReader` が Length 分のバイトを揃えるまで待機する。したがって黙殺され得るのは、Length が揃った後のフィールド構造のデータ不足による `IncompleteDataError` のみである (length-prefixed パラメータの値スライス短縮が無エラー受理される別経路、および Length 宣言超過のままピアが FIN する経路 (`ControlStreamReader` が待機し続け done で自然終了) は `IncompleteDataError` を経由しないため本 issue の対象外。完了条件は `IncompleteDataError` 経路のみを対象とする)。
- `namespaceStartNamespaceStreamLoop` (NAMESPACE / NAMESPACE_DONE ループ) の catch (`namespaceLoops.ts` の `toProtocolViolationSessionError` 呼び出し) は `ProtocolViolationError` のみ `SessionError (PROTOCOL_VIOLATION)` に変換し、`IncompleteDataError` は変換されず黙殺される。セッションは閉じず、subscription の error コールバック / reject のみが実行される。
- `namespaceStartTracksStreamLoop` (SUBSCRIBE_TRACKS ループ、PUBLISH_SKIPPED を処理) も同様の構造で、同じ問題を持つ。
- `namespaceStartPublicationStreamLoop` (PUBLISH_NAMESPACE 応答ループ) も同一構造であり、同じ問題を持つ。3 ループすべて本 issue の対象とする。
- 対照的に `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` はデコード失敗を関数内で catch して PROTOCOL_VIOLATION でセッションを閉じる方式を採用済み (closed issue 0373 由来)。`bidiReadRequestStreamMessages` 側の同種問題は issue 0409 で対応中であり、本 issue のスコープ外。
- 影響: ピアが不正な Length 付きメッセージ (Body 短縮) を namespace / tracks / publish namespace ストリームに送ると、受信ループが終了し、セッションは PROTOCOL_VIOLATION で閉じられない。draft-19 §10 の MUST 違反。

## 設計方針

- `IncompleteDataError` も `ProtocolViolationError` と同様に PROTOCOL_VIOLATION の SessionError に変換してセッションを閉じる。
- 対応方式は実装時に確定する:
  - (a) `src/session/errors.ts` の `toProtocolViolationSessionError` で `IncompleteDataError` も PROTOCOL_VIOLATION に変換する。この場合、`toProtocolViolationSessionError` の全呼び出し箇所 (bidi.ts 5 箇所 / namespaceLoops.ts 3 箇所 / session.ts 5 箇所 / incoming.ts の `handleIncomingDatagram`) に波及するため、影響範囲の検討が必要。特に `IncompleteDataError` が「データ不足 = 次チャンク待ち」の通常シグナルとして使われる箇所 (stream.ts の `processFetchObjects` / `processSubgroupObjects` 内、session.ts の該当 catch) では、`instanceof IncompleteDataError` が変換より先にチェックされていることを確認すること。0409 の方式 (b) と同一の変更であり、0409 側と整合させること。方式 (a) では不正 datagram (varint 途中切れ) で現在は黙殺される挙動がセッション切断に変わる (incoming.ts の `handleIncomingDatagram` 経路) ことに注意
  - (b) 各ループの catch で `IncompleteDataError` を明示的に処理する (3 ループに限定できる)
- いずれの方式でも、`toProtocolViolationSessionError` の既存テスト (`src/session/errors.test.ts`) を更新し、`IncompleteDataError` 変換のテストを追加する (方式 (b) の場合は namespaceLoops.test.ts 側にテストを追加する)。
- 正常なストリーム終了 (FIN / RESET_STREAM / セッションクローズ起因の read 失敗) を PROTOCOL_VIOLATION に誤変換しないこと。`IncompleteDataError` はデコード失敗のみを表す (throw 箇所は `decodeVarint` のみ) ため、read 失敗経路では発生せず、`isSessionClosedError` 等の既存判定との整合を確認する。
- 他のメッセージのデコード失敗 (bidi 側) は issue 0409 に委譲する。
- 変更対象ファイル: `src/session/namespaceLoops.ts` (3 ループの catch。方式 (a) の場合は `src/session/errors.ts` も対象)、`src/session/errors.test.ts` / `src/session/namespaceLoops.test.ts` (テスト更新・追加)、`CHANGES.md`。同一関数・同一テストファイルを変更対象とする open issue 0407 / 0408 (GOAWAY ケース) と 0414 (方式 (b) の場合の catch 経路) と実装順序に注意する。

## 完了条件

- namespace / tracks / publish namespace ストリームで Body 短縮のメッセージを受信した場合、黙殺されず PROTOCOL_VIOLATION でセッションが閉じること。
- 上記を検証するテストがあること (3 ループを駆動し、実ストリーム注入方式で短縮ペイロードを feed する)。
- 正常な NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED / REQUEST_OK / REQUEST_ERROR / GOAWAY の既存処理が変わらないこと (回帰ガード)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10 (Control Messages / Message Length の MUST)
- 関連: `issues/closed/0378-moqt-draft-19-message-body-length-validation.md`（余剰方向の Body 長検証。短縮方向は本 issue の対象として先送りされた）
- 関連: `issues/0409-bug-publish-stream-request-update-decode-failure.md`（bidi 側の同種問題。方式 (a) が 0409 の方式 (b) と同一の変更になるため整合に注意）
- 関連: `issues/0410-bug-subscribe-error-end-not-notified.md`（subscribe ロールのエラー終了通知。方式 (a) は外側 catch の変換結果に影響するため整合に注意）
- 関連: `issues/0407-fix-initial-goaway-on-namespace-stream.md` / `issues/0408-fix-namespace-goaway-send-direction-close.md`（同一関数・同一テストファイルの GOAWAY ケースを変更対象とするため実装順序に注意）
- 関連: `issues/0414-bug-unsubscribe-pending-update-cleanup.md`（方式 (b) を選んだ場合、外側 catch 経路を同一箇所で変更するため整合に注意）

## 解決方法

未着手。
