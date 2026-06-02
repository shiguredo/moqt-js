# REQUEST_OK のコメントから Track Properties フィールドが欠落している

- Priority: Low
- Created: 2026-06-02
- Model: deepseek-v4-pro
- Branch: {Git-Flow のブランチ名}
- Polished: {YYYY-MM-DD}

## 目的

`src/message/session.ts` の `REQUEST_OK Message` コメント内の構造表記から Track Properties フィールドが欠落している。実装自体は正しいためコメント修正のみ。

## 優先度根拠

実装に影響のないコメント不備であり、緊急性はないため Low。

## 現状

`src/message/session.ts:62-68` のコメント:

```
 * REQUEST_OK Message {
 *   Type (vi64) = 0x7,
 *   Length (16),
 *   Number of Parameters (vi64),
 *   Parameters (..),
 * }
```

## 一次資料の引用

draft-ietf-moq-transport-18 §10.5:

```
REQUEST_OK Message {
  Type (vi64) = 0x7,
  Length (16),
  Number of Parameters (vi64),
  Parameters (..) ...,
  Track Properties (..),
}
```

## 設計方針

コメントに `Track Properties (..)` の行を追加するのみ。実装変更不要。

## 完了条件

- REQUEST_OK のコメントに Track Properties フィールドが記載されている
