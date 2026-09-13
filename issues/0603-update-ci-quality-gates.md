# CI の品質ゲートを出荷標準に合わせる

- Created: 2026-09-14
- Completed: {YYYY-MM-DD}
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
