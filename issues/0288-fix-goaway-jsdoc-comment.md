# goaway JSDoc コメントを仕様に合わせて修正する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

`Goaway` インターフェースの JSDoc コメントが仕様の記述と不一致。

## 優先度根拠

誤解を招くコメント。将来のメンテナが誤った実装をする可能性がある。

## 現状

`src/message/session.ts:36`:

```
制御ストリーム上では、GOAWAY 送信前に処理された最後の
リクエスト ID より大きい最小の Request ID を設定する。
```

draft-ietf-moq-transport-18 §10.4:

> The smallest peer Request ID that was not or might not have been
> processed prior to sending the GOAWAY.

## 設計方針

- 「処理された最後のリクエスト ID より大きい最小の Request ID」→「処理されなかった可能性がある最小の peer Request ID」に修正する

## 完了条件

- JSDoc コメントが仕様と一致している
