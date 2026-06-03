# REQUEST_OK エイリアス名が debug.ts で誤っている

- Priority: Low
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Completed: 2026-06-03
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`src/message/debug.ts` の `REQUEST_OK_ALIASES` マッピングを仕様に合わせて修正し、デバッグ表示を正確にする。

## 優先度根拠

デバッグログ表示の品質に関する軽微な不具合。機能的影響はないが、誤った表示は混乱を招くため修正が必要。

## 現状

`src/message/debug.ts:20-29` の `REQUEST_OK_ALIASES` に以下の問題がある：

**誤ったエントリ**:
| 行 | エントリ | 問題 |
|---|---|---|
| 21 | `[MessageType.SUBSCRIBE]: "SUBSCRIBE_OK"` | SUBSCRIBE_OK は独立したメッセージタイプ (0x04)。REQUEST_OK (0x07) のエイリアスではない |
| 23 | `[MessageType.FETCH]: "FETCH_OK"` | FETCH_OK は独立したメッセージタイプ (0x18)。REQUEST_OK のエイリアスではない |
| 27 | `[MessageType.SUBSCRIBE_TRACKS]: "SUBSCRIBE_TRACKS_OK"` | 仕様の公式エイリアスとして定義されていない |

SUBSCRIBE への応答は wire format 上 REQUEST_OK ではなく SUBSCRIBE_OK (0x04)。FETCH への応答は REQUEST_OK ではなく FETCH_OK (0x18)。これらはエイリアスではなく独立したメッセージタイプである。

## 設計方針

仕様で明示的に列挙された 5 つのエイリアスのみを残す：

```
PUBLISH_OK, REQUEST_UPDATE_OK, TRACK_STATUS_OK,
SUBSCRIBE_NAMESPACE_OK, PUBLISH_NAMESPACE_OK
```

修正後のマッピング：

```typescript
const REQUEST_OK_ALIASES: Record<number, string> = {
  [MessageType.PUBLISH]: "PUBLISH_OK",
  0x02: "REQUEST_UPDATE_OK", // MessageType.REQUEST_UPDATE
  [MessageType.TRACK_STATUS]: "TRACK_STATUS_OK",
  [MessageType.PUBLISH_NAMESPACE]: "PUBLISH_NAMESPACE_OK",
  [MessageType.SUBSCRIBE_NAMESPACE]: "SUBSCRIBE_NAMESPACE_OK",
};
```

## 解決方法

`src/message/debug.ts:23-29` の `REQUEST_OK_ALIASES` は既に仕様の 5 エイリアス (`PUBLISH_OK`, `REQUEST_UPDATE_OK`, `TRACK_STATUS_OK`, `SUBSCRIBE_NAMESPACE_OK`, `PUBLISH_NAMESPACE_OK`) のみを含んでいることを確認した。SUBSCRIBE_OK と FETCH_OK はエントリに含まれていない。

## 完了条件

- SUBSCRIBE_OK (0x04) と FETCH_OK (0x18) が REQUEST_OK エイリアスから削除されていること
- 5 つの公式エイリアスのみが定義されていること
- 既存のデバッグ出力に影響がないこと

## 仕様引用

draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK):

> This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK,
> TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK, and PUBLISH_NAMESPACE_OK
> to refer to REQUEST_OK messages on the response stream of each
> request type.
