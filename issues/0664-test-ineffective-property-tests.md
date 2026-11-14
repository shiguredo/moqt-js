# 意図した分岐に到達していない Property のテストを直す

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-ineffective-property-tests
- Polished: 2026-11-14

## 目的

テストが意図した分岐を通っていない、または値まで検証していない箇所がある。通っているつもりで通っていないテストは退行を検出できず、安全網として機能しない。

## 現状

- (a) `src/properties.test.ts` の「decodeProperties: 不完全な内側 KVP データで IncompleteDataError を握り潰す」の入力 `[0x0b, 0x02, 0x40, 0x00]` は、内側 `[0x40, 0x00]` が完全な KVP (Type 0x40 / Value 0) である。この実装の varint は leading 1-bits で長さが決まるため `0x40` は 1 バイトで完結し、IncompleteDataError は発生しない。分岐に到達していない
- (a) 現在のテストのコメントは `0x40, 0x00` を「varint の途中で切れている不完全な KVP」と説明しているが、これも実態と一致していない
- (a) 到達する入力の例は `[0x0b, 0x01, 0x80]` である (`0x80` は 2 バイト必要なため内側のデコードが IncompleteDataError になる)。この入力で内側が IncompleteDataError になることは実 `decodeProperties` で確認済み
- (b) `src/properties.prop.ts` の `encodeProperty` のラウンドトリップテスト (偶数 ID / 奇数 ID) は `encoded.length >= 2` しか検証しておらず、`decodeProperties` を呼んでいなかった。これらのテストは commit 61d1b687 (2026-10-13) で削除済みであり、本 issue の (b) はこの削除で解消済みである。追加の対応は不要

## 設計方針

- (a) は分岐に到達する入力 `[0x0b, 0x01, 0x80]` へ差し替え、外側 Property (id=0x0B) の data が内側バイト列 `[0x80]` のまま保存されることまで検証する (内側 KVP は不完全であり、デコード済みの内側の値は存在しない)
- (a) の対比: `decodeProperties` は不完全な内側 KVP を握り潰す。`assertKnownPropertyValueInObjectProperties` は既知 Type の Value / Length の varint が不完全な場合に `SessionError` (MALFORMED_KEY_VALUE) を送出する
- (a) の対比の既存テスト: 上記の後者は既存の `src/properties.test.ts` の「assertKnownPropertyValueInObjectProperties: 既知 Type の Value 不一致で SessionError」と「assertKnownPropertyValueInObjectProperties: 既知 Type の Length 不一致で SessionError」で固定済みである
- (a) の対比の入力: `[0x0b, 0x01, 0x80]` の内側 `[0x80]` は delta Type の varint が不完全であり、`assertKnownPropertyValueInObjectProperties` も寛容契約で握り潰すため、同じ入力では throw しない
- (b) は commit 61d1b687 でテストが削除済みであり、追加の対応は不要である。削除後も `src/properties.test.ts` の `encodeProperty` の固定値テストと `encodeProperties` → `parseProperties` のラウンドトリップテストが残っている

## 完了条件

- (a) のテストが IncompleteDataError の分岐を踏み、外側 Property の id (0x0B) と data (内側バイト列 `[0x80]` が保存されていること) まで検証する
- (a) の対比 (既知 Type の不完全 varint の伝播) が既存テストで固定済みであることを確認する (新規テストの追加は不要)
- (b) のテストが削除済みであることを確認する (追加の対応は不要)
- テストのコメントが入力の実態 (内側 `[0x80]` が不完全な KVP) と一致する
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
