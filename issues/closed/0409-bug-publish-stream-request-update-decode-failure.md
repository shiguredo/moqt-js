# 自発 PUBLISH ストリーム上の REQUEST_UPDATE のデコード失敗が黙殺されセッションが閉じない

- Created: 2026-08-11
- Completed: 2026-08-25
- Branch: feature/fix-publish-stream-request-update-decode-failure
- Polished: 2026-08-20
- Updated: 2026-08-15

## 目的

`bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の role=publish パスで、破損した REQUEST_UPDATE (不完全なフィールド構造のペイロード等) を受信すると、デコード失敗 (`IncompleteDataError`) が外側 catch で黙殺され、セッションが PROTOCOL_VIOLATION で閉じない問題を修正する。同種の問題は受信 PUBLISH パスで closed issue 0373 が解決済みであり、既存ハンドラにのみ非対称に残っている。なお本 issue のタイトルにある「自発 PUBLISH ストリーム」とは、クライアント自身が発行した PUBLISH (role=publish) のリクエストストリームを指す。

## 現状

- `bidiReadRequestStreamMessages` の REQUEST_UPDATE ケース内で `decodeRequestUpdatePayload` が try/catch なしで呼ばれる。
- 同関数の外側 catch は `toProtocolViolationSessionError` (ProtocolViolationError のみ PROTOCOL_VIOLATION の SessionError に変換) のみを処理し、`IncompleteDataError` は無視する (「それ以外は既存通り無視する」コメント)。
- なお closed issue 0378 実装により、Body 長不一致 (trailing data) は `ProtocolViolationError` として処理され外側 catch で変換されるため、黙殺されるのは不完全なフィールド構造 (データ不足) による `IncompleteDataError` のみである。Length 宣言超過のままピアが FIN する経路は `ControlStreamReader` が Length 分を待機し続けた後に未完了メッセージを破棄するため `IncompleteDataError` を経由せず、本 issue の対象外 (0415 と同様の境界)。
- したがって破損 REQUEST_UPDATE を受信すると、ループが終了し、finally で requestStreams のエントリが削除される。publish ロールの実害は (a) アプリの `publisher.done()` が `publishSendPublishDone` で streamInfo を引けず PUBLISH_DONE を送信不能になる (§10.11 の MUST「A sender MUST NOT destroy subscription state until it sends PUBLISH_DONE」に抵触)、(b) 後続の REQUEST_UPDATE / GOAWAY / FIN が処理されない。セッションは開いたまま。
- closed issue 0373 の新設 free function `bidiHandlePublishRequestUpdate` は、デコード失敗を関数内で catch して PROTOCOL_VIOLATION でセッションを閉じる方式を採用済み (ループ catch が IncompleteDataError を変換しないため)。`bidiReadRequestStreamMessages` 側は未対応のまま。

## 設計方針

- 0373 と同じ理由 (ループ catch は ProtocolViolationError のみ変換する) により、デコード失敗は黙殺せず PROTOCOL_VIOLATION でセッションを閉じる。根拠は 0373 が確立した解釈 (Length が揃った後のメッセージ構造の破損はプロトコル違反であり PROTOCOL_VIOLATION で閉じる。draft-ietf-moq-transport-19 §10 の MUST「If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.」の Body 長一致後のフィールド構造破損への適用は 0373 / 0415 でも採用済み)。
- 対応方式は実装時に確定する: (a) REQUEST_UPDATE ケース内で `decodeRequestUpdatePayload` のデコード失敗を catch して `closeWithError(PROTOCOL_VIOLATION)` する (0373 の `bidiHandlePublishRequestUpdate` と同方式)、(b) 外側 catch で `IncompleteDataError` も PROTOCOL_VIOLATION に変換する。方式 (b) は open issue 0415 (namespace ループ側) の方式 (a) と同一の変更であり、`toProtocolViolationSessionError` の全呼び出し箇所 (bidi.ts 5 箇所 / namespaceLoops.ts 3 箇所 / session.ts 5 箇所 / incoming.ts の `handleIncomingDatagram`) に波及するため、影響範囲の検討が必要 (特に `IncompleteDataError` を「データ不足 = 次チャンク待ち」の通常シグナルとして使う箇所 (stream.ts の `processFetchObjects` / `processSubgroupObjects` 内) では `instanceof IncompleteDataError` が変換より先にチェックされていること、不正 datagram (varint 途中切れ) で黙殺される挙動がセッション切断に変わること (incoming.ts の `handleIncomingDatagram` 経路) に注意)。0415 が方式 (a) を実装した場合は bidi 側も自動解決される (逆に本 issue が方式 (b) を先に実装すれば 0415 の namespace 側も自動解決される)。実装時は 0415 との整合を確認する。なお方式 (a) を選んだ場合、同一ループ内の REQUEST_ERROR デコード (`decodeRequestErrorPayload`) と GOAWAY デコード (`decodeGoawayPayload`) の失敗は引き続き黙殺される (方式選択の判断材料)。
- 0373 の `bidiHandlePublishRequestUpdate` (受信 PUBLISH パス) は変更しない。
- REQUEST_UPDATE の Request ID のパリティ・重複検証は本 issue のスコープ外 (closed issue 0381 の注記によりスコープ外と確定済み。適用する場合は別 issue の対応)。
- 実装順序: 0416 (同一分岐の FORWARD 反映修正) より先に本 issue (0409) を実装する。逆順だと完了条件の回帰ガード「正常な REQUEST_UPDATE の既存処理 (FORWARD 反映) が変わらないこと」が 0416 の変更で破れるため。0415 とは方式 (b) / 方式 (a) が同一の変更になるため、先に実装した側が `toProtocolViolationSessionError` と `CHANGES.md` の `[FIX]` エントリを担い、後発側は完了条件の整合 (重複コミット回避) を確認する。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の role=publish REQUEST_UPDATE ケース。方式 (b) の場合は `src/session/errors.ts` の `toProtocolViolationSessionError` と `src/session/errors.test.ts` も対象)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- role=publish パスで破損 REQUEST_UPDATE (不完全なフィールド構造、`IncompleteDataError` を伴うデコード失敗) を受信した場合、黙殺されず PROTOCOL_VIOLATION でセッションが閉じること (Length 宣言超過のまま FIN する経路は対象外)。
- 上記を検証するテストがあること (テストは `bidiReadRequestStreamMessages` を role=publish で駆動し、実 W3C ストリーム注入方式で破損ペイロードを feed する)。
- 正常な REQUEST_UPDATE の既存処理 (FORWARD 反映 + REQUEST_OK 応答) が変わらないこと (回帰ガード。0416 を先に実装した場合は FORWARD 反映が変更済みである点を考慮する。回帰ガードのテストは bidi.test.ts に既存の role=publish REQUEST_UPDATE テストで担保し、必要に応じて FORWARD 反映のアサーションを追加する)。
- `CHANGES.md` の `## develop` に `[FIX]` があること (0415 と方式が重なる場合は重複エントリにしない)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10 (Control Messages / Message Length の MUST)
- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE)
- 関連: `issues/closed/0373-moqt-draft-19-request-update-on-publish-stream-misdetected.md`（受信 PUBLISH パスのデコード失敗処理。`bidiHandlePublishRequestUpdate` の方式）
- 関連: `issues/closed/0378-moqt-draft-19-message-body-length-validation.md`（Body 長不一致の検証）
- 関連: `issues/0415-bug-namespace-stream-decode-failure-session-close.md`（namespace 側の同種問題。方式 (b) が同一の変更になるため整合に注意）
- 関連: `issues/0416-bug-publish-forward-omitted-overwrite.md`（同一分岐の FORWARD 反映を変更対象とする open issue）

## 解決方法

対応方式 (b) を採用し、`toProtocolViolationSessionError` (`src/session/errors.ts`) が `IncompleteDataError` も PROTOCOL_VIOLATION の SessionError に変換するようにした。これにより Length が揃った後のメッセージ構造の破損は、全受信経路 (bidi 系ループ・namespace 系ループ・受信応答読み取り・datagram) で黙殺されずセッションが閉じる。data stream の「データ不足 = 次チャンク待ち」経路は `instanceof IncompleteDataError` が変換より先に処理されるため挙動は変わらない。

- `src/session/bidi.ts`: `bidiReadRequestStreamMessages` の role=publish REQUEST_UPDATE デコード失敗を「invalid REQUEST_UPDATE payload」の文脈を付与して閉じるローカル catch に変更。`bidiHandlePublishRequestUpdate` と同パターン。あわせて受信応答読み取り (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS) の 4 catch で、セッション閉鎖前に当該 pending へ具体エラーを reject する (既存の Range Filter 違反経路と同パターン)。
- `src/session/errors.ts` / `src/session/errors.test.ts`: 変換対象に IncompleteDataError を追加。ユニットテストを追加。
- `src/session/bidi.test.ts`: 破損 REQUEST_UPDATE (publish ロール) で PROTOCOL_VIOLATION になるテスト、正常 REQUEST_UPDATE で FORWARD 反映 + REQUEST_OK の回帰ガードテスト、破損 PUBLISH_OK で pending に具体エラーが渡るテストを追加。
- `src/session/incoming.test.ts`: 破損 datagram で PROTOCOL_VIOLATION になるテストを追加。
- 帰結的修正として、陳腐化したコメント (`src/session/bidi.ts` / `src/session/incoming.ts` / `src/message/parameter.ts`) と `CHANGES.md` の [FIX] エントリを更新。

0415 (namespace 系ループ) は本変更により自動解決されるため、0415 の完了条件確認時に重複コミットしないこと。
