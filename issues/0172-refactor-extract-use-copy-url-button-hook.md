# `copyUrlToClipboard` を `useCopyUrlButton` hook に抽出する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`App.tsx` と `webtransport-devtools/App.tsx` の 2 箇所に、ほぼ同型の `copyUrlToClipboard` 関数 + `copyButtonText` signal + `useSignal` 初期化が重複している。共通 hook `useCopyUrlButton(buildQueryString)` に切り出して重複を解消する。

## 根拠

- `devtools/src/App.tsx:33-57`: `copyButtonText = useSignal("Copy URL")` + `copyUrlToClipboard` 定義
- `devtools/src/webtransport-devtools/App.tsx:9-35`: 同型実装

## 修正方針

1. `devtools/src/hooks/useCopyUrlButton.ts` を新規作成し、`useCopyUrlButton(buildQueryString: () => string): { buttonText: Signal<string>; copy: () => void }` のような形に切り出す
2. `App.tsx` / `webtransport-devtools/App.tsx` で hook を呼び出すだけにする
3. `setTimeout` の ID 保持 (issue #0170 と同様のリーク防止) は本 hook 内でも対応する

## 影響範囲

- `devtools/src/hooks/useCopyUrlButton.ts` (新規)
- `devtools/src/App.tsx`
- `devtools/src/webtransport-devtools/App.tsx`

## テスト戦略

- `vp run test` で全テストがパスすること
- 新 hook の単体テストを追加 (clipboard API はモックせず実機 (jsdom) では使えないので「buttonText の遷移」程度に絞る)

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する

## 完了条件

- 2 箇所の `copyUrlToClipboard` 実装が共通 hook に統合されている
- 全テストパス
