# 確立前の namespace / tracks ストリームで GOAWAY が先頭メッセージだと PROTOCOL_VIOLATION になる

- Created: 2026-08-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-initial-goaway-on-namespace-stream
- Polished: 2026-08-16

## 目的

SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS ストリームの先頭メッセージとして GOAWAY が到着した場合に、PROTOCOL_VIOLATION でセッションを閉じるのではなく、GOAWAY 処理 (マイグレーション通知 + リクエストの失敗扱い) を行う。本 issue での「GOAWAY 処理」は、resolved=false の場合は `callbacks.goaway` 通知 → Promise の reject → 受信方向の cancel → ループ終了を指す。

## 現状

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` (src/session/namespaceLoops.ts) の先頭メッセージガードは、REQUEST_OK / REQUEST_ERROR 以外のメッセージを PROTOCOL_VIOLATION でセッションを閉じる。
- draft-ietf-moq-transport-19 §10.4 は「A GOAWAY MAY also be sent on a request stream to initiate migration of that individual request.」と定めており、リクエストストリーム上の GOAWAY は確立前後を区別せず許可している。さらに同節の「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream」は REQUEST_OK 受信前後の区別なく適用される。
- つまり、マイグレーション目的の正当な GOAWAY が REQUEST_OK 前に届いた場合、セッション全体が閉じる。PUBLISH_NAMESPACE ループ (namespaceStartPublicationStreamLoop) は resolved=false の GOAWAY を reject + cancel で処理しており、3 ループ間で挙動が不整合。
- 0372 のエッジケース (i) で「先頭ガードが GOAWAY を PROTOCOL_VIOLATION にする既存挙動は本 issue の変更では解消されず、スコープ外の残余リスク」と明記されており、本 issue はその残余リスクの解消。

## 設計方針

- 先頭メッセージガードで GOAWAY を許可し、GOAWAY ケースへ流す。
- GOAWAY ケースには resolved=false の分岐を追加する (namespaceStartPublicationStreamLoop の既存実装と同構造)。resolved=false のときは `namespaceHandleGoaway` による callbacks.goaway 通知 → Promise の reject (`Error("request stream goaway: <uri>")`) → 受信方向の `streamReader.cancel()` → ループ終了とする。reject 後に読み取りを継続しないのは、reject 済みリクエストに後続の REQUEST_OK 等が発火して矛盾した通知が発生するのを防ぐためである。
- resolved=true 側の挙動 (goawayReceived フラグ + 読み取り継続、0372 の実装) は既に実装済みであり変更しない。新規実装は「先頭ガードの GOAWAY 許可」と「2 ループの GOAWAY ケースへの resolved=false 分岐追加」のみ。
- 先頭メッセージガードのエラーメッセージ ("expected REQUEST_OK or REQUEST_ERROR as first message ...") は、GOAWAY 許可後に実際に許されるメッセージ (REQUEST_OK / REQUEST_ERROR / GOAWAY) と整合する文言に更新する (ガードに引っかかった際のログが実態と乖離しないようにするため)。
- 先頭 GOAWAY 受信時は reject + cancel + return でループが即終了するため、その後に届く 2 通目 GOAWAY は検出されない。これは §10.4 の MUST「The endpoint MUST close the session with a PROTOCOL_VIOLATION ... if it receives more than one GOAWAY on ... a single request stream」の確立前経路における未達として許容する (0372 が確立前経路の検出不可能性を残余リスクとして明記したのと同じ扱い)。
- 関連: 本 issue の設計 (resolved=false の GOAWAY は reject + cancel) により、open issue 0413 の対象経路 (resolved=false かつ goawayReceived 後の read 例外) は発生しなくなるため、0413 の要否再評価を促す。また 0408 (GOAWAY 受信後の送信方向 FIN) は resolved=true を対象としており、本 issue の resolved=false 分岐と同一 switch ケースに触れるため実装順序に注意する。
- 変更対象ファイル: `src/session/namespaceLoops.ts` (先頭メッセージガード + 2 ループの GOAWAY ケース)、`src/session/namespaceLoops.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS ストリームの先頭に GOAWAY が来てもセッションが閉じず、Promise が reject され受信方向が cancel されること (resolved=false の場合)。
- resolved=true の GOAWAY は従来どおり goawayReceived フラグ + 読み取り継続で処理されること。
- 上記を検証するテストがあること (namespaceLoops.test.ts の既存 GOAWAY テスト基盤を使用)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY)。「A GOAWAY MAY also be sent on a request stream to initiate migration of that individual request.」「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream」
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（重複 GOAWAY 検出。エッジケース (i) で本 issue の対象を残余リスクとして明記）
- 関連: `issues/0408-fix-namespace-goaway-send-direction-close.md`（GOAWAY 受信後の送信方向 FIN。resolved=true が対象。同一 switch ケースに触れるため実装順序に注意）
- 関連: `issues/0413-bug-goaway-subscribe-hang.md`（GOAWAY 受信後の read 例外。本 issue の設計により対象経路が消滅するため、実装後に要否再評価）

## 解決方法

未着手。
