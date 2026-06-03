# TRACK_STATUS の GOAWAY ハンドリングにコメントを追記する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`bidiReadTrackStatusResponse` (src/session/bidi.ts:453-457) で GOAWAY を受信した場合、pending.reject のみが行われ goawayCallback がない。TRACK_STATUS は単発クエリであり本質的に goawayCallback 不要だが、他のリクエストタイプ (PUBLISH / SUBSCRIBE / FETCH) と一貫性がなく、無いことの意図がコードから読み取れない。

## 優先度根拠

軽微な可読性改善。将来の実装者が「goawayCallback をなぜ追加しないのか」と疑問に思う可能性がある。

## 現状

```typescript
} else if (msg.type === MessageType.GOAWAY) {
  const decoded = decodeGoawayPayload(msg.payload);
  session.pendingTrackStatus.delete(requestId);
  session.requestStreams.delete(requestId);
  pending.reject(
    new Error(`request stream goaway: ${decoded.newSessionUri || "no redirect URI"}`),
  );
}
```

## 設計方針

コメントを追加して、TRACK_STATUS が単発クエリであり、GOAWAY 受信時にマイグレーションが不要である意図を明示する。

```typescript
// TRACK_STATUS は単発クエリのため、GOAWAY 受信時は reject のみ。
// マイグレーション用の goawayCallback は不要。
```

## 完了条件

- GOAWAY 分岐に意図を説明するコメントが追加されていること

## 解決方法

1. `src/session/bidi.ts:451` にコメントを追記する
