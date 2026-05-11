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

- issue #0167 (DebugPanel ログバッファ刷新): 同じ `DebugPanel.tsx` を改修する。0167 が JSX の描画ループ / `logs.value` → `logBuffer` 置換 / `void logSequence.value;` 追加など広範に変更するため、**0167 → 0173 の順** で実装する。0173 着手時には 0167 マージ後の DebugPanel.tsx を起点として 4 つの copy 関数のみを書き換える
- issue #0170 (`fix-debug-panel-copy-settimeout-cleanup`): 本 issue の hook 内で timer ref + cleanup を実装することで吸収する。**本 issue マージコミット内で `git mv` により `issues/0170-...md` を `issues/closed/` へ移動し、「## 解決方法」セクションに「#0173 の `useCopyFeedback` hook 化により内包」を追記する**。コミットメッセージは `issues: 0173 DebugPanel の copy ハンドラを useCopyFeedback hook に統合し 0170 を吸収する` のように 0170 番号にも言及する
- issue #0172 (`refactor-extract-use-copy-url-button-hook`): `App.tsx` の URL コピー用に独立した hook `useCopyUrlButton` を作る issue。本 issue で導入する `useCopyFeedback` は marker key ベースの汎用 API、#0172 の `useCopyUrlButton` は `buttonText` 文字列を切り替える専用 API で、UI 表現が異なる。両者は独立に存続させ、内部実装を共有しない
- issue #0149 (closed): 失敗時はフィードバック表示せず `console.error` のみという方針を確定済み。本 issue でもこの方針を踏襲する

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
- `const timerRef = useRef<ReturnType<typeof setTimeout>>();` で timeout ID を保持する (0172 と同じイディオム。`Preact.useRef<T>()` は `T | undefined` を返すため `| undefined` 型注釈と初期値 `undefined` 引数は不要)
- `copy` 内で `clearTimeout(timerRef.current)` してから `setTimeout` を発火させ、ID を `timerRef.current` に代入
- `useEffect(() => () => clearTimeout(timerRef.current), [])` で unmount 時に解放
- `durationMs` の既定値は `1500` (現状の固定値)
- 失敗時は `console.error("failed to write to clipboard:", error)` のみで `marker` は変更しない (#0149 の方針継承、既存メッセージを踏襲)
- `feedback` の型は `Signal<string | null>` のまま返す。`ReadonlySignal` への型キャストは `@preact/signals` の型互換性に依存しすぎるため採用しない。呼び出し側に「`copy()` を経由して書き換える」運用ルールを徹底することで読み取り専用の意図を担保する
- `copy` 関数は `useCallback` で stable 化する。理由: `DebugPanel.tsx` の 4 関数 (`copyToClipboard` / `copyAllLogs` / `copyPublisherLogs` / `copySubscriberLogs`) が現状 `useCallback` で stable 化されており、それらの依存配列に `rowFeedback.copy` / `buttonFeedback.copy` を入れる際に毎レンダ再生成だと 4 関数が毎回作り直されるため。0172 (`useCopyUrlButton`) は `App.tsx` の `onClick` 直渡しのため `useCallback` 不要とした方針との非対称は、DebugPanel 側の既存 `useCallback` 採用に揃える判断による
- 依存配列: `copyToClipboard` は `[rowFeedback]` (もしくは `[rowFeedback.copy]`)、`copyAllLogs` / `copyPublisherLogs` / `copySubscriberLogs` は `[buttonFeedback]` (もしくは `[buttonFeedback.copy]`) を指定する

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
- JSX 側の比較を置き換え (各比較は class 指定箇所と表示テキスト箇所の 2 箇所ずつに出現するため、すべての出現箇所を網羅して置換する):
  - `copiedIndex === originalIndex` → `rowFeedback.feedback.value === String(originalIndex)`
  - `copiedButton === "all"` → `buttonFeedback.feedback.value === "all"` (634, 639 行目相当の 2 箇所)
  - `copiedButton === "publisher"` → `buttonFeedback.feedback.value === "publisher"` (644, 649 行目相当の 2 箇所)
  - `copiedButton === id` → `buttonFeedback.feedback.value === id` (656, 661 行目相当の 2 箇所)
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
- `useCopyFeedback` の単体テスト (`useCopyFeedback.test.ts`) を Vitest の Chai API (`test` / `assert`) で追加する。CLAUDE.md の「モック / スタブは利用しない」方針に従い、`navigator.clipboard` をモックせず以下のみ検証する:
  - 初期状態で `feedback.value === null`
  - `copy(...)` を呼んで失敗する環境で戻り値が `false` を返し、`feedback.value` が `null` のままであること。テスト冒頭で `assert(navigator.clipboard === undefined, "test environment must lack navigator.clipboard for this case");` のガードを置き、jsdom 設定変更で `navigator.clipboard` が polyfill された場合はテストを skip するのではなく明示的に fail させる
- hook の戻り値の stable 化検証は Preact 用 `renderHook` が未導入のため本 issue では実施しない。stable 化は `DebugPanel.tsx` の `useCallback` 依存配列が `[rowFeedback]` / `[buttonFeedback]` のみで TypeScript の型推論が通り、ESLint `react-hooks/exhaustive-deps` が警告を出さないことで間接担保する
- 手動確認:
  - コピー後 1.5 秒以内に DebugPanel を閉じても Preact 警告が出ないこと
  - 連続コピーで古いタイマーが新しい状態を上書きしないこと
  - 行コピーとボタンコピーが独立してハイライトされること

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する (devtools 内部 hook 抽出、moqt-js 公開 API 影響なし。CLAUDE.md で `[CHANGE]` は「後方互換のない変更」と定義されており、本 issue は該当しないため `[UPDATE]`)。0172 と方針を揃える。

エントリ例:

```
- [UPDATE] DebugPanel の 4 つの copy ハンドラを `useCopyFeedback` hook に統合し、setTimeout のリーク (#0170) を解消する (#0173)
  - @voluntas
```

#0170 は本 issue のコミット内で `git mv` により closed/ へ移動するため、別エントリは追加しない。

## 完了条件

- `devtools/src/hooks/useCopyFeedback.ts` が作成され、上記シグネチャを満たす
- `DebugPanel.tsx` から `copiedIndex` / `copiedButton` の `useState` および 4 関数内の `setTimeout` / try/catch が消え、`useCopyFeedback` 経由になっている
- アンマウント時 / 連続コピー時に timer がリークしない (issue #0170 を内包)
- `useCopyFeedback.test.ts` が追加され、`vp run test` が通る
- `vp run build:devtools` が通る
- issue #0170 が `issues/closed/` へ移動され、close 理由が記載されている
- 行コピーとボタンコピーが独立に動作する
- 失敗時にフィードバックを表示しないという issue #0149 の方針が維持されている
