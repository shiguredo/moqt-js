# JSX への signal 渡し方 (`signal` vs `signal.value`) を統一する

Created: 2026-05-10
Model: Opus 4.7

## 概要

devtools 全体で、JSX 内で signal を表示する書き方が混在している:

- signal をそのまま渡す: `<span>{copyButtonText}</span>` (App.tsx)、`<div>{pub.pubStatusMessage}</div>` (PublisherPanel.tsx)
- `.value` を読んで渡す: `{logs.value.length}` (App.tsx)、`{pub.framesEncoded}` と `{pub.bytesSent.value}` の混在 (PublisherPanel.tsx)

@preact/signals ではどちらでも動くが、コードベース内で揃っていないため可読性とパフォーマンス特性 (前者はテキストノード最適化、後者は親再描画) が場所ごとに変わってしまう。

## 根拠

- 「テキストノードに表示するだけの単純なケース」は signal を直接渡すほうが Preact + signals らしく、再描画コストも小さい。
- 一方で、計算 (`logs.value.length > 0`) や条件分岐 (`pub.publisher.value !== null`) は `.value` が必須。
- ルールを揃えれば、レビュアーも「`.value` が付いていない箇所はテキスト出力のみ、付いている箇所はロジックあり」と一目で分かる。

## 修正方針

以下のルールでコードベースを揃える:

1. **テキスト出力のみ**: `.value` を付けず signal をそのまま JSX に渡す。
   - 例: `<span>{copyButtonText}</span>`、`<div>{pub.framesEncoded}</div>`
2. **計算/条件/属性として使う場合**: `.value` を付ける。
   - 例: `class={debugPanelOpen ? "..." : "..."}`、`{logs.value.length > 0 && ...}`
3. `formatBytes(pub.bytesSent.value)` のような関数引数も `.value` を付ける (signal を関数に渡しても評価されない)。

対象ファイルを横断的に走査し、ルールに沿って書き換える。

## 影響範囲

- `devtools/src/App.tsx`
- `devtools/src/components/PublisherPanel.tsx`
- `devtools/src/components/SubscriberPanel.tsx`
- `devtools/src/components/DebugPanel.tsx`
- `devtools/src/components/ConnectionSettings.tsx`
- `devtools/src/webcodecs-devtools/` 配下
- `devtools/src/webtransport-devtools/` 配下
