# tsconfig・lint・CI の規約整合を修正する

- Created: 2026-09-06
- Completed: 2026-09-14
- Branch: feature/update-tsconfig-ci-lint
- Polished: YYYY-MM-DD

## 目的

型検査と品質ゲートが規約・出荷標準とずれ、問題の集中域が自動検査外になる。設定を整合させる必要がある。

## 現状

- `tsconfig.json` に `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` がなく、`esModuleInterop: true` 明示と `skipLibCheck: true` が規約に反する。`types: []` の明示もない。
- `vite.config.ts` の `lint.ignorePatterns` が devtools / examples / tests を除外し、type-aware lint が src のみに効く。`reportUnusedDisableDirectives` がない。
- CI の typecheck 行列が 5.7〜6.0 + next で、出荷標準 7.0.2 を検証しない。`lint` が `vp lint` のみで fmt 破壊を検出できず、`paths-ignore: **.md` で docs 乖離が素通しになる。

## 設計方針

1. tsconfig を規約の必須チェックに合わせる。
2. lint 対象と CI 行列・ゲートを出荷標準に合わせる (devtools / examples の扱いを決める)。

## 完了条件

- tsconfig が規約の必須チェックを満たすこと。
- lint 対象が devtools / examples / tests に広がっていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## スコープ縮小 (2026-09-14)

CI 側の 3 項目 (typecheck 行列への出荷標準 7.0.2 追加、`lint` ジョブの `vp check` 化、`paths-ignore` の `**.md` / `**.txt` 除外撤廃) は、独立した issue `0603` として切り出して先に実施する。本 issue は tsconfig の厳格化と lint 対象の拡大を扱う。

現状の実測値 (本 issue の残作業量の目安):

- `noUncheckedIndexedAccess: true` を有効にすると型エラーが 73 件出る (`src/varint.ts` など)
- `exactOptionalPropertyTypes: true` を有効にすると型エラーが 62 件出る
- `esModuleInterop: false` にすると型エラーが 1 件出る
- `lint.ignorePatterns` から `devtools/**` / `examples/**` / `tests/**` を外すと、それらのディレクトリの型エラー (devtools は既知で 11 件) と lint 違反が gate 対象になる

これらを一度に直すと変更が広範囲になるため、着手時は「tsconfig の厳格化」と「lint 対象の拡大」をさらに分けることを検討する。

## 進捗 (2026-09-14)

「lint 対象の拡大」と「tsconfig の記述を規約に合わせる部分」を先に実施した (ブランチ `feature/update-tsconfig-ci-lint`)。

実施済み:

- `lint.ignorePatterns` から devtools / examples / tests を外し、`reportUnusedDisableDirectives` を有効にした。あわせて devtools / examples / tests の lint 違反を修正した (挙動は変えない)
- `tsconfig.json` に `types: []` と `skipLibCheck: false` を追加し、`esModuleInterop` を削除した
- lib.dom と重複していた `src/types.d.ts` の宣言 (`self` / `VideoFrameRequestCallback`) を削除し、`DedicatedWorkerGlobalScope` を standalone 宣言に変更した
- devtools / examples の tsconfig に `moqt-js` をソースへ解決する `paths` を追加した (dist 未生成でも型検査できるようにするため)
- `pnpm-workspace.yaml` の overrides を vite-plus 同梱版 (`@voidzero-dev/vite-plus-core@0.3.0` / `vitest@4.1.11`) に揃えた。版がずれていると `@preact/preset-vite` / `@tailwindcss/vite` が返すプラグイン型が別パッケージ由来になり、型比較が破綻して TS2321 / TS2769 になる
- devtools から参照していた `Session.reliability` を公開インターフェースに追加した (実装済みだったが宣言が無く devtools が型エラーになっていた)

残り (未実施。厳格化フラグ 2 件):

- `noUncheckedIndexedAccess: true` を有効にすると型エラーが 73 件 (`src/message/parameter/locationFilter.ts` 14 / `src/session/bidi.ts` 10 / `src/message/parameter/rangeFilter.ts` 10 / `src/varint.ts` 9 / `src/session.ts` 8 ほか)
- `exactOptionalPropertyTypes: true` を有効にすると型エラーが 67 件 (`src/session.ts` 14 / `src/codec/config.ts` 7 / `src/session/bidi.ts` 6 ほか)

どちらも 1 ファイルずつ判断が必要な修正 (ガード追加・条件付きスプレッド・型の見直し) になるため、別の作業単位として扱う。

## 解決方法

tsconfig を規約の必須チェックに合わせ、lint 対象を devtools / examples / tests に広げた。作業は 2 つの PR に分けた (前半は #351)。

### tsconfig (本 PR)

- `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` を有効にした (`types: []` / `skipLibCheck: false` / `esModuleInterop` 削除は #351 で実施済み)
- 型エラー 159 件 (src 95 / devtools 61 / examples 3) を次の方針で修正した
  - 到達しない防御としてのガード追加 (`if (x === undefined) throw new ...Error(...)`)。到達しない理由をコメントに明記
  - index access の回避 (`for...of` / `entries()` / `subarray()` / 分割代入)
  - `exactOptionalPropertyTypes`: 値がある場合だけ載せる条件付き構築
  - 明示的に `undefined` を保持する設計の内部状態 / 文脈オブジェクトと、寛容なデコード結果 (`VideoProperties` / `AudioProperties` / `FetchObjectContext`) は optional フィールドに `| undefined` を付与
- `!` (非 null アサーション) / `as` による握り潰し / `any` / `@ts-expect-error` の追加は 0 件
- テストの期待値変更は 0 件 (index access を分割代入に置き換えた 2 ファイルのみ、アサーションは同一)
- `SessionImpl.initialize` はガード追加で循環的複雑度が上限 (40) を超えたため、`readSetupMessages` / `startPostSetupLoops` / `cancelIfNotConnected` を抽出した。呼び出し順・実行順は同一であることを develop と突き合わせて確認した

### lint 対象の拡大 (#351)

- `vite.config.ts` の `lint.ignorePatterns` から devtools / examples / tests を外し、`reportUnusedDisableDirectives` を有効にした
- devtools / examples の tsconfig に `moqt-js` をソースへ解決する `paths` を追加し、dist 未生成でも型検査できるようにした
- `pnpm-workspace.yaml` の overrides を vite-plus 同梱版に揃えた (版がずれると `@preact/preset-vite` 等のプラグイン型が別パッケージ由来になり型比較が破綻する)
- `Session.reliability` を公開インターフェースに追加した (実装済みだったが宣言が無かった)
- devtools / examples / tests の lint 違反 91 件を修正した

### 検証

- `npx tsc --noEmit` / `npx tsc -p devtools/tsconfig.json --noEmit` / `npx tsc -p examples/tsconfig.json --noEmit`: いずれも 0 件
- `vp test run`: 99 ファイル / 2,189 テスト全通過
- `vp check`: 通過 (862 ファイルの fmt、261 ファイルの lint・型検査)
- `npx playwright test`: 16 件通過。`vp pack` / `vp build devtools` / `vp build examples` 成功
- 公開 API: `vp pack` の実行時輸出 63 件が develop と一致。`dist/index.d.ts` の差分は optional フィールドへの `| undefined` 付与 (後方互換) のみで、破壊的変更は無い
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を 2 件追加した
