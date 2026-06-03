# validateGoawayOnRequestStream を全 GOAWAY 受信箇所で使用する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`validateGoawayOnRequestStream` 関数が定義されているが一度も使用されておらず、全 5 箇所の GOAWAY Request ID チェックがインラインで重複実装されている。このデッドコードを活用し重複を排除する。

## 優先度根拠

デッドコードの存在とコード重複。保守性を損ねている。

## 現状

`src/session/bidi.ts:137-151`:

```typescript
export function validateGoawayOnRequestStream(
  requestId: bigint | null,
  closeSession: (error: SessionError) => void,
): boolean { ... }
```

この関数は export されているが、どのファイルからも import されていない。全 5 箇所で以下の重複コードが存在する:

```typescript
if (decoded.requestId !== null) {
  session.closeWithError(
    new SessionError(
      "goaway on request stream must not include request id",
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return;
}
```

- `bidi.ts:297` (`bidiReadPublishResponse`)
- `bidi.ts:401` (`bidiReadSubscribeResponse`)
- `bidi.ts:498` (`bidiReadFetchResponse`)
- `bidi.ts:556` (`bidiReadTrackStatusResponse`)
- `bidi.ts:660` (`bidiReadRequestStreamMessages`)

## 設計方針

- 全 5 箇所のインライン GOAWAY Request ID チェックを `validateGoawayOnRequestStream` 呼び出しに置き換える

## 完了条件

- `validateGoawayOnRequestStream` が実際に使用されている
- 重複コードが解消されている
