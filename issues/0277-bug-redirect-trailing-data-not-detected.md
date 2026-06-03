# decodeRequestErrorPayload の Redirect 後続データ未検出

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`decodeRequestErrorPayload` で Redirect をデコードする際に `decodeRedirect` の消費バイト数が無視されており、Redirect の後ろに不正な追加データがあっても検出されないバグを修正する。

## 優先度根拠

悪意あるサーバーが Redirect の後に余計なデータを付与した場合に検出できず、プロトコル違反を見逃す。

## 現状

`src/message/session.ts:372-382`:

```typescript
const [redirect] = decodeRedirect(data.subarray(offset + deltaIdLen));
```

`decodeRedirect` の第二戻り値（消費バイト数）が取得されておらず、remaining の検証が行われていない。

draft-ietf-moq-transport-18 §10.6.2: Redirect は REQUEST_ERROR の最後のフィールドであり、後続データの存在はプロトコル違反。

## 設計方針

- `decodeRedirect` の消費バイト数を取得し、remaining が存在する場合は `ProtocolViolationError` を throw する
- もしくは `decodeRequestErrorPayload` の呼び出し側でペイロード全体の消費を検証する

## 完了条件

- Redirect の後ろに余計なデータがある場合に ProtocolViolationError が throw される
- テストが追加されている
