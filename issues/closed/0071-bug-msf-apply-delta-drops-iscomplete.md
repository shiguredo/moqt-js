# applyCatalogDelta の戻りが isComplete を引き継がない

Created: 2026-04-04
Completed: 2026-04-04
Model: Composer 2 Fast

## なぜこの対応が必要か

[draft-ietf-moq-msf-00 §5.1.7](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.1.7) では、`isComplete` を **一度カタログに追加したら削除してはならない**（MUST NOT）とある。

`applyCatalogDelta` は新しい `Catalog` を返す際、`version` / `tracks` / `generatedAt` のみを設定しており、元の `current.isComplete` を **引き継がない**。差分適用後に終了フラグが落ち、仕様の「削除禁止」と利用者の期待の両方と矛盾しうる。

## 参照

- 実装: `src/msf.ts` の `applyCatalogDelta` の戻り値
- 仕様: [draft-ietf-moq-msf-00 §5.1.7 Is Complete](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.1.7)

## 優先度

確認済み一覧の 4 位（issue 候補 D）。

## 解決方法

`applyCatalogDelta` の戻り値構築部分で `current.isComplete` を引き継ぐよう変更した。

```typescript
if (current.isComplete !== undefined) {
  result.isComplete = current.isComplete;
}
```

`isComplete` が `undefined` の場合は引き継がないため、未設定の状態が正しく伝播する。
