# リクエストストリームのロール状態機械が PBT で検証されていない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-bidi-role-state-machine-pbt
- Polished: 2026-11-14
- Refreshed: 2026-11-14

## 目的

リクエストストリームの受信ループは publish / subscribe / fetch の 3 ロールで同じメッセージ列を別の意味に解釈する。ロールごとの分岐は固定ケースの単体テストで個別に固定されているが、任意のメッセージ列を与えたときに状態機械が破綻しないかは検証されていない。ロールの取り違え、未応答 REQUEST_UPDATE の上限、FIN / RESET と pending の相互作用は組合せが多く、固定ケースでは漏れる。

## 現状

- `src/session/bidi.prop.ts` の 27 テストは `validateNoDuplicateGoawayOnRequestStream` / `restoreIncomingRequestUpdateCount` / `clearPriorGapTrackingIfUnused` / `bidiHandlePublishDone` / `bidiHandlePublishStateNotify` などの純粋関数と準純粋関数 (同期評価できるもの) だけを対象にしている
- 同ファイル冒頭のコメントは `bidiReadRequestStreamMessages` などの非同期 I/O を「性質がストリームの読み書き順序と pending の解決タイミングに依存し、fc.property の同期評価に載せられない」として対象外としている
- しかし `src/session/namespaceLoops.prop.ts` には `fc.asyncProperty` で受信ループを駆動し「メッセージ列のチャンク分割を変えても結果が変わらない」ことを検証する PBT がある。`src/session/stream.prop.ts` の PBT は `fc.property` の同期評価のみで、受信ループを駆動していない。同じ粒度の検査が `src/session/bidi.ts` の `bidiReadRequestStreamMessages` には無い
- `bidiReadRequestStreamMessages` は `role: BidiRequestStreamRole` ("publish" / "subscribe" / "fetch") と `initialMessages` を受け取り、`bidiProcessRequestStreamMessages` がメッセージ種ごとにロール分岐する。読み取り失敗 (RESET など) は `handleRequestStreamReadError` へ委譲する

## 設計方針

- ロール 3 値 × メッセージ種 (PUBLISH_DONE / PUBLISH_STATE_NOTIFY / REQUEST_OK / REQUEST_ERROR / REQUEST_UPDATE / GOAWAY) × `initialMessages` の有無 × 上限 (`localMaxRequestUpdates`。draft-ietf-moq-transport-23 §9.1.7、0 = 無制限) と未応答数 × 保留中の REQUEST_UPDATE (`session.pendingRequestUpdate`) の有無 × FIN / RESET (§6.4.2.2 / §6.4.2.3) の組合せを任意生成する。生成するメッセージはデコード可能なペイロードに限定する (破損ペイロードの挙動は既存の単体テストの領分)
- 期待遷移 (セッションを閉じる / 購読または publisher を closed にする / 継続する / 保留中の REQUEST_UPDATE を resolve する / reject する) は、role と生成したメッセージ列から各ハンドラの仕様解釈 (固定テストが固定した挙動) に従って独立に導出したモデルで計算し、実装の観測結果と一致することを検証する (`namespaceLoops.prop.ts` の active 集合モデルと同じ流儀)。観測値は `namespaceLoops.prop.ts` の `outcomeSnapshot` と同じく、結果に影響する項目 (sessionState / 購読または publisher の状態 / requestStreams の有無 / pending の決着 / 送出メッセージ) に限定する
- メッセージ列のチャンク分割を変えても結果が変わらないことも検証する。ただし、分割前の 1 回の read (メッセージ列全体) で REQUEST_UPDATE 群が MAX_REQUEST_UPDATES の上限超過に達し得る列は、超過検出が read 境界 (受信グループ) に依存するため分割非依存の対象から除外する。この read 境界依存は `bidiReadRequestStreamMessages` が 1 回の read で得た列を同時に未応答と数え、read 単位で戻す実装の意図であり、境界の挙動は既存の固定テスト (`bidiRequestUpdateScopeAudit.test.ts`) が固定する。`initialMessages` も最初の応答と同一チャンクで読み取り済みの 1 グループであり、上限判定は 1 回の read と同じく処理後に未応答数を復元するものとしてモデル化する
- 実ストリームと実 SessionImpl で構築する。`createBidiSession` は requestId 0n のストリームを登録するが `readableController` を返さないため、任意のチャンクを enqueue できない。publish ロールは `src/testSupport/bidi.ts` の `createPublishReadTestContext`、fetch ロールは同ファイルの `createFetchReadTestContext` を使う。subscribe ロールは `createPublishReadTestContext` で session と実ストリームを用意し、`SubscriberImpl` を `session.subscribers` / `subscribersByAlias` へ配線する (`src/session/bidiSubscribeFinReset.test.ts` と同じ)。いずれも `session.controlWriter` が設定済みで、REQUEST_OK / REQUEST_ERROR の送出まで観測できる
- 同ファイル冒頭の「fc.property の同期評価に載せられない」という記述は、`fc.asyncProperty` で非同期 I/O を駆動できる実態に合わないため、対象範囲を更新する (`bidiReadRequestStreamMessages` は検証対象に含め、引き続き対象外とする関数だけを列挙する)
- PBT が露見させた実装の不具合は、ロール状態機械と MAX_REQUEST_UPDATES に関するものを本 issue で修正する。それ以外は再現条件と症状を別 issue として起票する

## 完了条件

- ロールごとの期待遷移 (保留中の REQUEST_UPDATE の決着を含む) とチャンク分割非依存 (設計方針の除外条件に従う) を検証する PBT が `src/session/bidi.prop.ts` に追加される
- 同ファイル冒頭のコメントの対象範囲が更新される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed 0666 (テスト用スタブの除去。完了済みで `createBidiSession` は実 SessionImpl / 実ストリームを使う)
- open 0936 (`handleRequestStreamReadError` はピアのストリームエラーでない読み取りエラーでは保留中の REQUEST_UPDATE を reject しない。RESET / FIN による reject は本 issue、セッション終了時の settle は 0936 の範囲)
- `src/session/bidiReadRequestStreamMessages.test.ts` (既存の固定ケース)
- `src/session/bidiRequestUpdateScopeAudit.test.ts` (read 境界の上限判定の固定テスト)
- `src/session/namespaceLoops.prop.ts` (チャンク分割非依存の PBT の先例)

## 解決方法

{未着手}
