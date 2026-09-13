# vite.config.ts の lint.rules から実効性のない 374 エントリを削除する

- Created: 2026-09-13
- Completed: 2026-09-13
- Branch: feature/refactor-trim-lint-rules
- Polished: {YYYY-MM-DD}

## 目的

`vite.config.ts` は 1,110 行あり、うち 1,026 行 (92.4%) が `lint` セクション、さらにそのうち 943 行が `lint.rules` の明示列挙である。

明示列挙された 379 エントリのうち **374 エントリが `lint.categories` の指定だけで既に同じ深刻度に解決されており、設定として何も変えていない**。実効性のない約 900 行が設定ファイルを埋めているため、次の問題が起きている。

- 本当に効いている指定 (オプション付き 4 件と、カテゴリでは実現できない 1 件) が埋もれ、レビュー時に見つけられない
- ルールを 1 つ無効化したいときに、既に `"off"` と書かれているのかカテゴリで決まっているのかを判別できない
- oxlint のカテゴリ分類が更新されたとき、明示列挙が古い分類を固定してしまい、変更に気づけない

## 現状

`vp lint --print-config src/index.ts` で解決後の実効設定を取得し、`lint.rules` の 379 エントリと機械的に突き合わせた結果は次のとおり。

| 区分           | 件数 | 内容                                                                                                                                                                                                |
| -------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 明示 `"error"` | 237  | すべてカテゴリ指定だけで `deny` に解決される                                                                                                                                                        |
| 明示 `"off"`   | 138  | `eslint/prefer-named-capture-group` の 1 件を除き、すべて allow                                                                                                                                     |
| オプション付き | 4    | `max-statements` (`{ max: 100 }`) / `typescript/consistent-indexed-object-style` (`"record"`) / `typescript/consistent-type-definitions` (`"interface"`) / 複数行指定の `typescript/ban-ts-comment` |

`lint.categories` は `correctness` / `perf` / `suspicious` / `pedantic` / `style` を `"error"`、`restriction` を `"off"` としている。

`lint.rules` には「プロジェクト特性上無効化」「プロトコル実装で必要」といった理由コメントが 1 ルールにつき数行付いており、これが 943 行の大半を占める。コメント自体は判断の記録として有用だが、実効性のない指定に付いているため、設定を読むときの探索コストになっている。

`lint.overrides` にも重複がある。`devtools/**` / `examples/**` の 2 ブロックは `lint.ignorePatterns` が両ディレクトリを除外しているため決して適用されない (`vp lint devtools/src/signals/debug.ts` は "No files found to lint." を返す)。`no-console` と `typescript/explicit-function-return-type` の指定はグローバルと完全に重複している。

## 設計方針

1. `lint.rules` に残すのは次の 3 種だけにする。カテゴリ指定では表現できないものだけを残す。
   - オプション付きの 4 件 (`max-statements` / `typescript/consistent-indexed-object-style` / `typescript/consistent-type-definitions` / `typescript/ban-ts-comment`)
   - カテゴリでは allow にならない `eslint/prefer-named-capture-group`
   - 将来 oxlint のカテゴリ分類が変わっても挙動を固定したいルールがある場合のみ、そのルールと理由コメント
2. 削除の判断は推測で行わず、`vp lint --print-config` の解決結果と突き合わせて「指定が解決結果を変えない」ことを機械的に確認する。
3. カテゴリ運用の方針 (どのカテゴリを error にするか) は `lint.categories` とその理由コメントに集約する。ルール単位の理由コメントは、指定を残すものにだけ残す。
4. `lint.overrides` からは、`ignorePatterns` により到達不能な `devtools/**` / `examples/**` の 2 ブロックと、グローバルと重複する指定を削除する。`src/varint.ts` の `oxc/branches-sharing-code` と、テスト向けの実効性のある緩和は残す。
5. 挙動を変えないことを確認する。削除の前後で `vp lint --print-config` の出力を比較し、`lint.rules` / `lint.overrides` 由来の差分が出ないこと、および `vp lint` が通ることを確認する。

## 完了条件

- `lint.rules` のエントリ数が 10 件以下になり、`vite.config.ts` が 300 行以下になっていること。
- 削除前後で `vp lint --print-config` の解決結果が変わっていないこと (設定の意味が保たれていること)。
- `lint.overrides` から到達不能なブロックと完全重複の指定が消えていること。
- `vp lint` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` に該当する変更種別のエントリを追加すること。

## 参照

- `vite.config.ts` (`lint.categories` / `lint.rules` / `lint.overrides` / `lint.ignorePatterns`)
- `issues/0509-update-tsconfig-ci-lint.md` (tsconfig・lint・CI の規約整合。本 issue は `lint.rules` の冗長性のみを扱う)

## 解決方法

起票時に「実効性がない」と判定した `lint.rules` の明示指定は、実際には **設定の中核であり削除できない** ことが検証で判明した。前提が逆であったため、コードを変更せずに closed にする。

### 何を誤ったか

起票前の検証で `vp lint --print-config` の出力と `vite.config.ts` の記述を突き合わせ、「明示 `"error"` 237 件はカテゴリ指定だけで `deny` に解決される」「明示 `"off"` 138 件は既に allow」と結論した。しかしこの突き合わせは、次の 2 点で成立していなかった。

- `--print-config` の出力は 608 ルールだったのに対し、`vite.config.ts` が名指しするルールの多くが出力に現れない。現れないものを「カテゴリで解決済み」と誤って解釈した。
- 明示 `"off"` は「そのルールを allow にする」指定であり、カテゴリの既定値より優先される。カテゴリの既定値と一致するかどうかではなく、**明示指定を外したときに allow のままかを確認しなければならない**。この確認を省略した。

### 実際に検証した結果

`lint.rules` の明示指定を一時的に削除し (`categories` と `overrides` は維持)、`vp lint --print-config` の解決結果と `vp lint` の実行結果を比較した。

1. 削除後の解決結果は 566 ルールになり、**123 ルールの深刻度が allow から deny へ変わった**。`typescript/prefer-readonly-parameter-types` / `typescript/require-await` / `typescript/strict-boolean-expressions` / `unicorn/no-null` / `no-shadow` / `max-depth` / `vitest/no-hooks` などが該当する。
2. 42 ルールが解決結果から消えた。
3. その状態で `vp lint` を実行すると **exit 1** になり、実際に `typescript/prefer-readonly-parameter-types` と `typescript/require-await` の違反が大量に報告された。
4. `vite.config.ts` を元に戻すと `vp lint` は exit 0 に戻り、`--print-config` の解決結果も元の 608 ルールと完全一致した (`vite.config.ts` に差分がないことも確認済み)。

つまり明示指定は、oxlint のカテゴリ分類の既定値から意図的に外れたルールを固定するための指定であり、削除すると 123 ルールが有効化されて lint が通らなくなる。**この issue が目的としていた削減は行ってはならない。**

### 実在した無駄 (本 issue では扱わない)

検証の副産物として、`lint` 設定に次の到達不能な記述があることは確認できた。いずれも数行規模で単独の issue にする規模ではないため、追跡しない。

- `lint.overrides` の `devtools/**` と `examples/**` の 2 ブロックは、`lint.ignorePatterns` が両ディレクトリを除外しているため決して適用されない。`vp lint devtools/src/signals/debug.ts` と `vp lint examples/high-level-api/main.ts` はいずれも "No files found to lint." を返す。
- `lint.plugins` の `"react"` は、`src/` に `.tsx` / `.jsx` が 0 件で、`.tsx` を持つ `devtools/` は上記のとおり lint 対象外であるため発火しない。
