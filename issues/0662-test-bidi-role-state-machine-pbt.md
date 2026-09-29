# リクエストストリームのロール状態機械が PBT で検証されていない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-bidi-role-state-machine-pbt
- Polished: 2026-09-29

## 目的

リクエストストリームの受信ループは publish / subscribe / fetch の 3 ロールで同じメッセージ列を別の意味に解釈する。ロールごとの分岐は固定ケースの単体テストで個別に固定されているが、任意のメッセージ列を与えたときに状態機械が破綻しないかは検証されていない。ロールの取り違え、未応答 REQUEST_UPDATE の上限、FIN / RESET と pending の相互作用は組合せが多く、固定ケースでは漏れる。

## 現状

- `src/session/bidi.prop.ts` の 26 テストは `validateNoDuplicateGoawayOnRequestStream` / `restoreIncomingRequestUpdateCount` / `clearPriorGapTrackingIfUnused` などの純関数だけを対象にしている
- 同ファイル冒頭のコメントは `bidiReadRequestStreamMessages` などの非同期 I/O を「性質がストリームの読み書き順序と pending の解決タイミングに依存し、fc.property の同期評価に載せられない」として対象外としている
- しかし `src/session/namespaceLoops.prop.ts` には `fc.asyncProperty` で受信ループを駆動し「メッセージ列のチャンク分割を変えても結果が変わらない」ことを検証する PBT がある。`src/session/stream.prop.ts` の PBT は `fc.property` の同期評価のみで、受信ループを駆動していない。同じ粒度の検査が `src/session/bidi.ts` の `bidiReadRequestStreamMessages` には無い
- `bidiReadRequestStreamMessages` は `role: BidiRequestStreamRole` ("publish" / "subscribe" / "fetch") と `initialMessages` を受け取り、`bidiProcessRequestStreamMessages` がメッセージ種ごとにロール分岐する。読み取り失敗 (RESET など) は `handleRequestStreamReadError` へ委譲する

## 設計方針

- ロール 3 値 × メッセージ種 (PUBLISH_DONE / PUBLISH_STATE_NOTIFY / REQUEST_OK / REQUEST_ERROR / REQUEST_UPDATE / GOAWAY) × `initialMessages` の有無 × MAX_REQUEST_UPDATES の未応答数 × FIN / RESET の組合せを任意生成する。生成するメッセージはデコード可能なペイロードに限定する (破損ペイロードの挙動は既存の単体テストの領分)
- 期待遷移 (セッションを閉じる / 購読を closed にする / 継続する) は、role と生成したメッセージ列から各ハンドラの仕様解釈 (固定テストが固定した挙動) に従って独立に導出したモデルで計算し、実装の観測結果と一致することを検証する (`namespaceLoops.prop.ts` の active 集合モデルと同じ流儀)
- メッセージ列のチャンク分割を変えても結果が変わらないことも検証する。ただし、1 回の read 内の REQUEST_UPDATE 群が MAX_REQUEST_UPDATES の上限超過に達し得る列は、超過検出が read 境界 (受信グループ) に依存するため分割非依存の対象から除外する。この read 境界依存は `bidiReadRequestStreamMessages` が 1 回の read で得た列を同時に未応答と数え、read 単位で戻す実装の意図であり、境界の挙動は既存の固定テスト (`bidiRequestUpdateScopeAudit.test.ts`) が固定する
- 実ストリームと実 SessionImpl で構築する。`src/testSupport/bidi.ts` の `createBidiSession` は使わない (0666 で実ストリーム版へ置き換わる予定だが、本 issue はそれに依存せず `session.test.ts` と同じ実 SessionImpl 構築で進める)
- 同ファイル冒頭の「fc.property の同期評価に載せられない」という記述は実態に合わないため、対象範囲を更新する

## 完了条件

- ロールごとの期待遷移とチャンク分割非依存 (設計方針の除外条件に従う) を検証する PBT が `src/session/bidi.prop.ts` に追加される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0666 (テスト用スタブの除去)
- `src/session/namespaceLoops.prop.ts` (チャンク分割非依存の PBT の先例)

## 解決方法

{未着手}
