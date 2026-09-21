# 意図した分岐に到達していないテストと検証していないラウンドトリップテストを直す

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-ineffective-property-tests
- Polished: {YYYY-MM-DD}

## 目的

テストが意図した分岐を通っていない、または値まで検証していない箇所がある。通っているつもりで通っていないテストは退行を検出できず、安全網として機能しない。

## 現状

- (a) `src/properties.test.ts` の「decodeProperties: 不完全な内側 KVP データで IncompleteDataError を握り潰す」の入力 `[0x0b, 0x02, 0x40, 0x00]` は、内側 `[0x40, 0x00]` が完全な KVP (Type 0x40 / Value 0) である。この実装の varint は leading 1-bits で長さが決まるため `0x40` は 1 バイトで完結し、IncompleteDataError は発生しない。分岐に到達していない
- (a) 到達する入力の例は `[0x0b, 0x01, 0x80]` である (`0x80` は 2 バイト必要なため内側のデコードが IncompleteDataError になる)。この入力で内側が IncompleteDataError になることは実 `decodeProperties` で確認済み
- (b) `src/properties.prop.ts` の `encodeProperty` のラウンドトリップテスト (偶数 ID / 奇数 ID) は `encoded.length >= 2` しか検証しておらず、`decodeProperties` を呼んでいない。エンコード結果が壊れていても長さが 2 以上なら通る

## 設計方針

- (a) は分岐に到達する入力へ差し替え、値まで検証する。`decodeProperties` は不完全な内側 KVP を握り潰すが、`assertKnownPropertyValueInObjectProperties` は既知 Type の不完全 varint を `SessionError` として伝播させる。この対比もテストで固定し、どちらの挙動が正しいかを読めるようにする
- (b) は `encodeProperty` → `decodeProperties` の実際のラウンドトリップにする。同等の検証が `encodeProperties` → `parseProperties` のラウンドトリップと `src/properties.test.ts` の固定値テストにあるため、削除を選んでも検証は残る

## 完了条件

- (a) のテストが IncompleteDataError の分岐を踏み、内側の値まで検証する
- (a) の対比 (既知 Type の不完全 varint の伝播) がテストで固定される
- (b) のテストが実ラウンドトリップを検証するか、削除されている
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
