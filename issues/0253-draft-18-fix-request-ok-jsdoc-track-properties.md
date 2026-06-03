# REQUEST_OK の JSDoc wire format 図から Track Properties フィールドが欠落している

- Priority: Low
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`src/message/session.ts` の REQUEST_OK メッセージの JSDoc wire format 図に Track Properties フィールドを追加し、仕様とコードの整合性を取る。

## 優先度根拠

JSDoc コメントの軽微な誤り。`RequestOk` インターフェースやエンコード/デコード処理自体は正しく Track Properties を扱っているため、機能的影響はない。

## 現状

`src/message/session.ts:62-67` の JSDoc に記載された wire format 図：

```
 * REQUEST_OK Message {
 *   Type (vi64) = 0x7,
 *   Length (16),
 *   Number of Parameters (vi64),
 *   Parameters (..),
 * }
```

末尾の `Track Properties (..)` が欠落している。

同ファイルの `decodeRequestOkPayload` の日本語コメント (286-289 行目) には Track Properties が正しく記載されている：

```
 * REQUEST_OK Message {
 *   ...
 *   Track Properties (..),
 * }
```

インターフェース `RequestOk` (69-73 行目) も `trackProperties: Property[]` を正しく含んでいる。

## 設計方針

JSDoc の wire format 図に `Track Properties (..),` を追加する。

## 完了条件

- JSDoc の wire format 図が仕様と一致していること

## 仕様引用

draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK):

```
REQUEST_OK Message {
  Type (i) = 0x7,
  Length (16),
  Number of Parameters (i),
  Parameters (..) ...,
  Track Properties (..),
}
```
