# テストコメントから issue への言及を削除する

- Created: 2026-11-10
- Completed: {YYYY-MM-DD}
- Branch: feature/update-remove-test-issue-reference
- Polished: {YYYY-MM-DD}

## 目的

`tests/e2e/relay/devtools-publish-stop.spec.ts` の先頭コメントに「差が出なかった場合はその事実を issue に記録する」という記述がある。`shiguredo-issues` はソースコード・テスト名・テストコメントから issue への言及を外し、理由そのものを書くことを定めている。テストの意図を issue に依存しない表現にする。

## 現状

- 対象は `tests/e2e/relay/devtools-publish-stop.spec.ts` のファイル先頭 JSDoc の一文「結果をログに残す。差が出なかった場合はその事実を issue に記録する。」
- テストの内容 (Stop Publish の止め方ごとに購読者へ届く終了通知を観測する) は変わらない
- 他のテスト・ソースに同種の issue への言及が残っていないかは、この issue の完了条件で確認する

## 設計方針

- 「issue に記録する」を、記録先を特定しない表現 (「結果を記録して追跡する」など) に変える。観測結果を残す目的は変えない
- 文言の変更だけにとどめ、テストの挙動は変えない
- `rg -n 'issue' tests src devtools --glob '*.ts'` で同種の言及が他に無いことを確認し、あれば同じ方針で直す (issue 番号を指す参照は無い前提。見つかった場合はこの issue で扱う範囲を報告する)

### 対象外

- `docs/` と `issues/` 配下の issue への言及 (規約上許可されている)
- テストの観測内容・判定の変更

## 完了条件

- `tests/e2e/relay/devtools-publish-stop.spec.ts` のコメントから issue への言及が消えていること
- `rg -n 'issue' tests src devtools --glob '*.ts'` の結果に、ソースコードから issue を参照する記述が残っていないこと (残る場合は理由を報告する)
- `vp check` / `vp exec tsc --noEmit` / `vp exec tsc --noEmit -p devtools` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `tests/e2e/relay/devtools-publish-stop.spec.ts` のファイル先頭 JSDoc
- `shiguredo-issues` の「issue 番号・issue への言及をソースコードに持ち込まないこと」
