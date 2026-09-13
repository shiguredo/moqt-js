# parameter.ts の偶数型・奇数型コメントを Key-Value-Pair の説明に限定する

- Created: 2026-09-08
- Completed: 2026-09-13
- Branch: feature/fix-parameter-even-odd-comment
- Polished: YYYY-MM-DD

## 目的

`src/message/parameter.ts` のモジュールコメントと `Parameter` インタフェースの JSDoc が「偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列」と §1.4.3 の Key-Value-Pair (Figure 2) 規則を述べている。しかし同じファイルの冒頭は §10.2 の Message Parameter (Figure 4) を掲げており、Message Parameter は Value のエンコーディングをパラメータ型ごとに定義するため、偶数・奇数規則は適用されない。実装とコメントが乖離しており、読み手が Message Parameter にも偶数・奇数規則があると誤解する。

## 現状

- モジュールコメント（`parameter.ts` 冒頭）が「偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列」と記載する。
- `Parameter` インタフェースの JSDoc も同様に「偶数タイプ: varint 値として解釈 / 奇数タイプ: Length プレフィックス付きバイト列」と記載する。
- 実際の Message Parameter の Value は `MESSAGE_PARAMETER_VALUE_ENCODING` で型ごとに決まる。0x09 (location) / 0x21 (self-length-prefixed) / 0x34 (track-namespace) は偶数・奇数規則に当てはまらない。
- `encodeParameter` / `decodeParameter` は Key-Value-Pair (Figure 2) の偶数・奇数規則を実装しており、コメントの規則はそちらに対応する。

## 設計方針

1. 「偶数型 / 奇数型」の説明を、`encodeParameter` / `decodeParameter` / `encodeKeyValuePairs` 系（§1.4.3 Key-Value-Pair）の説明に限定する。
2. Message Parameter の Value は型ごとのエンコーディング定義（`MESSAGE_PARAMETER_VALUE_ENCODING`）で決まる旨を明記する。
3. コードの挙動は変えない。

## 完了条件

- コメントが Message Parameter と Key-Value-Pair のどちらの規則かを取り違えない記述になること。
- コードの挙動が変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.2 / §1.4.3
- `Parameter` / `encodeParameter` / `decodeParameter` / `MESSAGE_PARAMETER_VALUE_ENCODING`

## 解決方法

設計方針 1〜3 に従い、コメントのみを修正した。コードの挙動は変えていない。

### モジュールコメント

- 冒頭の `Type Delta は前のパラメータの Type との差分。偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列` を削除し、draft-ietf-moq-transport-21 §9.20 (Control Message Parameters) の明文に置き換えた。
  - Type Delta は前のパラメータとの差分で、パラメータは Type の昇順に並べる。
  - Value のエンコーディングは各パラメータの定義が個別に定める ("The encoding is specified by each parameter definition.")。本ファイルでは `MESSAGE_PARAMETER_VALUE_ENCODING` が型ごとのエンコーディングを持つ。
- 「偶数型: varint 値 / 奇数型: Length プレフィックス付きバイト列」という規則は §8.3 (Key-Value-Pair Structure) のものであり Message Parameter には適用されない旨と、本ファイルでは Key-Value-Pair を扱う `encodeKeyValuePair` / `decodeKeyValuePair` / `encodeKeyValuePairs` / `decodeKeyValuePairs` が従う旨を明記した。

### `Parameter` インタフェースの JSDoc

- `偶数タイプ: varint 値として解釈 / 奇数タイプ: Length プレフィックス付きバイト列` を削除し、Value のエンコーディングはパラメータ型ごとの定義で決まる (`MESSAGE_PARAMETER_VALUE_ENCODING` を参照) 旨に置き換えた。
- 偶数・奇数規則に当てはまらない例として 0x09 (location) / 0x21 (self-length-prefixed) / 0x34 (track-namespace) を挙げた。

### 実装との整合の確認

`encodeKeyValuePair` (461 行目) が `param.type % 2 === 1` で Length プレフィックスを付ける分岐を持ち、Key-Value-Pair 側が偶数・奇数規則に従っていることを確認した。`MESSAGE_PARAMETER_VALUE_ENCODING` (630 行目) は型ごとに `"varint"` / `"length-prefixed"` を持つ。コメントの記述は実装と一致している。

## 検証

- `pnpm test run`: 70 ファイル / 2,114 テスト全通過 (テストコードの変更なし)
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
- 差分: 2 ファイル、+20 / -7 行
