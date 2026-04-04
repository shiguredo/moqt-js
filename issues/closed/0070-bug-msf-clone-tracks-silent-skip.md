# cloneTracks で parentName 欠如や親不明を黙って無視する

Created: 2026-04-04
Completed: 2026-04-04
Model: Composer 2 Fast

## なぜこの対応が必要か

本 issue は **論点が 2 つ**ある。混同すると受け入れ条件がぼけるため、区別して扱うこと。

### 論点 A（仕様に直結）

[draft-ietf-moq-msf-00 §5.1.5](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.1.5) では、`cloneTracks` の各トラックオブジェクトに **Parent Name（§5.1.36）が必須** とある（_Each track object MUST include a Parent Name_）。

`parentName` が欠けたオブジェクトを **検証せずに通す** のは、この MUST に対するギャップとして整理できる。

### 論点 B（仕様本文だけでは断定しにくい／設計判断）

`parentName` はあるが **その名前のトラックが現在の `tracks` に存在しない**場合に、エラーにすべきか、黙ってスキップか、別の結果型にするかは、§5.1.5 の一文だけでは **必ずエラー**とは読み取れない。§5.2 の _"successfully applied"_ の解釈も複数ありうる。

ここは **実装方針・設計判断**として明示し、受け入れ条件に書くこと。論点 A と同列の「仕様違反」として束ねない。

現状の実装（`src/msf.ts` の `applyCatalogDelta` 内 `cloneTracks` ループ）は、`parentName` が無い場合も、親が見つからない場合も **何も追加せず終了**する。

## 参照

- 実装: `src/msf.ts` の `applyCatalogDelta` 内 `cloneTracks` ループ
- 仕様: [draft-ietf-moq-msf-00 §5.1.5 Clone tracks](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.1.5)、[§5.2](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.2)
- 根拠テキスト: `refs/moq/draft-ietf-moq-msf-00.txt`（§5.1.5 / §5.2）

## 優先度

確認済み一覧の 3 位（issue 候補 E）。

## 受け入れ条件のメモ

- 論点 A: `parentName` 欠如を **型・実行時検証のどちらで弾くか** を決める。
- 論点 B: 親不明時の挙動を **エラー / Result / ログのみ** などから選び、本文または PR に記載する。

## 解決方法

### 論点 A の対応

`applyCatalogDelta` 内の clone 処理で `parentName` が欠如している場合にエラーをスローするよう変更した。

```typescript
if (!cloneTrack.parentName) {
  throw new Error(`clone track missing parentName: name="${cloneTrack.name}"`);
}
```

### 論点 B の対応

親トラックが存在しない場合もエラーをスローする方針を選択した。デルタ適用の整合性を保つため、曖昧な状態で処理を続行するより明示的なエラーが適切と判断した。

```typescript
if (!baseTrack) {
  throw new Error(`clone track parent not found: parentName="${cloneTrack.parentName}"`);
}
```
