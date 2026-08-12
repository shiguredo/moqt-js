# 受信 Request ID のパリティ・重複検証が未実装

- Priority: Low
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-request-id-parity-validation
- Polished: 2026-08-12

## 目的

draft-ietf-moq-transport-19 §10.1 の「If an endpoint receives a Request ID where the least significant bit is incorrect for the sender, or a duplicate Request ID, it MUST close the session with INVALID_REQUEST_ID.」を満たす。§10.1 は採番規則として「The client generates even numbered Request IDs, starting at 0, and the server generates odd numbered Request IDs, starting at 1. Each endpoint increments its Request ID by 2 for each new request.」を定める。moqt-js は WebTransport 専用クライアントであり常に client ロールのため、受信 PUBLISH の Request ID はサーバー発の奇数が期待値となる。現在はクライアントが偶数 Request ID を生成するのみで、受信側のパリティ検証と重複検証がない。

## 優先度根拠

受信 PUBLISH の Request ID のパリティ・重複検証が未実装のため、§10.1 の MUST 違反を検出できない。また現状は同一 Request ID の受信 PUBLISH が来ると `subscribers` / `requestStreams` の Map エントリ (requestId キー) を黙って上書きし、旧ストリームのサブループ終了時に新エントリまで delete して新サブスクリプションを壊す実害がある。INVALID_REQUEST_ID (SessionErrorCode) は定義済みのため、検証の追加のみで対応できる。仕様 MUST 違反ではあるが、不正ワイヤの検出漏れはセッション切断で済むため実害は限定的。Low。

## 現状

- クライアントの送信側は `nextRequestId = 0n` から 2 ずつ増分 (`this.nextRequestId += 2n`。`src/session.ts` の全送信 API と `src/session/bidi.ts` の `bidiSendRequestUpdate` / `bidiSendJoiningFetch`) し、偶数 Request ID を生成する。
- 受信側 (`handleIncomingBidirectionalStream` (`src/session.ts`) の受信 PUBLISH 処理) に Request ID のパリティチェックがない。`decodePublishPayload` で `requestId` を取り出した後、`subscribers` / `requestStreams` Map に無条件で登録する (`subscribers.set` が既存エントリを上書きする)。
- 重複 Request ID の検証も受信パスにない。
- 受信 REQUEST_UPDATE も `bidiHandlePublishRequestUpdate` (`src/session/bidi.ts`) と `bidiReadRequestStreamMessages` の role=publish 分岐の 2 経路で `decodeRequestUpdatePayload` により Request ID を読み取るが、パリティ・重複検証は行わない (本 issue のスコープ外。下記参照)。
- 変更対象ファイル: `src/session.ts` (`handleIncomingBidirectionalStream` への検証配線、受信済み Request ID の Set)、`src/session/incoming.ts` (検証ロジックの free function 化)、`src/session/incoming.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- **検証対象**: 受信 PUBLISH (0371 の分類 1) のみに限定する。受信リクエスト 6 種 (SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) は 0371 によりペイロード非デコードのため検証は発火しない (§10.1 の MUST は未達のまま残る。残余リスク)。受信 REQUEST_UPDATE (2 経路) は本 issue のスコープ外とする (理由は下記注記)。
- **パリティ検証**: 受信 PUBLISH の `requestId` の LSB (`requestId & 1n`) が 1 (奇数) であることを検証し、偶数なら INVALID_REQUEST_ID でセッションを閉じる。検証は `decodePublishPayload` 成功直後に配置する (decode 失敗時 (MalformedTrackError による UNSUPPORTED_EXTENSION 応答等) はデコードエラーが先に適用され、Request ID 検証は発火しない)。配置は予約 namespace 拒否 / パラメータスコープ検証 / DUPLICATE_TRACK_ALIAS の各既存検証より前とする (§10.1 の MUST は受信即時閉鎖のため)。パリティ検証は Set を要しない。
- **重複検証**: 受信済み Request ID をセッション寿命で保持する `Set<bigint>` を新設し、受信 PUBLISH の `requestId` が既に Set に存在する場合は INVALID_REQUEST_ID でセッションを閉じる。Set への add はパリティ・重複検証と同じ同期ブロック内 (await を挟まない) で、検証の直後に行う (§10.1「Each SUBSCRIBE, PUBLISH, ..., message consumes a Request ID」により、後続の拒否経路 (予約 namespace 拒否 / UNINTERESTED 等) で return される PUBLISH も Request ID を消費するため、拒否された ID も Set に記録されなければ同一 ID の再送を検出できない。また受信 bidi ストリーム処理は fire-and-forget で並行実行されるため、検証と add の間に await を挟むと同一 ID の 2 本が同時に検証を通過し得る)。パリティ・重複検証と add は free function の責務に含め、テスト可能にする。Set には add のみ行い、リクエスト完了後も削除しない (§10.1 の重複禁止はセッション内での再出現の禁止であり、`subscribers` Map のエントリ削除後も検出できる必要がある)。ライフサイクルは `close()` 内の `goawayReceivedOnRequestStreams.clear()` 実行箇所 (`src/session.ts`) と同じく、セッションクローズ時にクリアする。
- **エラー表現**: `closeWithError(new SessionError(message, SessionErrorCode.INVALID_REQUEST_ID))` でセッションを閉じる (INVALID_REQUEST_ID は §3.5 (Termination) で定義される Session Termination Error Code であり、`src/error.ts` の `SessionErrorCode` に定義済み)。
- **テスト**: パリティ違反 (偶数の Request ID の受信 PUBLISH) と重複 (同一 Request ID の 2 回目の受信 PUBLISH) で INVALID_REQUEST_ID セッションクローズを検証するテストを追加する。検証ロジック (パリティ・重複検証と Set への add) は 0371 の先例に倣い `src/session/incoming.ts` の free function に抽出し、`src/session/incoming.test.ts` から直接呼んで検証する (add を含めることで「拒否経路で return される PUBLISH の ID が Set に記録され、同一 ID の再送が検出される」こともテスト可能になる)。`handleIncomingBidirectionalStream` は private メソッドのため、受信 PUBLISH 経路への配線はコードレビューで担保する。
- **残余リスク**: 受信 REQUEST_UPDATE の Request ID を Set に記録しないため、過去の REQUEST_UPDATE の Request ID と同一の Request ID を持つ PUBLISH (クロスタイプ重複) は検出されない (REQUEST_UPDATE はスコープ外のため)。

## 完了条件

- 受信 PUBLISH の Request ID の LSB が期待値 (奇数) と一致しない場合に INVALID_REQUEST_ID でセッションが閉じること。
- 受信済みの Request ID を持つ受信 PUBLISH を受信した場合に INVALID_REQUEST_ID でセッションが閉じること。
- 検証は受信 PUBLISH のみに適用され、受信リクエスト 6 種 (0371 でペイロード非デコード) と受信 REQUEST_UPDATE (スコープ外) では発火しないこと。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.1 (Request ID / 採番規則 / LSB 不一致・重複の MUST)
- draft-ietf-moq-transport-19 §3.5 (INVALID_REQUEST_ID の定義)
- 関連: `issues/closed/0371-moqt-draft-19-incoming-request-not-supported-response.md`（受信リクエスト 6 種のペイロード非デコード。検証対象を受信 PUBLISH のみに限定する根拠）
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（`goawayReceivedOnRequestStreams` の重複検出パターン。Set のライフサイクル先例）
- 関連: `issues/closed/0373-moqt-draft-19-request-update-on-publish-stream-misdetected.md`（ケース 1 REQUEST_UPDATE の Request ID 読み取り。本 issue で含めるか否かの確定を要求した元）
- 関連: `issues/0409-bug-publish-stream-request-update-decode-failure.md`（受信 REQUEST_UPDATE の Request ID 検証を本 issue に委譲。本 issue ではスコープ外とするため、0409 側の調整が必要）

## 注記 (0371 実装時)

- 0371 実装後の受信 bidi ストリームの 3 分類により、本 issue のパリティ・重複検証は受信 PUBLISH (分類 1) のみに適用される。分類 2 の 6 種 (SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) はペイロード非デコードのため §10.1 の MUST が未達のまま残る (残余リスク。本文の設計方針・完了条件に反映済み)。

## 注記 (0373 実装時)

- 受信 REQUEST_UPDATE (ケース 1 の `bidiHandlePublishRequestUpdate` と role=publish の `bidiReadRequestStreamMessages`) の Request ID は本 issue の検証対象に含めない。理由: §10.9 の REQUEST_UPDATE の Request ID の意味論 (§10.1 の「consumes a Request ID」の解釈。更新対象のリクエストの Request ID と同一の値が来た場合の扱い) が仕様で確定できず、重複検証の正しい設計が決まらないため。パリティ・重複検証を REQUEST_UPDATE に適用する場合は、Request ID の意味論の確定を前提とする別 issue の対応とする。0409 の設計方針が本 issue に委譲している旨の記述は、本 issue の実装時に 0409 の issue ファイルへ調整注記を追加して解消する。

## 解決方法

- `src/session/incoming.ts` に `incomingValidateRequestId` free function を追加した
  - パリティ検証: 受信 Request ID の LSB が 0 (偶数) の場合、INVALID_REQUEST_ID でセッションを閉じる (moqt-js はクライアントロールのため、受信 Request ID はサーバー発の奇数が期待値)
  - 重複検証: 受信済み Request ID の Set に存在する場合、INVALID_REQUEST_ID でセッションを閉じる
  - 検証と Set への add を同一の同期ブロックで行う (fire-and-forget の並行実行で同一 ID の 2 本が同時に検証を通過しないようにする)
  - Set には add のみ行い、リクエスト完了後も削除しない (セッション内での再出現の禁止のため)。セッションクローズ時にクリアする
- `src/session.ts` の `handleIncomingBidirectionalStream` で、受信 PUBLISH の `decodePublishPayload` 成功直後に `incomingValidateRequestId` を呼び出し、違反時は INVALID_REQUEST_ID でセッションを閉じる。配置は予約 namespace 拒否 / パラメータスコープ検証 / DUPLICATE_TRACK_ALIAS の各既存検証より前
- 受信済み Request ID の Set は `receivedRequestIds` private フィールドとして保持し、`close()` 内でクリアする
- `readFirstBidiMessage` private メソッドを抽出した (先頭メッセージ読み取りのロジックを `handleIncomingBidirectionalStream` から分離し、max-statements 制限に収める)
- 適用範囲は受信 PUBLISH のみ。受信リクエスト 6 種 (ペイロード非デコードのため検証は発火しない) と受信 REQUEST_UPDATE (スコープ外) では適用されない (残余リスク。issue 本文の注記参照)
- テスト: `src/session/incoming.test.ts` に 5 件 (偶数で INVALID_REQUEST_ID / 奇数は通過して Set に記録 / 重複で INVALID_REQUEST_ID / 検証通過後に add され再送が検出 / 異なる奇数は通過) を追加した
- `CHANGES.md` の `## develop` に `[FIX]` エントリを追加した
