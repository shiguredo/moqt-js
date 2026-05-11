# DebugPanel の 4 つの copy ハンドラを `useCopyFeedback` hook に統合する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` の `copyToClipboard` / `copyAllLogs` / `copyPublisherLogs` / `copySubscriberLogs` の 4 関数は、以下の同型コードを 4 回複製している。

```
try {
  await navigator.clipboard.writeText(text);
  setCopiedX(marker);
  setTimeout(() => setCopiedX(null), 1500);
} catch (error) {
  console.error("failed to write to clipboard:", error);
}
```

加えて状態は `copiedIndex: number | null` と `copiedButton: string | null` の 2 系統に分裂しており、setTimeout の ID も保持していない (issue #0170)。これを共通 hook `useCopyFeedback` に統合し、状態管理と timer 解放を一元化する。

## 根拠

- `DebugPanel.tsx:449-505` の 4 関数が完全に同型 (`text` 生成部分のみ異なる)
- `copiedIndex` (number) と `copiedButton` (string) の 2 系統は marker key を文字列に統一すれば 1 つの signal で表現可能
- `setTimeout` の戻り値が未保持で、アンマウント / 連続コピー時にリーク・状態上書きが発生 (issue #0170 の指摘)
- 本 hook 化により issue #0170 の修正を完全に内包できる

## 関連 issue との関係

- issue #0170 (`fix-debug-panel-copy-settimeout-cleanup`): 本 issue の hook 内で timer ref + cleanup を実装することで吸収する。本 issue を先に完了させ、#0170 を close する (close 時に「#0173 に吸収」と理由を明記して `issues/closed/` へ移動する)。
- issue #0172 (`refactor-extract-use-copy-url-button-hook`): `App.tsx` の URL コピー用に独立した hook `useCopyUrlButton` を作る issue。本 issue で導入する `useCopyFeedback` は marker key ベースの汎用 API、#0172 の `useCopyUrlButton` は `buttonText` 文字列を切り替える専用 API で、UI 表現が異なる。両者は独立に存続させ、内部実装を共有しない (#0172 の表現は `"Copy URL" → "Copied!"` の単純トグル、本 hook は marker key による同時複数ボタンの選択ハイライト)。本 issue は #0172 の進捗とは独立に実装可能。
- issue #0149 (closed): 失敗時はフィードバック表示せず `console.error` のみという方針を確定済み。本 issue でもこの方針を踏襲し、「Failed」フィードバックの追加は行わない。

## 修正方針

### 1. `devtools/src/hooks/useCopyFeedback.ts` を新規作成

API シグネチャ (確定):

```ts
import type { ReadonlySignal } from "@preact/signals";

export interface UseCopyFeedbackResult {
  // 現在ハイライト中の marker key (未コピー時は null)
  feedback: ReadonlySignal<string | null>;
  // クリップボードへ書き込み、成功時のみ marker をセットし duration 経過後に null に戻す
  // 戻り値はクリップボード書き込みの成否
  copy: (text: string, markerKey: string) => Promise<boolean>;
}

export function useCopyFeedback(durationMs?: number): UseCopyFeedbackResult;
```

内部実装の要点:

- `const marker = useSignal<string | null>(null);` でフィードバック状態を保持
- `const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);`
- `copy` 内で `clearTimeout(timerRef.current)` してから `setTimeout` を発火させ、ID を `timerRef.current` に代入
- `useEffect(() => () => clearTimeout(timerRef.current), [])` で unmount 時に解放
- `durationMs` の既定値は `1500` (現状の固定値)
- 失敗時は `console.error("failed to write to clipboard:", error)` のみで `marker` は変更しない (issue #0149 の方針を継承)
- `feedback` は `@preact/signals` の `ReadonlySignal<string | null>` 型として返す。実装では `useSignal` の戻り値 `Signal` をそのまま `ReadonlySignal` として型付け代入することで呼び出し側からの直接書き換えを型レベルで禁止する (`useComputed` でのラップは過剰なので使わない)
- `copy` 関数は `useCallback` で stable 化し、戻り値オブジェクト全体も `useMemo` (もしくは `useCallback` のみで `feedback` 自体は signal なので毎回新規生成しない構造) で安定化させ、呼び出し側の `useCallback` 依存配列に `rowFeedback` / `buttonFeedback` を含めても再生成が発生しないようにする

### 2. `DebugPanel.tsx` の改修

- `copiedIndex` / `copiedButton` の `useState` を削除
- `useCopyFeedback` を 2 回呼び出す (行コピー用とボタンコピー用):
  ```ts
  const rowFeedback = useCopyFeedback();
  const buttonFeedback = useCopyFeedback();
  ```
  → 行コピーとボタンコピーは独立して同時に「Copied!」状態になり得るため、hook を分離する。1 つにまとめると相互に上書きしてしまう。
- 4 関数を以下に差し替え (`useCallback` のまま、`text` 生成部分のみ残す):
  - `copyToClipboard`: `rowFeedback.copy(parts.join(" "), String(index))`
  - `copyAllLogs`: `buttonFeedback.copy(generateFullLogText(), "all")`
  - `copyPublisherLogs`: `buttonFeedback.copy(generateFullLogText("[publisher]"), "publisher")`
  - `copySubscriberLogs`: `buttonFeedback.copy(generateFullLogText(\`[${subscriberId}]\`, subscriberId), subscriberId)`
- JSX 側の比較を置き換え:
  - `copiedIndex === originalIndex` → `rowFeedback.feedback.value === String(originalIndex)`
  - `copiedButton === "all"` → `buttonFeedback.feedback.value === "all"`
  - `copiedButton === "publisher"` → `buttonFeedback.feedback.value === "publisher"`
  - `copiedButton === id` → `buttonFeedback.feedback.value === id`
- インポートから不要になった `useState` を整理する (他の用途で残るなら削除しない)

### 3. issue #0170 のクローズ

本 hook 内で timer ref + cleanup を実装しているので、本 issue 完了後に #0170 を `issues/closed/` へ移動し、「## 解決方法」セクションに「#0173 の `useCopyFeedback` hook 化により内包したため close」と明記する。

## 影響範囲

- `devtools/src/hooks/useCopyFeedback.ts` (新規)
- `devtools/src/hooks/useCopyFeedback.test.ts` (新規、後述のテスト用)
- `devtools/src/components/DebugPanel.tsx` (4 関数の差し替え + state 削除 + JSX 比較の置換)
- `issues/0170-fix-debug-panel-copy-settimeout-cleanup.md` (本 issue 完了時に closed へ移動)
- `CHANGES.md`

## テスト戦略

- `vp run test` で全テストがパスすること
- `vp run build:devtools` でビルドが通ること
- `useCopyFeedback` の単体テスト (`useCopyFeedback.test.ts`) を Vitest の Chai API (`test` / `assert`) で追加する。CLAUDE.md の「モックやスタブは利用しない」方針に従い、`navigator.clipboard` をモックせず以下のみ検証する:
  - 初期状態で `feedback.value === null`
  - `copy(...)` を呼んで失敗する環境 (jsdom には `navigator.clipboard` が無いか権限拒否されるため自然に reject される) で、戻り値が `false` を返し、`feedback.value` が `null` のままであること
  - hook の戻り値オブジェクトの `copy` / `feedback` 参照が同一インスタンス間で安定していること (再レンダリング後も同じ参照、これは Preact testing-library を使わず `@preact/signals` の振る舞いで検証する。検証手段が複雑になる場合はこの項目は省略可)
- 手動確認:
  - コピー後 1.5 秒以内に DebugPanel を閉じても Preact 警告が出ないこと
  - 連続コピーで古いタイマーが新しい状態を上書きしないこと
  - 行コピーとボタンコピーが独立してハイライトされること

## CHANGES.md 記載方針

- `## develop` セクション配下の `### misc` サブセクションに `[CHANGE]` で「DebugPanel の 4 つの copy ハンドラを `useCopyFeedback` hook に統合する」を追加する
- 担当者行 (`  - @voluntas` 等) は実装時の担当者で記載する
- issue #0170 を吸収するため、本 issue マージ後は #0170 の CHANGES エントリは追加しない (内包される)。なお内包する旨を本 issue のエントリ本文に明示する必要はない (CHANGES.md は変更内容のみ記載する規約のため)

## 完了条件

- `devtools/src/hooks/useCopyFeedback.ts` が作成され、上記シグネチャを満たす
- `DebugPanel.tsx` から `copiedIndex` / `copiedButton` の `useState` および 4 関数内の `setTimeout` / try/catch が消え、`useCopyFeedback` 経由になっている
- アンマウント時 / 連続コピー時に timer がリークしない (issue #0170 を内包)
- `useCopyFeedback.test.ts` が追加され、`vp run test` が通る
- `vp run build:devtools` が通る
- issue #0170 が `issues/closed/` へ移動され、close 理由が記載されている
- 行コピーとボタンコピーが独立に動作する
- 失敗時にフィードバックを表示しないという issue #0149 の方針が維持されている
