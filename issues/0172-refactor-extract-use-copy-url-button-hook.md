# `copyUrlToClipboard` を `useCopyUrlButton` hook に抽出する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/App.tsx` と `devtools/src/webtransport-devtools/App.tsx` の 2 箇所に、ほぼ同型の Copy URL ロジック (`copyButtonText` signal + `copyUrlToClipboard` 関数 + `setTimeout` でラベルを元に戻す処理) が重複している。共通 hook `useCopyUrlButton(buildQueryString)` に切り出して重複を解消し、併せて `setTimeout` の ID を保持してアンマウント時に解放する。

## 根拠

### 重複箇所

両者ともロジックは同一だが、`buildQueryString` の import 元と中身が異なる。

- `devtools/src/App.tsx:34-56`
  - `import { buildQueryString } from "./signals/connectionSettings"` (URL/namespace/trackName/codec/auth トークン等、フル設定)
  - `useSignal("Copy URL")` + `copyUrlToClipboard` をコンポーネント内に保持 (issue 0143 で `useSignal` 化済み)
- `devtools/src/webtransport-devtools/App.tsx:13-35`
  - `import { buildQueryString } from "./signals"` (URL と certificateHash のみ)
  - 同様にコンポーネント内に保持 (issue 0152 で `useSignal` 化済み)
- `devtools/src/webcodecs-devtools/App.tsx` には Copy URL ボタンが存在しないため、本 issue の対象外

両 hook 呼び出し側のロジックは以下の点でバイト単位で一致する (`buildQueryString` の参照先以外):

```ts
const queryString = buildQueryString();
const fullUrl = `${window.location.origin}${window.location.pathname}?${queryString}`;
window.history.replaceState(null, "", `?${queryString}`);
navigator.clipboard.writeText(fullUrl).then(
  () => {
    copyButtonText.value = "Copied!";
    setTimeout(() => { copyButtonText.value = "Copy URL"; }, 2000);
  },
  () => {
    copyButtonText.value = "Failed";
    setTimeout(() => { copyButtonText.value = "Copy URL"; }, 2000);
  },
);
```

### 既存の `setTimeout` リーク

現状の実装は `setTimeout` の戻り値 (timeout ID) を保持していないため、以下の問題がある (issue 0170 で `DebugPanel` の copy ハンドラについて同じ問題を整理済み):

1. クリック直後 2 秒以内にコンポーネントがアンマウントされると、`copyButtonText.value = "Copy URL"` の代入がアンマウント後に走る。Preact 10.29.1 はアンマウント後の signal 書き込みで警告を出さないため動作上の致命的問題は無いが、signal が他で購読されていれば誤再描画を誘発する余地がある
2. 2 秒以内にユーザーが再度コピーすると、旧 timer が新しい "Copied!" を 2 秒経過時点で "Copy URL" に上書きしてしまい、ラベルが早期に消える

### 関連 issue

- issues/closed/0143-design-localize-copy-button-text-signal.md (`App.tsx` を `useSignal` 化)
- issues/closed/0152-fix-webtransport-copyButtonText-usignal.md (`webtransport-devtools/App.tsx` を `useSignal` 化)
- issues/0170-fix-debug-panel-copy-settimeout-cleanup.md (`DebugPanel.tsx` の `setTimeout` クリーンアップ。0173 に吸収予定)
- issues/0173-refactor-extract-use-copy-feedback-hook-for-debug-panel.md (DebugPanel 用の汎用 `useCopyFeedback` hook 化)

### 0173 (`useCopyFeedback`) と統合しない理由

本 hook (`useCopyUrlButton`) と 0173 の `useCopyFeedback` は API 用途が異なる:

- `useCopyUrlButton`: ボタン 1 個のラベル文字列 (`"Copy URL"` / `"Copied!"` / `"Failed"`) を直接切り替える。表示状態は単一文字列 `Signal<string>`
- `useCopyFeedback` (0173): `DebugPanel` のログ行コピー / 一括コピー等、**同時に複数のコピー対象**を扱い「どの marker (行 index / ボタン id) が現在ハイライト中か」を `Signal<string | null>` で表現

両者を共通化すると、表現を歪める (例: `useCopyUrlButton` で文字列を marker key に流用すると、`"Copied!"` と `null` の境界が曖昧になる) ため、別 hook として並行で進める。

### setTimeout ID 型の統一

`useRef<ReturnType<typeof setTimeout>>()` で型を取得する。既存の `devtools/src/hooks/useSubscriber.ts:336` も同じ `ReturnType<typeof setTimeout>` イディオムを使っており、本プロジェクト内のパターンに揃える (0170 の `number | undefined` 推奨は撤回し、`ReturnType<typeof setTimeout>` に統一する)。

## 修正方針

### 1. 新規 hook `devtools/src/hooks/useCopyUrlButton.ts` を作成

`devtools/src/hooks/` 配下に置く。MOQT 用と WebTransport 用の両方の `App.tsx` から import する。

シグネチャは以下に確定する。

```ts
import { useSignal, type Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

export interface UseCopyUrlButtonResult {
  /**
   * ボタンに表示する文字列の signal。
   * 初期値は "Copy URL"、成功時に "Copied!"、失敗時に "Failed"、
   * 2 秒後に "Copy URL" に戻る。
   */
  buttonText: Signal<string>;
  /**
   * ボタン onClick に直接渡せる handler。
   * 現在の `buildQueryString()` の結果でクエリを構築し、
   * `window.history.replaceState` で URL を書き換えた上で
   * `navigator.clipboard.writeText` を呼び出す。
   */
  copy: () => void;
}

/**
 * Copy URL ボタンの状態とハンドラを管理する hook。
 *
 * @param buildQueryString 現在の設定からクエリ文字列を構築する関数。
 *   moqt-devtools と webtransport-devtools で実装が異なるため引数で受け取る。
 */
export function useCopyUrlButton(buildQueryString: () => string): UseCopyUrlButtonResult;
```

実装要件:

- `const buttonText = useSignal("Copy URL")` で signal を生成する
- `const timerRef = useRef<ReturnType<typeof setTimeout>>();` で timeout ID を保持する (`Preact.useRef<T>()` は `T | undefined` を返すため `| undefined` の冗長な型注釈と初期値の `undefined` 引数は不要)
- `copy` 内で `clearTimeout(timerRef.current)` してから `timerRef.current = setTimeout(...)` する (連続クリック時の早消え防止)
- `useEffect(() => () => clearTimeout(timerRef.current), [])` でアンマウント時に解放する (リーク防止)
- `copy` 関数は安定参照不要 (`useCallback` 不要)。理由: 子コンポーネントの `memo` 化された props には渡らず、`onClick` ハンドラに直接渡るだけのため、毎レンダで新規参照になっても再レンダコストは生じない
- リセット遅延 (2000ms) と各文言 ("Copy URL" / "Copied!" / "Failed") は hook 内のローカル定数で定義する。引数化はしない
- `navigator.clipboard.writeText` の `.then(onSuccess, onError)` シグネチャを維持する (`catch` ではなく第 2 引数で失敗を捕捉)
- ログ出力は追加しない (元実装にも無いため挙動を変えない)
- `buildQueryString` は `copy` 内で **呼び出し時に毎回実行** する。引数で受けた関数参照は初回レンダ時のクロージャに固定されるが、両 `App.tsx` がモジュールスコープ関数を渡すため実用上の問題は無い

### 2. 呼び出し側の差し替え

`devtools/src/App.tsx`:

- `import { useSignal } from "@preact/signals"` を削除する (hook 側で使うため不要)。
- `import { useCopyUrlButton } from "./hooks/useCopyUrlButton"` を追加する。
- `App` コンポーネント内の `const copyButtonText = useSignal("Copy URL")` と `const copyUrlToClipboard = ...` のブロック (34-56 行目) を以下に置き換える。

```ts
const { buttonText: copyButtonText, copy: copyUrlToClipboard } = useCopyUrlButton(buildQueryString);
```

JSX の `onClick={copyUrlToClipboard}` と `{copyButtonText.value}` はそのまま動作する。

`devtools/src/webtransport-devtools/App.tsx`:

- `import { useSignal } from "@preact/signals"` を削除する。
- `import { useCopyUrlButton } from "../hooks/useCopyUrlButton"` を追加する。
- `copyButtonText` / `copyUrlToClipboard` のブロック (13-35 行目) を同様に hook 呼び出し 1 行に置き換える。

### 3. 配置の根拠

- 既に `devtools/src/hooks/usePublisher.ts` / `useSubscriber.ts` が共通 hooks 置き場として存在する。MOQT 専用ロジックを含むが、UI 共通 hook も同じディレクトリに置いて問題ない。
- `webtransport-devtools/hooks/` (`useAutoScroll.ts` 等) は WebTransport-devtools 専用なので、両エントリポイントが共有する hook を置く先としては不適。

## 影響範囲

- `devtools/src/hooks/useCopyUrlButton.ts` (新規)
- `devtools/src/App.tsx`
- `devtools/src/webtransport-devtools/App.tsx`

## テスト戦略

本リポジトリには `@testing-library/preact` 等の `renderHook` 相当が無く、`devtools/package.json` も Preact 本体のみ。CLAUDE.md でモック・スタブを禁じているため `navigator.clipboard.writeText` の差し替えもできない。よって `copy()` 経路を切り出した単体テストは導入しない (実質的に検証できないため、無価値なテストの追加を避ける)。代わりに以下で担保する。

- `vp run test` を実行し、既存テストが全件通る (退行が無いこと) を確認する。
- `vp run build:devtools` がエラー無くビルドできる (TypeScript 型エラーが無いこと) を確認する。
- 手動確認:
  - `index.html` (MOQT DevTools) で Copy URL ボタンをクリックし、ラベルが「Copied!」に変わり 2 秒後に「Copy URL」へ戻ることを確認する。
  - `webtransport-devtools.html` で同じ確認を行う。
  - ボタンを 2 秒以内に 2 回連続クリックし、最後のクリックから 2 秒間 「Copied!」が表示されたままであること (旧 timer が新表示を即時上書きしないこと) を確認する
  - パネルをマウント/アンマウントする経路 (ページリロード等) でメモリリーク (Chrome DevTools の Performance / Memory タブで `setTimeout` ハンドラが残らないこと) を確認する。Preact では `Cannot set property of unmounted ...` 警告は出ないため、警告の有無での検証はできない

将来 `@testing-library/preact` を導入できた段階で単体テストを追加する余地はあるが、本 issue のスコープ外とする。

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する (内部 hook 抽出と setTimeout 解放、公開 API 後方互換あり)。`[CHANGE]` は CLAUDE.md で「後方互換のない変更」と定義されており、本 issue は devtools 内部の hook 抽出で moqt-js 公開 API には影響しないため `[UPDATE]` が妥当。

エントリ例:

```
- [UPDATE] Copy URL ボタンのロジックを `useCopyUrlButton` hook に抽出し、アンマウント時の `setTimeout` を解放する (#0172)
  - @voluntas
```

## 完了条件

- `devtools/src/hooks/useCopyUrlButton.ts` が新規作成されており、上記シグネチャに一致する。
- `devtools/src/App.tsx` および `devtools/src/webtransport-devtools/App.tsx` 双方から `useSignal` および直接書きの `copyUrlToClipboard` 定義が消え、`useCopyUrlButton(buildQueryString)` 呼び出しに置き換わっている。
- hook 内で `useRef` による timeout ID 管理と `useEffect` cleanup での `clearTimeout` が実装されている。
- `vp run test` および `vp run build:devtools` が成功する。
