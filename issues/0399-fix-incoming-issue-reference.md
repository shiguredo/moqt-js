# src/session/incoming.ts のモジュール doc から issue 番号参照を削除する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-incoming-issue-reference
- Polished: 2026-08-20

## 目的

`src/session/incoming.ts` のモジュール doc に残る issue 番号参照（「。issue 0302 設計方針参照」）を、shiguredo-issues 規約（issue 番号や issue への言及をソースコードに持ち込まないこと）に従い削除する。issue 番号ではなく、その理由（状態結合の強さ）を記述に残す。

## 現状

- `src/session/incoming.ts` のモジュール doc に「（状態結合が強いため。issue 0302 設計方針参照）。」という記述がある。
- issue 番号は issue ファイルの管理と git 履歴のためのものであり、ソースコード本体に持ち込むと、将来 issue が統合・削除・再付番された場合に辿れなくなる。
- なお、同種の issue 番号参照が他のファイルにも残存する（例: `src/properties.prop.ts` の「(#0122)」、`src/properties.test.ts` の「(#0119)」/「(#0122)」、`src/controlStream.test.ts` の「(#0315)」、`src/msf.ts` の「(#0316)」）。これらは本 issue では対応しない（対象は `src/session/incoming.ts` のみ。他ファイルの一掃は別途対応）。

## 設計方針

- issue 番号参照を削除し、理由そのもの（状態結合が強いため）のみを残す（例: 「（状態結合が強いため）。」）。
- ロジックの変更は伴わない。

## 完了条件

- `src/session/incoming.ts` のモジュール doc から issue 番号参照（「。issue 0302 設計方針参照」の部分）が削除され、理由のみの記述（例: 「（状態結合が強いため）。」）になっていること。
- ロジックの変更がないこと（`vp check` / `tsc --noEmit` / `vp test run` が通ること）。
- `CHANGES.md` の `## develop` に本修正の記載があること（doc コメント修正のため `### misc` サブセクションに記載する。`shiguredo-changelog` 参照）。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- 関連: `0371-moqt-draft-19-incoming-request-not-supported-response.md`（本 issue はそこから分離された doc 修正）

## 解決方法

未着手。
