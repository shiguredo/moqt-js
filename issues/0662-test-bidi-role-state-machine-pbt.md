# リクエストストリームのロール状態機械が PBT で検証されていない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-bidi-role-state-machine-pbt
- Polished: {YYYY-MM-DD}

## 目的

リクエストストリームの受信ループは publish / subscribe / fetch の 3 ロールで同じメッセージ列を別の意味に解釈する。ロールごとの分岐は固定ケースの単体テストで個別に固定されているが、任意のメッセージ列を与えたときに状態機械が破綻しないかは検証されていない。ロールの取り違え、未応答 REQUEST_UPDATE の上限、FIN / RESET と pending の相互作用は組合せが多く、固定ケースでは漏れる。

## 現状

- `src/session/bidi.prop.ts` の 26 テストは `validateNoDuplicateGoawayOnRequestStream` / `restoreIncomingRequestUpdateCount` / `clearPriorGapTrackingIfUnused` などの純関数だけを対象にしている
- 同ファイル冒頭のコメントは `bidiReadRequestStreamMessages` などの非同期 I/O を「性質がストリームの読み書き順序と pending の解決タイミングに依存し、fc.property の同期評価に載せられない」として対象外としている
- しかし `src/session/namespaceLoops.prop.ts` には `fc.asyncProperty` で受信ループを駆動し「メッセージ列のチャンク分割を変えても結果が変わらない」ことを検証する PBT がある。`src/session/stream.prop.ts` の PBT は `fc.property` の同期評価のみで、受信ループを駆動していない。同じ粒度の検査が `src/session/bidi.ts` の `bidiReadRequestStreamMessages` には無い
- `bidiReadRequestStreamMessages` は `role: BidiRequestStreamRole` ("publish" / "subscribe" / "fetch") と `initialMessages` を受け取り、`bidiProcessRequestStreamMessages` がメッセージ種ごとにロール分岐する。読み取り失敗 (RESET など) は `handleRequestStreamReadError` へ委譲する

## 設計方針

- ロール 3 値 × メッセージ種 (PUBLISH_DONE / PUBLISH_STATE_NOTIFY / REQUEST_OK / REQUEST_ERROR / REQUEST_UPDATE / GOAWAY) × `initialMessages` の有無 × MAX_REQUEST_UPDATES の未応答数 × FIN / RESET の組合せを任意生成する
- 期待遷移 (セッションを閉じる / 購読を closed にする / 継続する) と、メッセージ列のチャンク分割を変えても結果が変わらないことを検証する
- 実ストリームと実 SessionImpl で構築する。`src/testSupport/bidi.ts` の `createBidiSession` は使わない (0666 で実ストリームに置き換える)
- 同ファイル冒頭の「fc.property の同期評価に載せられない」という記述は実態に合わないため、対象範囲を更新する

## 完了条件

- ロールごとの遷移と分割非依存を検証する PBT が `src/session/bidi.prop.ts` に追加される
- `pnpm test` が通る

## 参照

- 0666 (テスト用スタブの除去)
- `src/session/namespaceLoops.prop.ts` (チャンク分割非依存の PBT の先例)

## 解決方法

{未着手}
