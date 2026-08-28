# 確立前の namespace / tracks ストリームで GOAWAY が先頭メッセージだと PROTOCOL_VIOLATION になる

- Created: 2026-08-10
- Completed: 2026-08-28
- Branch: feature/fix-initial-goaway-on-namespace-stream
- Polished: 2026-08-20

## 目的

SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS ストリームの先頭メッセージとして GOAWAY が到着した場合に、PROTOCOL_VIOLATION でセッションを閉じるのではなく、GOAWAY 処理 (マイグレーション通知 + リクエストの失敗扱い) を行う。本 issue での「GOAWAY 処理」は、resolved=false の場合は `callbacks.goaway` 通知 → Promise の reject → 受信方向の cancel → ループ終了を指す。

**仕様内の衝突の位置づけ**: 本 issue の変更は、draft-ietf-moq-transport-19 §10.18 / §10.19 の MUST「If the subscriber receives any message other than a REQUEST_OK or a REQUEST_ERROR as the first message on the response half of the stream, then it MUST close the session with a PROTOCOL_VIOLATION.」を、§10.4 の「A GOAWAY MAY also be sent on a request stream to initiate migration of that individual request.」に優先させて確立前経路で GOAWAY を許可する変更である。仕様内で両者の優先関係は明示されていない。本 issue は §10.4 の GOAWAY マイグレーション（個別リクエストの移行を促す）が、確立前リクエストに対するリダイレクト相当の扱いとして先頭メッセージ規則に優先すると解釈して実装する。この解釈は 0372 が「先頭 GOAWAY はスコープ外の残余リスク」と記録した際の前提（§10.18 / §10.19 の MUST 準拠の現行挙動）を意図的に覆すものであり、相互運用上の緩和として CHANGES.md に明記する。

## 現状

- `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` (src/session/namespaceLoops.ts) の先頭メッセージガードは、REQUEST_OK / REQUEST_ERROR 以外のメッセージを PROTOCOL_VIOLATION でセッションを閉じる。
- draft-ietf-moq-transport-19 §10.4 は「A GOAWAY MAY also be sent on a request stream to initiate migration of that individual request.」と定めており、リクエストストリーム上の GOAWAY は確立前後を区別せず許可している。さらに同節の「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream」は REQUEST_OK 受信前後の区別なく適用される。
- つまり、マイグレーション目的の正当な GOAWAY が REQUEST_OK 前に届いた場合、セッション全体が閉じる。PUBLISH_NAMESPACE ループ (namespaceStartPublicationStreamLoop) は resolved=false の GOAWAY を reject + cancel で処理しており、3 ループ間で挙動が不整合。
- 0372 のエッジケース (i) で「先頭ガードが GOAWAY を PROTOCOL_VIOLATION にする既存挙動は本 issue の変更では解消されず、スコープ外の残余リスク」と明記されており、本 issue はその残余リスクの解消。

## 設計方針

- 先頭メッセージガードで GOAWAY を許可し、GOAWAY ケースへ流す。
- GOAWAY ケースには resolved=false の分岐を追加する (namespaceStartPublicationStreamLoop の既存実装と同構造)。resolved=false のときは `namespaceHandleGoaway` による callbacks.goaway 通知 → Promise の reject (`Error("request stream goaway: <uri>")`) → 受信方向の `streamReader.cancel()` → ループ終了とする。reject 後に読み取りを継続しないのは、reject 済みリクエストに後続の REQUEST_OK 等が発火して矛盾した通知が発生するのを防ぐためである。送信方向 (writer) は publication ループの既存実装と同様に閉じない (§10.4 の SHOULD「close the old request stream using the appropriate mechanism」はアプリの再発行 (re-issue) を前提としており、送信方向はアプリの再発行に委ねる)。
- resolved=true 側の挙動 (goawayReceived フラグ + 読み取り継続、0372 の実装) は既に実装済みであり変更しない。新規実装は「先頭ガードの GOAWAY 許可」「2 ループの GOAWAY ケースへの resolved=false 分岐追加」「先頭メッセージガードのエラーメッセージ文言更新」のみ。
- 先頭メッセージガードのエラーメッセージ ("expected REQUEST_OK or REQUEST_ERROR as first message ...") は、GOAWAY 許可後に実際に許されるメッセージ (REQUEST_OK / REQUEST_ERROR / GOAWAY) と整合する文言 (例: "expected REQUEST_OK, REQUEST_ERROR, or GOAWAY as first message on namespace stream, got 0x..." / "... on tracks stream, got 0x...") に更新する (ガードに引っかかった際のログが実態と乖離しないようにするため)。
- 先頭 GOAWAY 受信時は reject + cancel + return でループが即終了するため、その後に届く 2 通目 GOAWAY は検出されない。これは §10.4 の MUST「The endpoint MUST close the session with a PROTOCOL_VIOLATION ... if it receives more than one GOAWAY on ... a single request stream」の確立前経路における未達として許容する (0372 のエッジケース (h) が「確立前経路の GOAWAY 2 通目はスコープ外 (残余リスク)」と明記したのと同じ扱い)。
- 先頭 GOAWAY 許可に伴い、namespace / tracks ループの finally は publication ループと構造が異なる点に注意する。namespace / tracks ループの finally は `streamReader.releaseLock()` を try/catch なしで呼ぶのに対し (namespaceLoops.ts)、publication ループの finally は try/catch で包み「既に解放済みの場合は無視」している。resolved=false の `streamReader.cancel()` 追加時は、cancel と releaseLock の相互作用 (エラー状態ストリームでの cancel の reject は `.catch(() => {})` で握り潰されるが、releaseLock は握り潰されない) を実装時に確認する。
- 関連: 本 issue の設計 (resolved=false の GOAWAY は reject + cancel) により、closed issue 0413 の対象経路 (resolved=false かつ goawayReceived 後の read 例外) は発生しない。0413 は本 issue の設計方針を前提として「対象経路消滅」と判断され既に closed 済みであり (0413 の「closed にした理由」参照)、再評価は不要。万一本 issue の実装が設計方針から逸脱した場合 (resolved=false の GOAWAY で読み取りを継続する実装になった場合) のみ、0413 側の注記どおり新規 issue として起票し直す。また 0408 (GOAWAY 受信後の送信方向 FIN) は resolved=true を対象としており、本 issue の resolved=false 分岐と同一 switch ケースに触れるため実装順序に注意する。
- 変更対象ファイル: `src/session/namespaceLoops.ts` (先頭メッセージガード + 2 ループの GOAWAY ケース)、`src/session/namespaceLoops.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS ストリームの先頭に GOAWAY が来てもセッションが閉じず、`callbacks.goaway` が通知され、Promise が reject され受信方向が cancel されること (resolved=false の場合)。
- resolved=true の GOAWAY は従来どおり goawayReceived フラグ + 読み取り継続で処理されること。
- 先頭メッセージガードのエラーメッセージ文言の更新 ("expected REQUEST_OK, REQUEST_ERROR, or GOAWAY ...") が反映され、既存の guard 発火テストが更新後の文言に整合していること。
- 上記を検証するテストがあること (namespaceLoops.test.ts の既存 GOAWAY テスト基盤を使用)。
- `CHANGES.md` の `## develop` に `[FIX]` があること (§10.18 / §10.19 の MUST に対する相互運用緩和の位置づけを含む)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY)。「A GOAWAY MAY also be sent on a request stream to initiate migration of that individual request.」「Upon receiving a GOAWAY on a request stream, the endpoint SHOULD re-issue that specific request ... and close the old request stream」
- draft-ietf-moq-transport-19 §10.18 (SUBSCRIBE_NAMESPACE) / §10.19 (SUBSCRIBE_TRACKS)。先頭メッセージの MUST「If the subscriber receives any message other than a REQUEST_OK or a REQUEST_ERROR as the first message on the response half of the stream, then it MUST close the session with a PROTOCOL_VIOLATION.」（本 issue は §10.4 の GOAWAY マイグレーションを優先させる相互運用緩和）
- 関連: `issues/closed/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md`（重複 GOAWAY 検出。エッジケース (h) で確立前経路の GOAWAY 2 通目を、エッジケース (i) で先頭 GOAWAY の既存挙動を残余リスクとして明記）
- 関連: `issues/0408-fix-namespace-goaway-send-direction-close.md`（GOAWAY 受信後の送信方向 FIN。resolved=true が対象。同一 switch ケースに触れるため実装順序に注意）
- 関連: `issues/closed/0413-bug-goaway-subscribe-hang.md`（GOAWAY 受信後の read 例外。本 issue の設計方針により対象経路が消滅するとして既に closed 済み。本 issue の実装が設計方針から逸脱した場合のみ新規起票）

## 解決方法

`src/session/namespaceLoops.ts` に helper 2 つ (`namespaceValidateFirstMessage` / `namespaceHandleGoawayMessage`) を導入し、3 ループ (namespace / tracks / publication) を helper 呼び出しで統一した。

- `namespaceValidateFirstMessage` は namespace / tracks ループの先頭メッセージガードで REQUEST_OK / REQUEST_ERROR / GOAWAY のいずれかのみを許可する。想定外メッセージは PROTOCOL_VIOLATION でセッションを閉じる。
- `namespaceHandleGoawayMessage` は 3 ループ共通の GOAWAY ケース処理を担う。resolved=false のときは §10.4 のリクエストストリーム GOAWAY マイグレーションに従い callbacks.goaway 通知 → Promise reject → 受信方向 cancel でループを終了する。resolved=true のときは従来どおり goawayReceived フラグを立てて読み取りを継続する。
- 送信方向は §10.4 SHOULD の解釈としてアプリの再発行 (re-issue) に委ね、helper では閉じない (既存 publication ループと同挙動)。
- 先頭 GOAWAY で reject + return する結果、以降に届く 2 通目 GOAWAY (§10.4 MUST) は検出されないトレードオフを許容判断済み (0372 のエッジケース (h) と同扱い)。
- `src/session/namespaceLoops.test.ts` に新規テスト 5 件を追加した (namespace / tracks / publication の先頭 GOAWAY 経路、namespace / tracks の先頭想定外メッセージのガード、namespace の空 URI GOAWAY の fallback 挙動)。callbacks.goaway 通知、Promise reject、セッション継続、finally 経路の subscription/publication state=closed、callbacks.error 不発火、goawayReceivedOnRequestStreams の副作用を検証する。
- `CHANGES.md` の `## develop` セクションに `[FIX]` エントリを追加し、§10.18 / §10.19 の MUST に対する相互運用緩和と §10.4 の 2 通目 GOAWAY 検出放棄のトレードオフを明記した。
