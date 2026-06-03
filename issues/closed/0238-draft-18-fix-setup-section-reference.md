# SETUP 統合に関する spec セクション番号の誤りを修正する

- Priority: Low
- Created: 2026-06-03
- Completed: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/fix-setup-section-reference
- Polished: 2026-06-03

## 目的

`types.ts` と `setup.ts` のコメントで CLIENT_SETUP / SERVER_SETUP 統合の参照先が "Section 4" となっているが、正しくは Section 3.3 (Session initialization) である。コメント修正のみ。

## 現状

`src/message/types.ts:11-13`:

```
// draft-ietf-moq-transport-18 Section 4
```

`src/message/setup.ts:7`:

```
// draft-ietf-moq-transport-18 Section 4
```

draft-ietf-moq-transport-18 の Section 4 は "Extensibility" であり、CLIENT_SETUP/SERVER_SETUP の統合とは無関係。

## 設計方針

`Section 4` を `Section 3.3` に修正する。実装変更不要。

## 完了条件

- `types.ts` の SETUP コメントのセクション番号が修正されている
- `setup.ts` のコメントのセクション番号が修正されている
