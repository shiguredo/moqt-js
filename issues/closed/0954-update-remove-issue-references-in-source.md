# テストとソースのコメントから issue への言及を削除する

- Created: 2026-11-10
- Completed: 2026-11-10
- Branch: feature/update-remove-issue-references-in-source
- Polished: 2026-11-10

## 目的

`shiguredo-issues` は、ソースコード本体・テスト名・テストコメントから issue への言及を外し、残したい「なぜ」は理由そのもの (仕様の節番号・再現条件・設計意図) を書くことを定めている。テストとソースのコメントに残っている issue への言及 (issue という語と、番号だけの参照) を削除する。

## 現状

- JSDoc に issue という語を含む記述が 3 箇所ある (ファイル先頭が 1 箇所、テスト直前が 2 箇所)
  - `tests/e2e/relay/devtools-publish-stop.spec.ts` の「結果をログに残す。差が出なかった場合はその事実を issue に記録する。」
  - `src/session/namespaceLoops.test.ts` の「(通知の判定は確立状態に依存しないが、この issue の再現経路は確立後である)。」
  - `src/session/bidiFetchRequestStreamMessages.test.ts` の「fetch ロールは既存の switch の扱いをそのまま通し (本 issue のスコープでは」
- 番号だけで issue を指す記述が 8 箇所ある。いずれも closed の issue の番号であり、コメントの意味は番号を外しても保てる
  - `src/session/params.test.ts` の「`0478`: リクエスト種別ごとの送信可能パラメータ」
  - `tests/e2e/relay/audio-timestamp.spec.ts` の「桁が変わるずれ (0754 の症状では数百 ms) を」「0754 の症状は「ずれが固定する」ことであり」「(0754 の症状である数百 ms のずれを捕まえる)」
  - `src/session/bidiReadRequestStreamMessages.test.ts` の「0374 で追加された notifySubscriberFailure (error 通知) に加えて」「(0374 の挙動)」「0370 の保持経路が維持される」「(0370)」
- `vite.config.ts` の「TODO/FIXME コメントは issues で管理」は特定の issue を指さない運用の説明であり、この issue では変えない
- `docs/` 配下にも issue 番号の参照が残っている (`docs/archive/audits/DEBUG_AUDIT.md`、`docs/archive/playout/AV_SYNC_DECISIONS.md`)。`docs` は `shiguredo-issues` の禁止対象だが、この issue はテストとソースのコメントだけを対象にする
- `rg -n 'issue' tests src devtools --glob '*.ts'` は 94 行を返すが、その大半は `issuer` / `issuedAt` / 仕様引用の `re-issue` であり、issue への言及の検出には使えない

## 設計方針

- 上記の 3 箇所の issue という語を、記録先や理由そのものを書く表現に置き換える
  - `devtools-publish-stop.spec.ts` は「結果をログに残す。差が出なかった場合も、relay の実装で結果が変わりうるため、後から比較できるようログに残す」のように、記録先 (ログ) と理由 (relay の実装依存) を書く。2 文目が 1 文目と重複する場合は 1 文に統合する
  - `namespaceLoops.test.ts` は「(通知の判定は確立状態に依存しないが、再現経路は確立後である)」のように、issue への言及を外して再現条件をそのまま書く
  - `bidiFetchRequestStreamMessages.test.ts` は「fetch ロールは既存の switch の扱いをそのまま通し (この範囲では」のように、範囲を表す語に置き換える
- 上記の 8 箇所の番号を削除し、番号が補っていた意味を言葉で書く。例: 「0478: リクエスト種別ごとの送信可能パラメータ」は「リクエスト種別ごとの送信可能パラメータ」にする
- コメントのみを変え、テストの観測内容・判定・実装の挙動は変えない

### 対象外

- `vite.config.ts` の「TODO/FIXME コメントは issues で管理」(特定の issue を指さない運用の説明)
- `docs/` 配下の issue 番号の参照 (`shiguredo-issues` の禁止対象だが、この issue はテストとソースのコメントだけを対象にする。別 issue で扱う)
- `issues/` 配下の issue への言及 (issue 管理ファイルのため対象外)

## 完了条件

- 上記 3 箇所のコメントから issue という語が消えていること
- 上記 8 箇所のコメントから issue 番号が消えていること
- `rg -n -P '(?<![A-Za-z-])issues?(?![A-Za-z])' tests src devtools --glob '*.ts'` が 0 件になること (この正規表現は `issuer` / `issuedAt` / `re-issue` を除外する)。`.tsx` は対象外とする。`devtools/src/c4m-devtools/App.tsx` の `issue CAT tokens` は動詞「発行する」であり、issue への言及ではない
- `rg -n '\b(0370|0374|0478|0754)\b' tests src --glob '*.ts'` が 0 件になること
- `vite.config.ts` の「TODO/FIXME コメントは issues で管理」は特定の issue を指さない運用の注記として残る (上記の grep の対象外)
- テストの観測内容・判定・実装の挙動が変わっていないこと
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc --noEmit -p devtools` が通ること。ルートと devtools の `tsconfig.json` は `tests/e2e` を型検査しないため、対象ファイルの検証は上記の grep が担う

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

テストとソースのコメントから issue への言及を削除した。

- issue という語を含む 3 箇所を、記録先と理由そのものの記述に変えた
  - `tests/e2e/relay/devtools-publish-stop.spec.ts` は「差が出なかった場合も、relay の実装で結果が変わりうるため、後から比較できるようログに残す」にした
  - `src/session/namespaceLoops.test.ts` は「再現経路は確立後である」にした
  - `src/session/bidiFetchRequestStreamMessages.test.ts` は「(この範囲では」にした
- 番号だけで issue を指す 8 箇所の番号を削除し、番号が補っていた意味を言葉で書いた (`0478` は見出しの文言だけに、`0754` は「数百 ms のずれ」「ずれが固定する」に、`0370` / `0374` は通知と保持の説明だけにした)
- コメントのみを変え、テストの観測内容・判定・実装の挙動は変えていない
- 検証: `rg -n -P '(?<![A-Za-z-])issues?(?![A-Za-z])' tests src devtools --glob '*.ts'` が 0 件、`rg -n '\b(0370|0374|0478|0754)\b' tests src --glob '*.ts'` が 0 件、`vp check` / `vp exec tsc --noEmit` / `vp exec tsc --noEmit -p devtools` / `vp test run` (277 ファイル、5079 テスト) が通る
- `vite.config.ts` の「TODO/FIXME コメントは issues で管理」は特定の issue を指さない運用の注記として残した。`docs/` 配下の issue 番号の参照は別 issue で扱う

`CHANGES.md` は MOQT RFC ドラフト中のため更新していない (`CODEBASE.md` の特別ルール)。

## 参照

- `shiguredo-issues` の「issue 番号・issue への言及をソースコードに持ち込まないこと」
- `tests/e2e/relay/devtools-publish-stop.spec.ts` のファイル先頭 JSDoc とテスト本体
- `src/session/namespaceLoops.test.ts`、`src/session/bidiFetchRequestStreamMessages.test.ts`、`src/session/bidiReadRequestStreamMessages.test.ts`、`src/session/params.test.ts`
- `tests/e2e/relay/audio-timestamp.spec.ts`
- `vite.config.ts` の「TODO/FIXME コメントは issues で管理」
