# encodeVarint が 2^64-1 を超える値を無音でラップする

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-varint-overflow-wrap
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §1.4.1 は可変長整数で「up to 64 bit unsigned integers」のみを定義する。2^64-1 を超える入力が無音で mod 2^64 にラップされ、ワイヤ上で別の有効値として送信されるデータ破壊経路を修正する。

## 現状

- `src/varint.ts` の `encodeVarint()` は負値のみを拒否し、上限チェックがない。9 バイト分岐の各バイトを `& 0xffn` でマスクするため、2^64 以上の入力は上位ビットが切り捨てられる。
- 例: `encodeVarint(2^64)` は `[0xff, 0, 0, 0, 0, 0, 0, 0, 0]` を返し、デコードすると 0 になる。`encodeVarint(2^64 + 5)` は 5 になる。
- `varintSize()` も 8 バイト閾値超を無条件に 9 を返すため、範囲外値を検出しない。
- `src/varint.test.ts` / `src/varint.prop.ts` は 2^64-1 までの値しか生成せず、範囲外入力のテストがない。

## 設計方針

- `encodeVarint()` / `varintSize()` に入力値の上限検証（2^64-1 以下）を追加し、超過時は例外を投げる。
- `encodeVarint()` に渡す前に上限検証がない呼び出し側（`src/message/parameter.ts` の `encodeLocation()` 経由の Location 等）への影響を確認する。各呼び出し側で値域を検証済みのものはそのまま、未検証のものは呼び出し側での検証を追加する。

## 完了条件

- `encodeVarint(2^64)` 等の 2^64-1 超過入力が例外を投げる。
- `varintSize(2^64)` が例外を投げる。
- 範囲外入力のテストが追加されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §1.4.1 (Variable-Length Integers)

## 解決方法

未着手。
