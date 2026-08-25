# namespace / tracks / publish namespace ストリーム上の制御メッセージのデコード失敗が黙殺されセッションが閉じない

- Priority: Medium
- Created: 2026-08-13
- Completed: 2026-08-25
- Branch: feature/fix-namespace-stream-decode-failure-session-close
- Polished: 2026-08-20
- Updated: 2026-08-15

## 目的

`src/session/namespaceLoops.ts` の `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` で、Body 短縮等によるデコード失敗 (`IncompleteDataError`) が外側 catch で黙殺され、セッションが開いたままになる問題を修正する。draft-ietf-moq-transport-19 §10 の MUST「If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.」の短縮方向を満たす（Length が揃った後のフィールド構造破損を PROTOCOL_VIOLATION として扱う解釈は 0378 / 0409 で確立済みのリポジトリ共通解釈）。

## 現状

- 制御メッセージのデコーダは、フィールド構造のデータ不足 (varint 途中切れ等) で `IncompleteDataError` を throw する (`src/varint.ts` の `decodeVarint`、`src/message/parameter.ts` の各デコーダ)。Body 長不一致の余剰方向 (trailing data) は closed issue 0378 で `ProtocolViolationError` として処理済み（0378 の対象デコーダ限り。REQUEST_OK / SUBSCRIBE_OK / FETCH_OK / PUBLISH / SETUP は 0378 の検証不能デコーダとして対象外であり、REQUEST_OK の trailing data は現状未検出のまま黙殺される）、長さ宣言超過は `ControlStreamReader` が Length 分のバイトを揃えるまで待機する。したがって黙殺され得るのは、Length が揃った後のフィールド構造のデータ不足による `IncompleteDataError` のみである (length-prefixed パラメータの値スライス短縮が無エラー受理される別経路 (0378 の対象外デコーダ限定)、および Length 宣言超過のままピアが FIN する経路 (`ControlStreamReader` が待機し続け done で自然終了) は `IncompleteDataError` を経由しないため本 issue の対象外。完了条件は `IncompleteDataError` 経路のみを対象とする)。
- `namespaceStartNamespaceStreamLoop` (NAMESPACE / NAMESPACE_DONE ループ) の catch (`namespaceLoops.ts` の `toProtocolViolationSessionError` 呼び出し) は `ProtocolViolationError` のみ `SessionError (PROTOCOL_VIOLATION)` に変換し、`IncompleteDataError` は変換されず黙殺される。セッションは閉じず、subscription の error コールバック / reject のみが実行される。
- `namespaceStartTracksStreamLoop` (SUBSCRIBE_TRACKS ループ、PUBLISH_SKIPPED を処理) も同様の構造で、同じ問題を持つ。
- `namespaceStartPublicationStreamLoop` (PUBLISH_NAMESPACE 応答ループ) も同一構造であり、同じ問題を持つ。3 ループすべて本 issue の対象とする。
- 対照的に `src/session/bidi.ts` の `bidiHandlePublishRequestUpdate` はデコード失敗を関数内で catch して PROTOCOL_VIOLATION でセッションを閉じる方式を採用済み (closed issue 0373 由来)。`bidiReadRequestStreamMessages` 側の同種問題は issue 0409 で対応中であり、本 issue のスコープ外。
- 影響: ピアが不正な Length 付きメッセージ (Body 短縮) を namespace / tracks / publish namespace ストリームに送ると、受信ループが終了し、セッションは PROTOCOL_VIOLATION で閉じられない。draft-19 §10 の MUST 違反。

## 設計方針

- `IncompleteDataError` も `ProtocolViolationError` と同様に PROTOCOL_VIOLATION の SessionError に変換してセッションを閉じる。
- 対応方式は実装時に確定する:
  - (a) `src/session/errors.ts` の `toProtocolViolationSessionError` で `IncompleteDataError` も PROTOCOL_VIOLATION に変換する。この場合、`toProtocolViolationSessionError` の全呼び出し箇所 (bidi.ts 5 箇所 / namespaceLoops.ts 3 箇所 / session.ts 5 箇所 / incoming.ts の `handleIncomingDatagram`) に波及するため、影響範囲の検討が必要。特に `IncompleteDataError` が「データ不足 = 次チャンク待ち」の通常シグナルとして使われる箇所 (stream.ts の `processFetchObjects` / `processSubgroupObjects` 内、session.ts の該当 catch) では、`instanceof IncompleteDataError` が変換より先にチェックされていることを確認すること (現行は変換より先にチェックされていることを検証済み)。0409 の方式 (b) と同一の変更であり、0409 側と整合させること。方式 (a) では不正 datagram (varint 途中切れ) で現在は黙殺される挙動がセッション切断に変わる (incoming.ts の `handleIncomingDatagram` 経路) ことに注意。あわせて session.ts の `handleGoaway` / `runPublishStreamSubLoop` / PUBLISH 先頭デコード (`handleIncomingBidirectionalStream`) でも現在は黙殺される `IncompleteDataError` がセッション切断に変わる。方式 (a) を選ぶ場合、これらの挙動変化の検証をテストまたは完了条件に含めること。
  - (b) 各ループの catch で `IncompleteDataError` を明示的に処理する (3 ループに限定できる)。方式 (b) を選んだ場合、bidi 系の確立前応答読み取り (`bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse`) のデコード失敗 (IncompleteDataError) は 0409 のスコープ外 (0409 は REQUEST_UPDATE のみ) かつ 0415 の方式 (b) でも解決されないため、残余として残る点を許容する (方式 (a) を選べば自動解決される)。
- いずれの方式でも、`toProtocolViolationSessionError` の既存テスト (`src/session/errors.test.ts`) を更新する (方式 (a) では `IncompleteDataError` 変換のテストを errors.test.ts に追加。方式 (b) では errors.test.ts の更新は不要であり、namespaceLoops.test.ts 側に `IncompleteDataError` 変換のテストを追加する)。
- 正常なストリーム終了 (FIN / RESET_STREAM / セッションクローズ起因の read 失敗) を PROTOCOL_VIOLATION に誤変換しないこと。`IncompleteDataError` はデコード失敗のみを表す (throw 箇所は `decodeVarint` (`src/varint.ts`) と `decodeFetchObjectFields` (`src/dataStream.ts`) のデコード処理) ため、read 失敗経路では発生せず、`isSessionClosedError` 等の既存判定との整合を確認する。
- 他のメッセージのデコード失敗 (bidi 側) は issue 0409 に委譲する。
- 実装順序: 0409 との方式 (a)/(b) が同一の変更になり得るため、0409 側の明記 (先に実装した側が `toProtocolViolationSessionError` と `CHANGES.md` の `[FIX]` エントリを担い、後発側は完了条件の整合を確認する) に合わせて、本 issue 側でも重複コミットを避ける整合を行う。
- 変更対象ファイル: `src/session/namespaceLoops.ts` (3 ループの catch。方式 (a) の場合は `src/session/errors.ts` も対象)、`src/session/errors.test.ts` / `src/session/namespaceLoops.test.ts` (テスト更新・追加)、`CHANGES.md`。同一関数・同一テストファイルを変更対象とする open issue 0407 / 0408 (GOAWAY ケース) と 0414 (方式 (b) の場合の for ループ冒頭 state ガード) と実装順序に注意する。

## 完了条件

- namespace / tracks / publish namespace ストリームで、Length が揃った後のフィールド構造破損 (`IncompleteDataError`) を伴うメッセージを受信した場合、黙殺されず PROTOCOL_VIOLATION でセッションが閉じること (length-prefixed 値スライス短縮の無エラー受理経路、Length 宣言超過 FIN 経路は対象外)。
- 上記を検証するテストがあること (3 ループを駆動し、実ストリーム注入方式で短縮ペイロードを feed する。なおテスト基盤 `createNamespaceLoopTestContext` は namespace / tracks の 2 種のみ対応のため、`namespaceStartPublicationStreamLoop` の検証には kind: "publication" の基盤拡張または新規テストが必要)。
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

3 ループの本体修正は issue 0409 で実施済み。0409 は対応方式 (b) (4415 側の方式 (a)) として `toProtocolViolationSessionError` (`src/session/errors.ts`) に `IncompleteDataError` の PROTOCOL_VIOLATION 変換を追加しており、`namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` / `namespaceStartPublicationStreamLoop` の外側 catch (いずれも `toProtocolViolationSessionError` 経由) は自動的に IncompleteDataError でセッションを閉じる。本 issue ではその完了条件確認と回帰ガードとして以下を実施した。

- `src/session/namespaceLoops.test.ts`: 3 ループに破損 REQUEST_OK (Number of Parameters=1 宣言のみの短縮ペイロード) を feed し、黙殺されず PROTOCOL_VIOLATION でセッションが閉じることを検証するテストを追加 (実 W3C ストリーム注入方式)。あわせて正常な NAMESPACE / NAMESPACE_DONE / PUBLISH_SKIPPED / REQUEST_OK でセッションが閉じない回帰ガード、および対応する NAMESPACE に先立つ NAMESPACE_DONE の PROTOCOL_VIOLATION テストを追加。
- `namespaceStartPublicationStreamLoop` はテスト基盤 (`createNamespaceLoopTestContext` が kind: "namespace" / "tracks" のみ対応) の制約があるため、`createPublicationLoopTestContext` を新設した。
- `CHANGES.md` は 0409 の `[FIX]` エントリ (「受信メッセージのデコード失敗でセッションが閉じないのを修正する」) が namespace 系 3 ループを含むため、重複エントリを追加しない。
