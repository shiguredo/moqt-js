# 非最短 varint の受理と仕様の具体例を固定するテストが無い

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-varint-non-minimal-acceptance
- Polished: {YYYY-MM-DD}

## 目的

MOQT の varint は非最短表現を受理しなければならない。実装は受理するが、テストは最短形のラウンドトリップしか検証していないため、最短形だけを通す変更 (正規化・長さの再検証・最短形の再エンコード) が入っても検出できない。

## 現状

- `src/varint.prop.ts` は「エンコードとデコードのラウンドトリップ」「`varintSize` はエンコード結果のバイト数と一致する」など最短形のみを検証している
- `src/varint.test.ts` にも非最短表現のテストが無い
- `src/varint.ts` の `decodeVarint` は leading 1-bits から長さを決めるだけで最短性を検査しない。実測で `0x00` / `0x8000` / `0xc00000` / `0xe0000000` はいずれも 0 として受理される

## 設計方針

- 値を任意生成し、その値を表現できる最小の幅より 1 つ以上大きい表現へ詰め直したバイト列を `decodeVarint` が読む PBT を `src/varint.prop.ts` に追加する
- `decodeVarint` は消費バイト数も返すため、余分に取った幅の分だけ `consumed` が増えることも検証する
- 参照の Table 4 にある 8 例を固定テストにする。8 例すべてが現在の実装で正しくデコードできること (値と消費バイト数の一致) は確認済みである
- 非最短表現を受理したうえで、エンコード側が最短形を返すことは既存テストのまま維持する

## 完了条件

- 非最短表現の受理がテストで固定され、最短形のみを受理する変更で退行を検出できる
- `pnpm test` が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` §8.1: 「Variable-length integers do not need to be encoded using the minimum number of bytes; any encoding length that can represent the value is valid. ... For example, the value 0 can be encoded as 0x00, 0x8000, 0xc00000, or any longer form.」
- 同 §8.1 Table 4 (Example Integer Encodings) の 8 例: 0x25 / 0x8025 / 0xbbbd / 0xed7f3e7d / 0xfaa1a0e403d8 / 0xfc8998abc66bc0 / 0xfefa318fa8e3ca11 / 0xffffffffffffffffff

## 解決方法

{未着手}
