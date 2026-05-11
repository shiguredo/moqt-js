# DebugPanel の `formatElapsedTime` / `formatDeltaTime` を pure function 化する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`DebugPanel.tsx` の `formatElapsedTime` / `formatDeltaTime` はコンポーネントスコープに定義され、`firstTimestamp` をクロージャ参照している。一方 `formatAbsoluteTime` はモジュールスコープにある。スコープの分裂が読みにくく、テストもしにくい。

## 根拠

- `DebugPanel.tsx:545-562` 付近で `formatElapsedTime` / `formatDeltaTime` がコンポーネント内に定義
- `firstTimestamp` を引数で受ければ pure function 化可能
- `formatAbsoluteTime` (モジュールスコープ) と整合が取れていない

## 修正方針

1. `devtools/src/components/DebugPanel.tsx` の `formatElapsedTime` / `formatDeltaTime` をモジュールスコープに移動
2. `firstTimestamp` を引数として受け取る pure function に変更
3. 必要なら `devtools/src/components/debugPanelFormatters.ts` などのファイルに分離してテスト可能にする
4. テストを追加 (`debugPanelFormatters.test.ts`)

## 影響範囲

- `devtools/src/components/DebugPanel.tsx`
- `devtools/src/components/debugPanelFormatters.ts` (新規候補)
- `devtools/src/components/debugPanelFormatters.test.ts` (新規)

## テスト戦略

- `vp run test` で全テストがパスすること
- 抽出した formatter の境界値テストを追加

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する

## 完了条件

- formatter 関数がモジュールスコープに移動している
- pure function として呼び出せる
- テストが追加されている
- 全テストパス
