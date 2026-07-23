# 仕様参照コメントを draft-ietf-moq-transport-19 に一括更新する

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/update-draft-19-spec-reference-comments
- Polished: 2026-07-23

## 目的

moqt-js のコード・テスト・devtools は仕様参照コメントとして `draft-ietf-moq-transport-18` を多数参照している。draft-19 ではセクション番号の振り直しと用語変更があるため、参照ドラフト番号と節番号・引用文言を一括で draft-19 に更新する。

polish-refs による引用検証の正確性は refs/ の一次資料とコメントの一致に依存する。実装系の draft-19 対応 issue (0332–0342) がすべて closed になった後、残りの参照を本 issue で一括更新する。

## 優先度根拠

コメントのみの変更で動作に影響はないが、古い版の参照が残ると以後のレビュー・polish-refs 検証が draft-18 基準になり、仕様追従の妨げになる。他の draft-19 対応 issue 完了後に速やかに実施すべきなので Medium。

## 現状

`draft-ietf-moq-transport-18` の参照は `src/`・`src/**/*.test.ts` / `*.prop.ts`・`tests/`・`devtools/` に広く分布している（実装時は `rg 'draft-ietf-moq-transport-18'` の結果を正とする。数百ヒット規模）。

refs/moq/ には `draft-ietf-moq-transport-19.txt` が取り込み済みである。本 issue の実装時はこれを一次資料として照合する。

また次にも残る:

- `README.md`: 機能一覧の draft-18 リンク
- `.env.example`: `draft-ietf-moq-transport-18 §3.1.1` コメント
- `src/msf.ts`: **transport** の `draft-ietf-moq-transport-18 §1.4` 参照が 1 件（msf-01 とは別。こちらは更新対象）

コードから参照されているセクションのうち、draft-19 で番号または名称が変わるもの（節タイトルは一次資料 TOC の正式名称）:

| draft-18                                 | draft-19                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| 3.1.3 WebTransport                       | 3.1.4 WebTransport（3.1.3 は新設 Dereferencing a MOQT URI）               |
| 3.6 Migration（当時見出し）              | 3.6 Session Migration（名称変更のみ）                                     |
| 3.3.3 Stream Reset Error Codes           | 3.3.4 Stream Reset Error Codes                                            |
| 5.1.2 Subscription Filters               | 5.1.2 Location Filters（名称変更）                                        |
| 10.2.9 SUBSCRIPTION FILTER Parameter     | 10.2.9 LOCATION FILTER Parameter（名称変更）                              |
| 10.2.10 EXPIRES Parameter                | 10.2.15 EXPIRES Parameter（間に 10.2.10–14 の各 Filter Parameter が挿入） |
| 10.2.11 LARGEST OBJECT Parameter         | 10.2.16 LARGEST OBJECT Parameter                                          |
| 10.2.12 FORWARD Parameter                | 10.2.17 FORWARD Parameter                                                 |
| 10.2.13 NEW GROUP REQUEST Parameter      | 10.2.18 NEW GROUP REQUEST Parameter                                       |
| 10.2.14 TRACK_NAMESPACE_PREFIX Parameter | 10.2.19 TRACK_NAMESPACE_PREFIX Parameter                                  |
| 10.20 PUBLISH_BLOCKED                    | 10.20 PUBLISH_SKIPPED（名称変更。**識別子リネームは `#0335`**）           |
| 15.10 Error Codes                        | 15.11 Error Codes                                                         |
| 15.10.4 Stream Reset Error Codes         | 15.11.4 Stream Reset Error Codes                                          |

15.10 → 15.11 の繰り下がり理由（draft-18 / draft-19 TOC 照合）:

- draft-18: 15.9 Session-Level Track Names / 15.10 Error Codes
- draft-19: 15.9 Object Status（新設） / 15.10 Session-Level Track Names / 15.11 Error Codes
- Object Status 節の挿入により、Session-Level Track Names は 15.9 → 15.10、Error Codes は 15.10 → 15.11 へ繰り下がる

注意（機械置換で誤る箇所）:

- Joining an Ongoing Track（draft-18 5.1.3 → draft-19 5.1.5。間に 5.1.3 Range Filters / 5.1.4 Combining Filters）は現状コードに直接参照は無い。`draft-ietf-moq-msf-01` の §5.1.3 を誤って触らないこと
- Native QUIC（draft-18 3.1.4 → draft-19 3.1.5）も直接参照は無い。`Section 10.3.1.4`（AUTHORIZATION TOKEN Setup Option）と混同しないこと
- `src/session.ts` にある `§3.3.2` 参照は **3 箇所**（うち 1 箇所だけ `(Bidirectional Streams)` 括弧付き。3988 行付近・4027 行付近は括弧なし）。いずれも本文は「双方向ストリームは特定のメッセージタイプで開始されなければならない」であり、draft-18 / draft-19 のどちらの 3.3.2 正式タイトルとも一致しない。正しくは Section 3.3 Session initialization。対応表の機械置換対象にせず、**3 箇所すべて**を Section 3.3 へ直す（括弧なしを「Request Cancellation の正しい参照」と誤って 3.3.3 にしない）
- Request Cancellation and Rejection（draft-18 3.3.2 → draft-19 3.3.3）への**正しい**参照が `session.ts` 以外に残っていれば 3.3.3 に更新する（上記誤ラベル 3 箇所とは別）

制御メッセージの "Message Payload" は draft-19 で "Message Body" にリネーム（Appendix A.1 `#1756`）。引用箇所（`src/message/session.ts`、`src/message/session.prop.ts`）は draft-19 Section 10 原文に合わせる:

> If the length does not match the length of the Message Body, the receiver MUST close the session with a PROTOCOL_VIOLATION.

番号が据え置きの高頻度参照（10.4 GOAWAY、10.5 REQUEST_OK、10.19 SUBSCRIBE_TRACKS、11.4.2 Subgroup Header、12.x MOQT Properties、1.4.3 KVP、10.3.1.x Setup Options など）はドラフト番号のみの置換で足りる。

## 設計方針

- **着手ゲート**: 実装変更を伴う draft-19 対応 issue (0332–0342) がすべて closed になっていること。各 issue が自分の変更箇所の参照を更新するため、本 issue は残りを対象とする
- **本 issue の範囲**: コメント・JSDoc・ドキュメント文言の版番号・節番号・英文引用。**識別子・公開 API・ワイヤのリネームはしない**（`PUBLISH_BLOCKED` → `PUBLISH_SKIPPED` は `#0335`、`SUBSCRIPTION_FILTER` → `LOCATION_FILTER` は `#0340`。0335/0340 closed 後に残るコメント内の旧メッセージ名／パラメータ名の散文だけ本 issue で直す）
- 上記の対応表に従い、節番号が変わる参照を先に個別修正し、その後 `draft-ietf-moq-transport-18` → `draft-ietf-moq-transport-19` を一括置換する
- 英文引用は draft-19 原文と突き合わせて文言差分（Message Body 等）を反映する。節タイトルは一次資料の正式名称に揃える
- 誤ラベルの節番号は機械置換せず、一次資料の正しい節へ直す
- **対象パス**: `src/`（`*.ts` / `*.test.ts` / `*.prop.ts`）、`tests/`、`devtools/`、`README.md`、`.env.example`
- **除外**: `CHANGES.md` の過去エントリ、`issues/`、`refs/`。`draft-ietf-moq-msf-01` など **MSF 仕様そのもの**の参照（`src/msf.ts` 内の transport-18 版文字列は対象に含める）
- 完了後に polish-refs で全引用を検証する
- CHANGES.md への追記は不要（コメントのみ。動作・API 変更なし）

## 完了条件

- 着手時に 0332–0342 がすべて closed であること
- 対象パス（`src/` / `tests/` / `devtools/` / `README.md` / `.env.example`）に `draft-ietf-moq-transport-18` が残っていないこと（`CHANGES.md` / `issues/` / `refs/` / msf-01 文字列は除外して grep）
- `src/msf.ts` の **transport** 参照も draft-19 になっていること（msf-01 参照は維持）
- 節番号シフト対象が draft-19 の正しい節番号・正式節タイトルになっていること
- Message Payload → Message Body の引用更新が完了していること
- `src/session.ts` の誤ラベル `§3.3.2`（括弧付き・括弧なしの計 3 箇所）が残っていないこと
- 識別子（`PUBLISH_BLOCKED` / `SUBSCRIPTION_FILTER` 等のコードシンボル）を本 issue でリネームしていないこと（0335/0340 の責務）
- polish-refs の検証で引用の不一致が報告されないこと
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. 0332–0342 が closed であることを確認する
2. `rg 'draft-ietf-moq-transport-18'` で対象一覧を取得する（CHANGES / issues / refs は目視で除外）
3. 対応表の節番号シフト・名称変更を個別に直す（一括置換より先）。特に 10.2.10–14 → 10.2.15–19 と 15.10 → 15.11 を取り違えない
4. `src/message/session.ts` / `src/message/session.prop.ts` の Message Payload 引用を Message Body に更新する
5. `src/session.ts` の誤ラベル `§3.3.2` を **3 箇所すべて** Section 3.3 Session initialization へ修正する（括弧なし 2 件を 3.3.3 にしない）
6. `README.md` / `.env.example` / `src/msf.ts` の transport-18 を 19 に更新する（msf-01 は触らない）
7. 残りの `draft-ietf-moq-transport-18` を `draft-ietf-moq-transport-19` に一括置換する
8. 識別子を誤って変えていないことを確認する（`PUBLISH_SKIPPED` / `LOCATION_FILTER` は 0335/0340 済み前提）
9. polish-refs で全引用を検証し、`vp check` / `tsc --noEmit` / `vp test run` を通す
