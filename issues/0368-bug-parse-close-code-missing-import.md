# webtransport-devtools の parseCloseCode の import 漏れでビルドエラーになる

- Created: 2026-08-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-parse-close-code-import
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

webtransport-devtools のビルドエラーを解消する。

## 現状

コミット 1dff8c5 (issue 0367 / PR #126) で `buildCloseInfo` に `parseCloseCode` の呼び出しが追加されたが、`./params` からの import が漏れており、型チェックで `TS2304: Cannot find name 'parseCloseCode'` エラーになる。

## 設計方針

- `devtools/src/webtransport-devtools/params.ts` に定義済みの `parseCloseCode` を、`devtools/src/webtransport-devtools/signals.ts` の既存の import 一覧に追加する
- 新しい関数や型の追加は行わない

## 解決方法

- `devtools/src/webtransport-devtools/signals.ts` の `./params` からの import に `parseCloseCode` を追加する

## 完了条件

- `devtools` の型チェックで `TS2304: Cannot find name 'parseCloseCode'` が消えること
