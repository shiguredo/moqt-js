# grease.test.ts を PBT に移行する

- Priority: Medium
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/add-grease-pbt
- Polished: 2026-06-04

## 目的

`src/grease.test.ts` の固定値テストを Property-Based Testing (PBT) に移行し、GREASE 値の生成・判定が任意の入力に対して成り立つプロパティを検証する。

## 優先度根拠

`generateGreaseValue` / `isGreaseValue` は `0x7f * N + 0x9D` というパターンに対して、任意の非負整数 N で成り立つべき不変条件を持つ。固定値テストでは代表点しか確認できないため PBT が適している。既存テストも正しく動作しているため Medium。

## 現状

`src/grease.ts` の実装は次の通り (draft-ietf-moq-transport-18 §14 のパターンに準拠)。

```typescript
const GREASE_BASE = 0x9dn;     // 基数
const GREASE_INTERVAL = 0x7fn; // 間隔

export function isGreaseValue(value: bigint): boolean {
  if (value < GREASE_BASE) return false;
  return (value - GREASE_BASE) % GREASE_INTERVAL === 0n;
}

export function generateGreaseValue(n: number): bigint {
  if (n < 0) throw new Error(`GREASE index must be non-negative: ${n}`);
  return GREASE_INTERVAL * BigInt(n) + GREASE_BASE;
}
```

`src/grease.test.ts` は固定値の単体テスト 3 つのみ。

- `generateGreaseValue(0..3)` がそれぞれ `0x9d` / `0x11c` / `0x19b` / `0x21a` になる
- `isGreaseValue` が `0x9d` / `0x11c` / `0x19b` を true、`0x9c` / `0x9e` / `0` を false にする
- `generateGreaseValue(-1)` が throw する

## 仕様根拠

- **draft-ietf-moq-transport-18 §14 (Grease)**: "Grease values follow the pattern 0x7f * N + 0x9D for non-negative integer values of N (that is, 0x9D, 0x11C, ..., 0x3fffffffffffffde)." 実装の `GREASE_BASE = 0x9D` / `GREASE_INTERVAL = 0x7F` はこのパターンと一致する。

参考 URL: https://www.ietf.org/archive/id/draft-ietf-moq-transport-18.html#section-14

## 設計方針

`src/grease.prop.ts` を新規作成し、fast-check で次のプロパティを検証する。

1. **生成 -> 判定の往復**: 任意の `n >= 0` で `isGreaseValue(generateGreaseValue(n)) === true`
2. **定義式との一致**: 任意の `n >= 0` で `generateGreaseValue(n) === 0x7fn * BigInt(n) + 0x9dn`
3. **パターンの剰余不変条件**: 任意の `n >= 0` で `(generateGreaseValue(n) - 0x9dn) % 0x7fn === 0n` (派生として `generateGreaseValue(n) % 0x7fn === 0x9dn % 0x7fn` = `0x1en`)
4. **単調増加**: 任意の `n >= 0` で `generateGreaseValue(n) < generateGreaseValue(n + 1)`
5. **非 GREASE 値の否定**: 任意の `n >= 0` と `1 <= k <= 0x7e` で `isGreaseValue(generateGreaseValue(n) + BigInt(k)) === false`
6. **基数未満の否定**: `0 <= v < 0x9d` の任意の `v` で `isGreaseValue(v) === false`
7. **負数の拒否**: 任意の `n < 0` で `generateGreaseValue(n)` が throw する

既存の固定値テスト 3 つは上記プロパティで完全にカバーされるため、`src/grease.test.ts` は削除して `src/grease.prop.ts` に一本化する。代表的な具体値 (`generateGreaseValue(0) === 0x9dn` 等) を回帰アンカーとして `grease.prop.ts` 内に明示的な assert で残してもよい。

## 変更対象ファイル

- `src/grease.prop.ts`: 新規作成 (PBT)
- `src/grease.test.ts`: 削除
- 機能変更がないため `CHANGES.md` への追記は不要 (テスト構成の変更のみ)

## テスト方針

- ファイル名は `*.prop.ts` 規約に従い `src/grease.prop.ts` とする
- fast-check と Vitest の test / assert を使用する。テストメッセージは日本語で書く
- `n` は `fc.nat()` などで非負整数を生成する。bigint の指数値域全体ではなく実用的な範囲で十分
- モックやスタブは利用しない

## 備考

- 仕様の GREASE 値上限 `0x3fffffffffffffde` (N の上限) を `generateGreaseValue` / `isGreaseValue` は強制していない。これはテスト移行の範囲外であり、上限強制が必要かどうかは GREASE 実装の別 issue (送信側 GREASE は `issues/pending/0037`) で扱う。本 issue はテスト移行のみを対象とする。
- 本 issue はテストの移行であり、`issues/pending/0037` (GREASE 送信機能の実装) とは独立しており衝突しない。

## 完了条件

- `src/grease.prop.ts` で上記プロパティが検証される
- `src/grease.test.ts` が削除され、PBT に一本化されている
- すべてのテストが PASS する
