# goawayCallback 永続化の冗長コメントを削除する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Completed: 2026-06-03

## 目的

`src/session/bidi.ts` の以下の 3 箇所に、コードの動作をそのまま再掲するだけの冗長なコメントが存在する。

```typescript
// PUBLISH 応答の GOAWAY コールバックを Impl に永続化
pending.impl.goawayCallback = pending.goawayCallback;

// SUBSCRIBE 応答の GOAWAY コールバックを Impl に永続化
pending.impl.goawayCallback = pending.goawayCallback;

// FETCH 応答の GOAWAY コールバックを Impl に永続化
pending.impl.goawayCallback = pending.goawayCallback;
```

これらのコメントは「何をしているか」を再掲するだけで、「なぜそうするのか」を説明していない。コードの自己説明的な変数名 (`pending`, `impl`, `goawayCallback`) を見れば代入の意図は明白である。

AGENTS.md:

> コメントはしっかり入れること → RFC ドキュメントへのリンクを必ず記載すること

## 優先度根拠

軽微な可読性改善。コメントがコードの意図を強化するのではなく、ノイズになっている。

## 現状

- `src/session/bidi.ts:190`: `// PUBLISH 応答の GOAWAY コールバックを Impl に永続化`
- `src/session/bidi.ts:257`: `// SUBSCRIBE 応答の GOAWAY コールバックを Impl に永続化`
- `src/session/bidi.ts:374`: `// FETCH 応答の GOAWAY コールバックを Impl に永続化`

## 設計方針

これらのコメントを削除する。代わりに「なぜ delete 前に impl へ移す必要があるのか（後続の request stream message loop で GOAWAY を受信した場合に参照するため）」を説明する 1 つのコメントを、最初の出現箇所にのみ残すか、あるいは完全に削除してコードの自己説明的性質に任せる。

## 完了条件

- 冗長なコメント 3 箇所が削除されていること

## 解決方法

1. `src/session/bidi.ts` の line 190, 257, 374 の冗長コメントを削除する
