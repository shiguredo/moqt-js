# REQUEST_OK Track Properties 検証の重複コードを共通関数に抽出する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

REQUEST_OK の Track Properties 非空検証ロジックが 3 箇所（4 箇所予定）に分散している。同一の仕様引用と同じ検証ロジックの重複は DRY 原則に違反し、将来の修正時に 3 箇所の同期が必要になる。

対象箇所:

- `src/session/bidi.ts:812-820` (REQUEST_UPDATE_OK)
- `src/session.ts:1797-1805` (SUBSCRIBE_NAMESPACE_OK)
- `src/session.ts:2241-2249` (PUBLISH_NAMESPACE_OK)
- `src/session.ts:2010` (SUBSCRIBE_TRACKS_OK) — 追加予定 (issue #0263)

## 優先度根拠

軽微なリファクタリング。重複除去により保守性が向上する。

## 現状

各箇所で以下のパターンが繰り返されている:

```typescript
if (msg.trackProperties.length > 0) {
  session.closeWithError(
    new SessionError(
      "REQUEST_UPDATE_OK must not contain Track Properties",
      SessionErrorCode.PROTOCOL_VIOLATION,
    ),
  );
  return;
}
```

## 設計方針

共通のバリデーション関数に抽出する:

```typescript
function validateRequestOkNoTrackProperties(
  trackProperties: Property[],
  contextName: string,
  closeSession: (error: SessionError) => void,
): boolean {
  if (trackProperties.length > 0) {
    closeSession(
      new SessionError(
        `track properties must be empty in ${contextName}`,
        SessionErrorCode.PROTOCOL_VIOLATION,
      ),
    );
    return false;
  }
  return true;
}
```

戻り値 `false` で呼び出し元が早期 return できるようにする。

## 完了条件

- 共通関数が定義されていること
- 全 4 箇所が共通関数を使用するよう修正されていること
- エラーメッセージが小文字始まりになっていること (issue #0262 と連携)
- テストが引き続きパスすること

## 解決方法

1. `src/session/params.ts` または `src/session/bidi.ts` に `validateRequestOkNoTrackProperties` を追加する
2. 各呼び出し箇所を共通関数に置き換える
3. テストが通ることを確認する
