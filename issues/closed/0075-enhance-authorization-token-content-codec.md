# AUTHORIZATION_TOKEN の Token 構造 encode/decode を実装する

Created: 2026-04-19
Model: Claude Opus 4.7

## 概要

`src/message/parameter.ts` の AUTHORIZATION_TOKEN (Parameter Type `0x03`) は現在 Length-prefixed の生バイト列としてしか扱えていない。
`src/session/authTokenCache.ts` に `AuthTokenCache` クラス (REGISTER/USE_ALIAS/DELETE の alias 管理) は用意済みだが、
Token 構造 (Alias Type / Token Alias / Token Type / Token Value) をデコードする術がないため、
`SessionMachine` 側でキャッシュを駆動できない状態となっている。

本 issue では Token 構造そのものの encode/decode を独立モジュールとして追加し、次 issue 以降で
`SessionMachine` の SETUP / 各制御メッセージハンドラから呼べるようにする基盤を整える。

## 背景

issue #0073 の sans-I/O Session プロトコル層導入時に残した課題の 1 つ。
`AuthTokenCache` は用意したが、alias の消費・登録を行う入口となる Token 構造のパーサーが存在しない。

## RFC 根拠

`draft-ietf-moq-transport-17` Section 9.3.2 AUTHORIZATION TOKEN Parameter

```
Token {
  Alias Type (vi64),
  [Token Alias (vi64),]
  [Token Type (vi64),]
  [Token Value (..)]
}
```

| Alias Type | Code | 含まれるフィールド   |
| ---------- | ---- | -------------------- |
| DELETE     | 0x0  | Alias                |
| REGISTER   | 0x1  | Alias + Type + Value |
| USE_ALIAS  | 0x2  | Alias                |
| USE_VALUE  | 0x3  | Type + Value         |

- Token Value の終端は AUTHORIZATION_TOKEN パラメータ本体の length-prefix に従う (残余バイトすべて)。
- Token 構造がデコードできなければ `KEY_VALUE_FORMATTING_ERROR` でセッションを閉じる。

参考: <https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html#section-9.3.2>

## 設計判断

| 項目           | 決定                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| モジュール     | `src/message/authToken.ts` を新設                                                                                              |
| 型             | `AuthTokenAliasType` enum + `AuthToken` discriminated union (`kind` = `"delete"` / `"register"` / `"useAlias"` / `"useValue"`) |
| API            | `encodeAuthToken(token): Uint8Array` / `decodeAuthToken(data): AuthToken`                                                      |
| 数値型         | Token Alias / Token Type は `bigint`、Token Value は `Uint8Array`                                                              |
| エラー         | 既存の `SessionError` / `SessionErrorCode.KEY_VALUE_FORMATTING_ERROR` を使う                                                   |
| パラメータ連携 | 本 issue ではデコーダのみ。SessionMachine への組み込みは別 issue で扱う                                                        |
| テスト         | `authToken.test.ts` (単体) + `authToken.prop.ts` (fast-check PBT)                                                              |

## 作業内容

1. `src/message/authToken.ts` を新設
   - `AuthTokenAliasType` enum (`DELETE = 0`, `REGISTER = 1`, `USE_ALIAS = 2`, `USE_VALUE = 3`)
   - `AuthToken` discriminated union (`kind` に基づく 4 パターン)
   - `encodeAuthToken(token: AuthToken): Uint8Array`
   - `decodeAuthToken(data: Uint8Array): AuthToken`
2. `src/message/authToken.test.ts` で 4 種類の round-trip と異常系 (未知 alias type / 切れ途中) を検証
3. `src/message/authToken.prop.ts` で fast-check の round-trip PBT
4. `src/message/index.ts` から型と関数を re-export
5. `CHANGES.md ## develop` に `[ADD]` として追記

## 影響範囲

- 追加: `src/message/authToken.ts` とテスト
- `src/message/index.ts` に export を追加 (非破壊)
- 既存の `Parameter` の `length-prefixed` 処理は触らない
- SessionMachine / AuthTokenCache の配線は別 issue

Completed: 2026-04-19

## 解決方法

- `src/message/authToken.ts` を新設して `AuthTokenAliasType` enum と `AuthToken` discriminated union (`kind` = `"delete"` / `"register"` / `"useAlias"` / `"useValue"`) を定義した
- `encodeAuthToken(token)` / `decodeAuthToken(data)` を実装し、デコード失敗 (未知 alias type / varint truncation / DELETE・USE_ALIAS の末尾余剰バイト) は `SessionError(KEY_VALUE_FORMATTING_ERROR)` で throw するようにした
- decode 後の `tokenValue` は入力 `Uint8Array` を共有しないようコピーして返す
- `src/message/authToken.test.ts` で 4 種類の round-trip と 4 種類の異常系を検証、`src/message/authToken.prop.ts` で fast-check による round-trip 性質テストと「decode 後の `tokenValue` が入力バッファと独立していること」の性質テストを追加した
- `src/message/index.ts` から `AuthToken` 系の型と `AuthTokenAliasType` / `encodeAuthToken` / `decodeAuthToken` を re-export した
- `vp run typecheck` / `vp run test` (34 files / 431 tests) / `vp run build` (150.39 kB / gzip 30.75 kB) がすべて緑

### 残課題 (別 issue で扱う)

- `SessionMachine` の制御メッセージハンドラから `decodeAuthToken` を呼び出し、`AuthTokenCache` の REGISTER / USE_ALIAS / DELETE 処理と UNKNOWN_AUTH_TOKEN_ALIAS / DUPLICATE_AUTH_TOKEN_ALIAS / AUTH_TOKEN_CACHE_OVERFLOW のエラー応答を配線する
