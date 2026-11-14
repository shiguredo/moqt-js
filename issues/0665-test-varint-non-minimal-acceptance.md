# varint モジュールに非最短表現の受理と仕様の具体例を固定するテストが無い

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-varint-non-minimal-acceptance
- Polished: 2026-11-14

## 目的

MOQT の varint は非最短表現を受理しなければならない。実装は受理するが、`src/varint.prop.ts` / `src/varint.test.ts` は最短形のテストしか検証していないため、`decodeVarint` が非最短表現を拒否する変更 (最短性の再検証・正規化など) が入っても、varint モジュールのテストでは検出できない。`src/controlStream.test.ts` には 9 バイトの非最小表現の Length を解析する間接テストがあるが、Table 4 の 8 例の固定テストと非最短表現の PBT は無い。

## 現状

- `src/varint.prop.ts` は「エンコードとデコードのラウンドトリップ」「`varintSize` はエンコード結果のバイト数と一致する」など、`decodeVarint` の入力が `encodeVarint` の出力 (最短形) に限られている
- `src/varint.test.ts` にも非最短表現のテストが無い
- `src/varint.ts` の `decodeVarint` は leading 1-bits から長さを決めるだけで最短性を検査しない。実測で `0x00` / `0x8000` / `0xc00000` / `0xe0000000` はいずれも 0 として受理される (consumed はそれぞれ 1 / 2 / 3 / 4)
- `src/controlStream.test.ts` には 9 バイトの非最小表現の Length を解析するテストがある (`0xff` + `0x00` x 7 + `0x01` で値 1 を表す)。これは `decodeVarint` を間接的に通るが、Table 4 の 8 例の固定テストと非最短表現の PBT は無い

## 設計方針

- 値を任意生成し、その値を表現できる最小の幅 s より大きい幅 t (s < t <= 9) へ詰め直したバイト列を `decodeVarint` が読む PBT を `src/varint.prop.ts` に追加する。9 バイトを必要とする値 (s = 9) はこれ以上広げられないため、PBT の対象は既存の `varintArb` から 9 バイト範囲 (`varint9ByteArb`) を除いた値とし、9 バイト値は固定テストと既存のラウンドトリップで覆う
- 幅 t は `varintSize(value) + 1` 以上 9 以下から生成し、デコード結果の値が元の値と一致し、`consumed` が t と一致することを検証する
- 参照の Table 4 にある 8 例を `src/varint.test.ts` に固定テストとして追加する。8 例すべてが現在の実装で正しくデコードできること (値と消費バイト数の一致) は確認済みである。期待値は Table 4 の Decimal Value 列の値を使い、`bigint` で比較する (特に 2^64-1 は number で正確に表現できない)
- 非最短表現を受理したうえで、エンコード側が最短形を返すことは既存テストのまま維持する

## 完了条件

- 非最短表現の受理がテストで固定され、最短形のみを受理する変更で退行を検出できる
- `npx vp check` / `npx vp test --run` が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §8.1: 「Variable-length integers do not need to be encoded using the minimum number of bytes; any encoding length that can represent the value is valid. ... For example, the value 0 can be encoded as 0x00, 0x8000, 0xc00000, or any longer form.」
- 同 §8.1 Table 4 (Example Integer Encodings) の 8 例: 0x25 / 0x8025 / 0xbbbd / 0xed7f3e7d / 0xfaa1a0e403d8 / 0xfc8998abc66bc0 / 0xfefa318fa8e3ca11 / 0xffffffffffffffffff

## 解決方法

{未着手}
