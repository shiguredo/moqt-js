# FETCH 応答の同一 Subgroup Priority 不一致を FETCH キャンセルで処理する

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-fetch-priority-mismatch-cancel
- Polished: 2026-08-16

## 目的

draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks) の扱いに従い、FETCH 応答で同一 Subgroup 内の Publisher Priority 不一致を検出した場合に、セッションを閉じず対象の FETCH をキャンセルして error コールバックで通知する。現在は ProtocolViolationError (セッション終了) を送出する。

## 優先度根拠

§2.4.2 は「An Object with a particular Subgroup ID is received, but its Publisher Priority is different from that of the previous Object with the same Subgroup ID」を malformed track と定義し、正しい対処は「cancel any corresponding subscription or fetches for that Track from that publisher」でありセッション終了ではない。さらに同節は「SHOULD deliver an error to the application」と定める。Low: 発生は不正な publisher に限られ、正常な運用では起きないため。

## 現状

- `src/dataStream.ts` の `decodeFetchObjectFields` は同一 Subgroup の Priority 不一致を検出し、コメントでは「MALFORMED_TRACK エラー」と書いているが、実際には `ProtocolViolationError` を throw する。
- セッション終了ではなく、対応する FETCH のキャンセルが §2.4.2 の正しい扱い。
- なお、`MalformedTrackError` は既に `src/properties.ts` の `decodeProperties` 系 (8 箇所) で throw され、`SessionImpl.handleIncomingStream` (`src/session.ts`) の catch に「セッションを閉じず `cancelStreamQuiet` により受信ストリームを打ち切る」分岐が用意済みである。ただしこの分岐に到達する throw 元は現状存在せず、本 issue の修正で `decodeFetchObjectFields` が `MalformedTrackError` を throw して初めて接続される。
- 検出条件 (`subgroupId === context.subgroupId`) は Group ID を比較しない。draft-19 §2.2 は「The scope of a Subgroup ID is a Group」と定めるため、異なる Group の同一 Subgroup ID は無関係であり、Priority が異なっても合法。Group 跨ぎの FETCH 応答を誤検出しないよう、検出条件は Group スコープで比較する必要がある。

## 設計方針

- Priority 不一致の検出は維持しつつ、throw するエラーをセッション終了を引き起こさない形 (対象 FETCH のキャンセル経路) に変更する。なお前オブジェクトが Datagram の場合に `newContext.publisherPriority` が Datagram の値で更新されるため、Datagram 直後の同一 Subgroup オブジェクトが誤検出され得る既存挙動がある (Group スコープ比較とは独立)。本 issue ではこの誤検出要因の修正は行わず、Datagram 混在ケースの扱いは実装時に判断してテストで固定する。
- デコード側は `MalformedTrackError` を throw し、既存の `handleIncomingStream` の catch 経路 (`cancelStreamQuiet` による受信ストリームの STOP_SENDING 相当) に乗せる。エラーメッセージは既存テスト (`src/dataStream.fetch.test.ts` の「FetchObjectFields: 同一 Subgroup で異なる Priority はエラー」) が正規表現で検証しているため、先頭部分 (`malformed track: different priorities in same subgroup`) を維持する。
- 検出条件は同一 Group・同一 Subgroup に限定し、Group 跨ぎ (異なる Group の同一 Subgroup ID) では不一致と判定しない。
- §2.4.2 の「fetches for that Track」は複数形だが、FETCH ごとにデータストリームと検出が独立するため、対象は該当 requestId の FETCH のみとする (同一 Track の他 FETCH には波及しない)。なお Joining Fetch は `requestStreams` にエントリを持たないため、設計方針 (c) の `bidiCancelFetch` は STOP_SENDING を送らず `fetchers` Map の削除のみになる。Joining Fetch のデータストリームで検出した場合の STOP_SENDING 送信要否は実装時に判断し、テストで固定する。
- キャンセル処理は `SessionImpl.handleIncomingStream` の catch 経路に追加し、(a) 受信データストリームの `cancelStreamQuiet`、(b) fetcher の error コールバック通知 (`FetcherImpl.handleError`)、(c) 既存の `FetcherImpl.cancel()` 経路 (`bidiCancelFetch`) による bidi リクエストストリームへの STOP_SENDING と `fetchers` Map からの削除、を実施する。(c) は draft-ietf-moq-transport-19 §5.2 の MUST「It MUST send STOP_SENDING for the bidi request stream.」を満たすために必須である。
- 変更対象ファイル: `src/dataStream.ts` (`decodeFetchObjectFields` の throw 変更 + Group スコープ比較)、`src/session.ts` (`handleIncomingStream` の catch 経路拡張)、`src/dataStream.fetch.test.ts` / `src/session.test.ts` / 該当テスト (テスト更新・追加)、`CHANGES.md`。

## 完了条件

- FETCH 応答で同一 Group・同一 Subgroup の Priority 不一致を検出してもセッションが閉じず、対象 FETCH がキャンセルされ (受信データストリームの打ち切り + §5.2 の MUST に従う bidi リクエストストリームへの STOP_SENDING)、`fetchers` Map から削除され、error コールバックが呼ばれること。
- 異なる Group の同一 Subgroup ID で Priority が異なる場合は誤検出されず、正常に配信されること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.2 (Subgroup ID のスコープは Group 内)
- draft-ietf-moq-transport-19 §2.4.2 (Malformed Tracks)
- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection)
- draft-ietf-moq-transport-19 §5.2 (Fetch State Management / キャンセル時の STOP_SENDING)
- draft-ietf-moq-transport-19 §11.4.4 (Fetch Header / Fetch Object Fields)

## 解決方法

未着手。
