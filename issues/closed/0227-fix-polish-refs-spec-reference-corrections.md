# polish-refs: 仕様引用の正確性検証による修正を適用する

Created: 2026-06-01
Completed: 2026-06-01
Priority: High
Model: deepseek-v4-flash

## 目的

polish-refs スキルによりソースコードおよび issue 内の仕様引用を refs/ 配下の一次資料と照合した結果、複数の誤りを検出した。
引用の正確性を確保し、誤った仕様解釈による実装バグを防止する。

## 現状

draft-ietf-moq-transport-18 への参照において、以下の誤りが存在する:

- `src/message/types.ts`: PUBLISH_DONE の `EXPIRED` と `TOO_FAR_BEHIND` のコードポイント値が仕様と逆 (誤ったステータスコードが送信される可能性がある)
- `src/properties.ts`: Property Type の値範囲が仕様と大幅に乖離 (6 レンジ中 3 レンジしか記載なく、値も誤り)
- `src/msf.prop.ts`: Catalog 例のセクション番号が `5.2.x` となっているが、正しくは `5.3.x`。ファイル名も `draft-ietf-moq-msf.md` (存在しない) を参照
- `src/message/parameter.ts`: 節番号参照が 2 箇所で誤り (`§10.2.1` → `§1.4.3`, `§10.2` → `§2.4.1`)
- `src/subscriber.ts`: セッション終了の節番号が `§3.4` だが正しくは `§3.5`、"UNSUBSCRIBE" は draft-18 で削除されたメッセージ名
- `src/session/params.ts`: SUBGROUP_HEADER の type 範囲コメントが不十分 (仕様は 4 レンジだが 2 レンジのみ記載)
- `src/error.ts`: "Data Stream Reset Error Codes" とあるが仕様の名称は "Stream Reset Error Codes"
- `src/publisher.ts`, `src/subscriber.ts`: Datagram/Subgroup 混在の参照が "Section 10" と広すぎる
- `src/fetcher.ts`: FETCH unknown range の参照に `§11.4.4` が欠落
- `src/msf.ts`: Delta update の MUST NOT 要件に `Section 5.2` の参照が欠落
- `src/msf.test.ts`: "RFC Section 8.4.2" とあるがドラフトは RFC ではない
- `issues/0220`: REQUEST_OK の type 値 `0x05` は誤り (正しくは `0x07`)
- `issues/0180`: `End of Unknown Range: 0x10E` は仕様に存在しない (正しくは `0x10C`)
- `issues/0205`: Joining Location 定義の節番号が `§5.1.3` だが正しくは `§5.1.1`
- `issues/0186`: Redirect 構造体の引用元に `§10.6.1` が欠落
- `issues/0189`: REQUEST_OK エイリアス一覧から `TRACK_STATUS_OK` が欠落

## 設計方針

polish-refs スキルの指摘に従い、すべての修正は refs/ 配下の一次資料 (draft-ietf-moq-transport-18.txt, draft-ietf-moq-msf-00.txt) を実際に開いて照合した結果のみに基づく。憶測や「あった方が親切」レベルの引用追加は一切行わない。

## 完了条件

- 全修正後、`npm run build` が成功すること
- `npm test` (全 576 テスト) が通過すること
- `npm run lint` が 0 warnings/errors であること
- `tsc --noEmit` が成功すること

## 解決方法

### 致命的指摘の修正

1. `src/message/types.ts`:
   - `EXPIRED` (0x5) と `TOO_FAR_BEHIND` (0x6) を入れ替え (`TOO_FAR_BEHIND: 0x5`, `EXPIRED: 0x6`)
   - `isPublishDoneErrorStatus` の `case 0x6n` → `case 0x5n`
   - コメントの値も併せて修正

2. `src/properties.ts:89-91`:
   - Property Type 値範囲のコメントを 3 レンジから仕様の 6 レンジに書き換え
   - `0x37` → `0x77`、欠落していた 3 レンジを追加、`0x4000 以上: FCFS` → `0x4000-0x7FFF: Mandatory Track Properties / 0x8000 以上: FCFS`

3. `src/msf.prop.ts` (4 箇所):
   - セクション番号 `5.2.1/5.2.2/5.2.3/5.2.7` → `5.3.1/5.3.2/5.3.3/5.3.7`
   - ファイル名 `refs/moq/draft-ietf-moq-msf.md` → `draft-ietf-moq-msf-00`

4. `issues/0220-draft-18-update-define-textual-aliases-for-request-ok.md:47`: `0x05` → `0x07`

5. `issues/0180-bug-unknown-range-metadata-fetch.md:20`: `0x10E` を削除し `0x10C` に修正

6. `issues/0205-draft-18-update-clarify-joining-fetch-ordering-with-forward-state-transitions.md:21`: `§5.1.3` → `§5.1.1`

### 重要指摘の修正

7. `src/message/parameter.ts:15`: `Section 10.2.1` → `Section 1.4.3`
8. `src/message/parameter.ts:345`: `Section 10.2` → `Section 2.4.1`
9. `src/subscriber.ts:241`: `Section 3.4` → `Section 3.5`
10. `src/subscriber.ts:271-272`: "UNSUBSCRIBE" → "STOP_SENDING" に文言修正
11. `src/session/params.ts:296`: SUBGROUP_HEADER の type 範囲コメントに 4 レンジを追記
12. `src/error.ts:91`: "Data Stream Reset Error Codes" → "Stream Reset Error Codes"
13. `issues/0186-draft-18-add-redirect-for-request-errors-and-established-subscriptions.md:28`: 引用元に `§10.6.1` 追加
14. `issues/0189-draft-18-change-remove-publish-ok-as-request-ok-alias.md:12-15`: 引用に `TRACK_STATUS_OK` 追加

### 軽微指摘の修正

15. `src/publisher.ts:73`: "Section 10" → "Section 2.2, Section 11.3"
16. `src/subscriber.ts:186`: "Section 10" → "Section 2.2, Section 11.3"
17. `src/msf.test.ts:306`: "RFC Section 8.4.2" → "draft-ietf-moq-msf-00 Section 8.4.2"

### 欠落指摘の修正

18. `src/msf.ts:172`: Delta update の MUST NOT コメントに `draft-ietf-moq-msf-00 Section 5.2` 追加
19. `src/fetcher.ts:7-9`: FETCH unknown range のコメントに `Section 11.4.4, Table 7` 追加
