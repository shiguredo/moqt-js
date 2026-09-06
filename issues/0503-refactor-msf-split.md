# msf モジュールを機能単位に分割する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/refactor-msf-split
- Polished: YYYY-MM-DD

## 目的

2959 行・公開 59 に 6 機能が同居し、型が flat で packaging 別の MUST を実行時に後付け担保する。分割と型整理が必要である。

## 現状

- `src/msf.ts` に Catalog 入出力・検証・Timeline・変数置換・Fragment・helper が同居する。
- `CatalogTrack` は 37 の optional を flat に並べ、`cast` 代入を多用する。
- `TrackRole` / `CipherSuite` / `AuthInfo` が緩く、判別情報が型に残らない。
- `namespaceMatches` が自明ラッパー、Timeline 系 4 関数と工場 2 件が不要な `async` である。

## 設計方針

1. 機能単位に分割する。
2. `packaging` 判別共用体化等で型レベルの不整合検出を検討する (無理のない範囲で)。
3. 自明ラッパー・不要 `async` を整理する。

## 完了条件

- 機能単位で見通せる分割になること。既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
