# CHANGES.md の develop セクションを規約に適合させる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-changes-md-cleanup
- Polished: {YYYY-MM-DD}

## 目的

`CHANGES.md` の `## develop` が `shiguredo-changelog` の規約から外れている。規約は「派生元ブランチとの最終的な差分のみを記載すること」「開発ブランチ内の中間状態の修正は記載しないこと」を定め、issue 番号の記載も禁止している。このままリリースすると、利用者に意味の伝わらない変更履歴が出る。

## 現状

`## develop` には 382 エントリある。実際に `CHANGES.md` を確認した結果は次のとおり。

- issue 番号 (`(#0NNN)` 形式) が 70 箇所残る。異なる番号は 66 で、`#0316` が 5 回登場する
- 開発中に追加して同じブランチ内で取り消した変更のエントリが残る
  - GOAWAY の Request ID は「削除する」と「追加する」の両方がある
  - `Object Forwarding Preference` の enum を「追加する」エントリがあるが、後に「未使用の export を削除する」で消えており、`src/` に `ObjectForwardingPreference` は存在しない
- `### misc` が develop 内に 3 回出現する。種別順序 (CHANGE → ADD → UPDATE → FIX) も守られておらず、種別が何度も入れ替わる
- 担当者行 `- @voluntas` が無いエントリが 10 件ある。`- @voluntas` を 2 回書いているエントリが 1 件あり、同じ見出しのエントリが重複している例 (`HIGH_LEVEL_API.md を現コードに合わせる`) もある

## 設計方針

- 派生元ブランチとの最終的な差分だけを残す。追加と削除が同じブランチ内で完結している変更のエントリは削除する
- issue 番号を削除する
- 種別ごとに 1 つの `### misc` にまとめ、CHANGE → ADD → UPDATE → FIX の順に並べる
- 各エントリの最後に担当者行を 1 つだけ置く
- 重複したエントリは 1 つに統合する

## 完了条件

- `## develop` から issue 番号が消えている
- 中間状態の記述が統合または削除され、現存しない API のエントリが残っていない
- `### misc` が 1 つになり、種別順序が守られている
- 全エントリに担当者行が 1 つずつある

## 参照

- `CHANGES.md` の `## develop`
- `shiguredo-changelog` (変更種別・エントリのフォーマット・担当者行・中間状態を記載しない規則)

## 解決方法

{未着手}
