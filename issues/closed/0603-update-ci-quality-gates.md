# CI の品質ゲートを出荷標準に合わせる

- Created: 2026-09-14
- Completed: 2026-09-14
- Branch: feature/update-ci-quality-gates
- Polished: {YYYY-MM-DD}

## 目的

CI の品質ゲートが検証内容と実態でずれており、出荷する TypeScript バージョンとドキュメントの整形が CI で検証されない。`0509` のうち CI 側の 3 項目を独立した issue として切り出した。

## 現状

- `.github/workflows/ci.yml` の `typecheck` 行列は `next` / `6.0` / `5.9` / `5.8` / `5.7` の 5 件で、`package.json` が出荷標準として固定している `typescript: 7.0.2` を検証していない。5.7 系は WebCodecs Audio 型の追加時期に合わせた下限であり、上限側の実利用バージョンが抜けている。
- `lint` ジョブは `vp lint` のみを実行しており、整形崩れを検出できない。`vp check` は整形・lint・型をまとめて検証するため、`vp lint` だけでは `0506` のような規約適合 (コメント・メッセージ) の退行を止められない。
- `on.push.paths-ignore` が `**.md` / `**.txt` を除外しているため、ドキュメントのみの変更では CI が一切走らない。`vp check` は Markdown の整形も検証するため、ドキュメントの整形崩れが素通しになる。

## 設計方針

1. `typecheck` 行列に `7.0.2` (出荷標準) を追加する。下限の 5.7 と `next` は互換性の早期検知として残す。
2. `lint` ジョブを `vp check` に変更し、整形・lint・型を 1 ジョブで検証する。
3. `paths-ignore` から `**.md` / `**.txt` を外し、ドキュメントのみの変更でも `vp check` が走るようにする (`LICENSE` / `NOTICE` は除外のまま)。

## 完了条件

- CI の `typecheck` 行列に `typescript: 7.0.2` が含まれること。
- `lint` ジョブが `vp check` を実行していること。
- `paths-ignore` に `**.md` / `**.txt` が残っていないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- `.github/workflows/ci.yml` (`lint` / `typecheck` / `on.push.paths-ignore`)
- `package.json` (`devDependencies.typescript`)
- 関連: `0509` (tsconfig の厳格化と lint 対象拡大は残す)

## 解決方法

`.github/workflows/ci.yml` を 3 点修正した。

### typecheck 行列に出荷標準を追加

行列の先頭に `7.0.2` (`package.json` の `devDependencies.typescript` と同じ値) を追加した。下限の `5.7` (WebCodecs Audio 型が lib.dom.d.ts に追加されたバージョン) と `next` は互換性の早期検知として残している。

### lint ジョブを `vp check` に変更

`vp lint` は整形崩れを検出しないため、`vp check` に変更した。`vp check` は整形・lint・型をまとめて検証する。型は別 job で複数 TypeScript バージョンを検証するため、ここでは出荷標準の 1 バージョンだけが対象になる。

### paths-ignore の見直し

`**.md` / `**.txt` を `paths-ignore` から外した。`vp check` は Markdown の整形も検証するため、ドキュメントのみの変更でも CI を走らせて整形崩れを止める。`LICENSE` / `NOTICE` は体裁を持たない法務文書のため除外のまま残した。

### スコープの分離

`0509` が扱っていた 3 項目のうち CI 側だけを本 issue とし、tsconfig の厳格化と lint 対象の拡大は `0509` に残した。`0509` には実測した残作業量 (`noUncheckedIndexedAccess` で 73 件、`exactOptionalPropertyTypes` で 62 件、`esModuleInterop: false` で 1 件の型エラー) を追記している。

### 検証

- `vp check` 通過 (YAML の整形・lint を含む)
- `tsc --noEmit` 通過
- `vp test run`: 75 ファイル / 2,161 テスト全通過 (コード変更なし)
- CI の変更はワークフロー定義のみであり、実際の検証は本 PR の CI で行う
