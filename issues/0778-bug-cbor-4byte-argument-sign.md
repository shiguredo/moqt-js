# CBOR デコーダが 4 バイト引数を符号付き 32 ビットで読み、2^31 以上の引数で値が壊れる

- Created: 2026-09-29
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-cbor-4byte-argument-sign
- Polished: 2026-09-29
- Reporter: @voluntas

## 目的

CBOR のデコーダが additional information 26 (4 バイト引数) を符号付き 32 ビットのビット演算で読み込んでいるため、引数が 2^31 以上のときに負の値になる。入力の値とデコード結果が食い違い、再エンコードすると別のデータ項目になる。`src/c4m/cbor.ts` は C4M のトークン (CAT / CWT / COSE) のデコードに使われる外部入力の経路であり、整数 / 長さ / タグが壊れるとトークンの検証結果が変わるため修正する。

根拠:

- `src/c4m/cbor.prop.ts` の「任意のバイト列はデコードできるか CborError になり、デコードできた場合はエンコードが安定する」が flaky であり、develop の CI (run 36525741925 / run 36553066344) の build job でこのテストが失敗している
- CI が報告した counterexample は `1a 80 00 00 38` (4 バイト引数の符号なし整数 2147483704) である。デコード結果は `{ type: "unsigned", value: -2147483592n }` (期待は `2147483704n`) になり、再エンコードは `38` になって再デコードが unexpectedEof で失敗する
- 修正前の挙動を直接確認した:
  - `a1 00 1a 80 00 00 18` (1 要素のマップ、値は 4 バイト引数の符号なし整数 2147483672) のデコード結果は `{ type: "unsigned", value: -2147483624n }` になる
  - `1a 80 00 00 00` は `{ type: "unsigned", value: -2147483648n }` になる (期待は `2147483648n`)。再エンコードは `00`
  - `1a ff ff ff ff` は `{ type: "unsigned", value: -1n }` になり、再エンコードは `ff`
  - `3a 80 00 00 00` は `{ type: "negative", value: -2147483648n }` になり、`cborAsInteger` は `-2147483649n` ではなく `2147483647n` を返す
  - `da 80 00 00 00 00` はタグが `-2147483648n` になり、再エンコードは `c0 00` (タグ 0) になる
  - `5a 80 00 00 00` は長さが負になり trailingBytes で失敗し、`9a 80 00 00 00` は要素数が負になり空の配列としてデコードされる

## 現状

- `src/c4m/cbor.ts` の `CborDecoder.readArgument` は additional information 26 を `((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)` で読み、その結果を `BigInt()` へ渡している
- JavaScript の `<<` / `|` は符号付き 32 ビットの演算であり、結果は 2^31 以上で負になる。`BigInt(-2147483648)` は負の bigint になる
- 影響するのは additional information 26 を使うすべての引数である。整数 (major type 0 / 1)、バイト文字列 / テキスト文字列の長さ (major type 2 / 3)、配列 / マップの要素数 (major type 4 / 5)、タグ (major type 6)
- additional information 27 (8 バイト引数) は 1 バイトずつ BigInt へ積むため影響しない。additional information 25 (2 バイト引数) は 0xffff までしか表さないため影響しない。浮動小数点数の 4 バイト読み込みは `DataView.setUint32` に渡しており、ToUint32 で符号なしに変換されるため影響しない

## 設計方針

- `readArgument` の additional information 26 の読み込みを、additional information 27 と同じ 1 バイトずつの BigInt の積み上げ (`(value << 8n) | BigInt(byte)`) に統一し、符号付き 32 ビットの中間値を作らない
- `src/c4m/cbor.test.ts` に固定値のテストを追加する。2^31 と 2^32 - 1 の符号なし整数 / 負の整数、4 バイト引数のタグ、4 バイト引数の長さを含める
- `src/c4m/cbor.prop.ts` の PBT はこの不具合を検出済みであり、回帰網としてそのまま使う
- この不具合は未リリースの機能 (`## develop` の C4M 追加) で混入したものであり、`CHANGES.md` への追記は行わない (`shiguredo-changelog` の「変更履歴は派生元ブランチとの最終的な差分のみを記載する」に従う)

## 完了条件

- `decodeCbor(new Uint8Array([0x1a, 0x80, 0x00, 0x00, 0x00]))` が `cborUnsigned(2147483648n)` を返す
- 整数 (major type 0 / 1) とタグ (major type 6) の 4 バイト引数が 2^31 以上でも、デコード → エンコード → デコードが元の値と一致する
- 長さ (major type 2 〜 5) の 4 バイト引数が 2^31 以上のとき、負の長さとして扱われず unexpectedEof で失敗する
- `src/c4m/cbor.prop.ts` の 3 つのテストが安定して通過する
- `vp test` と `vp check` が通る

## 解決方法

{未着手}
