# subscribe.prop.ts の Track Namespace arbitrary の重複を解消する

- Created: 2026-09-08
- Completed: YYYY-MM-DD
- Branch: feature/refactor-subscribe-prop-namespace-arb
- Polished: YYYY-MM-DD

## 目的

`src/message/subscribe.prop.ts` の `namespaceStringsArb` と `trackNamespaceParameterArb` が同一のジェネレータ定義を持つため、一方を変更したときに他方へ反映されず乖離する。共通のジェネレータに集約して保守性を上げる。

## 現状

- `namespaceStringsArb` は `fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 })` を定義する。
- `trackNamespaceParameterArb` も同じジェネレータを使う。
- 用途は異なる（メッセージの `trackNamespace` 用 / 0x34 パラメータ Value 用）が、生成条件は同一である。

## 設計方針

1. 共通の namespace parts ジェネレータを 1 つ定義し、両者から参照する。
2. 用途の違いはコメントで補足する。

## 完了条件

- 重複が解消され、両 arbitrary が同じ namespace parts ジェネレータを参照すること。
- PBT のテストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- `namespaceStringsArb` / `trackNamespaceParameterArb`
- draft-ietf-moq-transport-20 §10.2 / §2.4.1
