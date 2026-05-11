# DebugPanel の 4 つの copy ハンドラを `useCopyFeedback` hook に統合する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`DebugPanel.tsx` の `copyToClipboard` / `copyAllLogs` / `copyPublisherLogs` / `copySubscriberLogs` は同型 (try → clipboard.writeText → setCopiedX(...) → setTimeout(setCopiedX(null), 1500)) で 4 箇所に重複している。共通 hook `useCopyFeedback()` または `copyWithFeedback(text, onMark)` ヘルパに統合する。

## 根拠

- `DebugPanel.tsx:450-506` の 4 関数が同じ構造
- 失敗時に `setCopiedX(null)` で「Failed」表示する分岐も無いため、共通化と同時に失敗フィードバックも追加できる
- `setTimeout` の ID 保持 (issue #0170) と統合可能

## 修正方針

1. `devtools/src/hooks/useCopyFeedback.ts` を新規作成
2. signature 例: `useCopyFeedback(): { feedback: Signal<string | null>; copy: (text: string, markerKey: string) => Promise<void> }`
3. `DebugPanel.tsx` から 4 関数を削除し、hook 経由に統一する
4. UI のフィードバック表示 (`copiedIndex` / `copiedButton`) を hook の `feedback` signal に置き換える
5. 失敗時に「Failed」を 1.5 秒表示する分岐を追加する

## 影響範囲

- `devtools/src/hooks/useCopyFeedback.ts` (新規)
- `devtools/src/components/DebugPanel.tsx`

## テスト戦略

- `vp run test` で全テストがパスすること
- hook の単体テストを追加

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する

## 完了条件

- DebugPanel の 4 関数が共通 hook 経由になっている
- 失敗時に「Failed」フィードバックが表示される
- 全テストパス
