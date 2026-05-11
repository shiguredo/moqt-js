# `webtransport-devtools/App.tsx` の `copyButtonText` を `useSignal` 化し `App.tsx` の変数使用を統一する

Created: 2026-05-10
Model: Opus 4.7

## 概要

以下の 2 つの一貫性の問題を修正する:

1. `webtransport-devtools/App.tsx:12` の `copyButtonText` がモジュールスコープの `signal("Copy URL")` のまま。メインの `App.tsx` は issue 0143 で `useSignal` に移行済みだが、こちらは未対応。HMR 時に「Copied!」表示が残留する可能性がある。
2. `App.tsx:21` で `const debugPanelOpen = isDebugPanelOpen.value;` と値を抽出しているにもかかわらず、78 行目と 94 行目で `isDebugPanelOpen.value` を再度読んでいる。

## 根拠

- `webtransport-devtools/App.tsx:12`: `const copyButtonText = signal("Copy URL");` がモジュールスコープ
- CHANGES.md:35 の「`App.tsx` の `copyButtonText` をモジュールスコープ signal から `App` コンポーネント内の `useSignal` に移動する」という記述が、どちらの `App.tsx` を指すか曖昧
- `App.tsx:21` で抽出した `debugPanelOpen` を使わず、`App.tsx:78,94` で `isDebugPanelOpen.value` を直接読んでいる

## 修正方針

1. `webtransport-devtools/App.tsx:12` の `signal("Copy URL")` をコンポーネント内の `useSignal("Copy URL")` に変更する
2. `copyUrlToClipboard` 関数もコンポーネント内に移動する（`copyButtonText` のクロージャに依存させる）
3. `webtransport-devtools/App.tsx:55` の `{copyButtonText.value}` は変更不要（すでに `.value` 経由）
4. `App.tsx:78` の `isDebugPanelOpen.value` → `debugPanelOpen` に変更する
5. `App.tsx:94` の `isDebugPanelOpen.value` → `debugPanelOpen` に変更する

## 影響範囲

- `devtools/src/webtransport-devtools/App.tsx`
- `devtools/src/App.tsx`

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する（HMR 時に「Copied!」表示が残留するバグ修正のため）

## 完了条件

- `webtransport-devtools/App.tsx` の `copyButtonText` が `useSignal` 化されている
- `App.tsx` の 78,94 行目が `debugPanelOpen` を使用している
- `vp run build:devtools` が成功する
