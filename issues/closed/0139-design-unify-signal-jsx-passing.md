# JSX への signal 渡し方 (`signal` vs `signal.value`) を統一する

Created: 2026-05-10
Completed: 2026-05-10
Model: Opus 4.7

## 概要

devtools 全体で、JSX 内で signal を表示する書き方が混在している:

- signal をそのまま渡す: `<span>{copyButtonText}</span>` (App.tsx)、`<div>{pub.pubStatusMessage}</div>` (PublisherPanel.tsx)
- `.value` を読んで渡す: `{logs.value.length}` (App.tsx)、`{pub.framesEncoded}` と `{pub.bytesSent.value}` の混在 (PublisherPanel.tsx)

@preact/signals ではどちらでも動くが、コードベース内で揃っていないため可読性とパフォーマンス特性 (前者はテキストノード最適化、後者はコンポーネント全体再描画) が場所ごとに変わってしまう。

## 根拠

- 「テキストノードに表示するだけの単純なケース」は signal を直接渡すほうが Preact + signals らしく、再描画コストも小さい。
- 一方で、計算 (`logs.value.length > 0`) や条件分岐 (`pub.publisher.value !== null`) やオブジェクトへのメソッド呼び出し (`pub.pubSession.value?.getStatistics()`) は `.value` が必須。
- ルールを揃えれば、レビュアーも「`.value` が付いていない箇所はテキスト出力のみ、付いている箇所はロジックあり」と一目で分かる。

## 修正方針

以下のルールでコードベースを揃える:

1. **テキスト出力のみ**: `.value` を付けず signal をそのまま JSX に渡す。
   - 例: `<span>{copyButtonText}</span>`、`<div>{pub.framesEncoded}</div>`
2. **計算/条件/属性/メソッド呼び出しとして使う場合**: `.value` を付ける。
   - 例: `class={debugPanelOpen ? "..." : "..."}`、`{logs.value.length > 0 && ...}`、`{pub.pubSession.value?.getStatistics()}`
3. **関数引数**: signal を関数に渡す場合は `.value` を付ける。
   - 例: `formatBytes(pub.bytesSent.value)` (関数の戻り値が JSX で使われるため、signal を渡すとテキストノード最適化が効かない)

対象ファイルを横断的に走査し、ルールに沿って書き換える。

## 現状の混在状況

| ファイル                        | signal そのまま           | `.value` で読む | 混在度   | 修正要否        |
| ------------------------------- | ------------------------- | --------------- | -------- | --------------- |
| `App.tsx`                       | 1 箇所 (`copyButtonText`) | 3 箇所          | 低       | `.value` に統一 |
| `PublisherPanel.tsx`            | 10 箇所                   | 11 箇所         | **深刻** | `.value` に統一 |
| `SubscriberPanel.tsx`           | 0 箇所                    | 1 箇所 (JSX 外) | なし     | 修正不要        |
| `DebugPanel.tsx`                | 0 箇所                    | 7+ 箇所         | なし     | 修正不要        |
| `ConnectionSettings.tsx`        | 0 箇所                    | 26+ 箇所        | なし     | 修正不要        |
| `webcodecs-devtools/`           | 0 箇所                    | 全箇所          | なし     | 修正不要        |
| `webtransport-devtools/App.tsx` | 1 箇所 (`copyButtonText`) | 0 箇所          | 低       | `.value` に統一 |
| `webtransport-devtools/` 他     | 0 箇所                    | 全箇所          | なし     | 修正不要        |

## 影響範囲

- `devtools/src/App.tsx`: `copyButtonText` を `.value` 経由に変更
- `devtools/src/components/PublisherPanel.tsx`: signal そのまま渡し 10 箇所を `.value` 経由に変更
- `devtools/src/webtransport-devtools/App.tsx`: `copyButtonText` を `.value` 経由に変更

## 依存関係

- 0143 (`copyButtonText` の `useSignal` 化) より先に実装する。0143 実装後は `{copyButtonText.value}` のまま変更不要。

## テスト戦略

- `vp run build:devtools` でビルドが通ることを確認する
- ブラウザで devtools を開き、各パネルの表示が正常であることを手動確認する

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- 全対象ファイルで signal をそのまま JSX に渡している箇所が 0 になる
- `vp run build:devtools` が成功する

## 解決方法

- `App.tsx` の `{copyButtonText}` を `{copyButtonText.value}` に変更した
- `PublisherPanel.tsx` で signal を直接渡している 10 箇所 (`pubStatusMessage` / `pubCodec` / `framesEncoded` / `chunksEncoded` / `keyFramesEncoded` / `encodeErrors` / `objectsSent` / `objectsWithExtensions` / `pubCurrentGroup` / `encoderState`) を `.value` 経由に統一した
- `webtransport-devtools/App.tsx` の `{copyButtonText}` を `{copyButtonText.value}` に変更した
- `vp run build:devtools` が通ることを確認した
