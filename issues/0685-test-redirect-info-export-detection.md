# 公開型 RedirectInfo の再エクスポートが壊れても検出できない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-redirect-info-export-detection
- Polished: 2026-09-24

## 目的

`src/index.ts` は公開 API の入口であり、値と型の再エクスポートを並べている。型のみの再エクスポートは実行時のモジュール名前空間に現れないため、テストからは観測できない。`type RedirectInfo` はリポジトリ内に import する利用者がおらず、`src/index.ts` の 1 行を削除しても型検査もテストも落ちない。

closed/0645 は `RedirectInfo` を公開再エクスポートに加えた issue であり、「残した課題」に「`type RedirectInfo` の公開再エクスポートは、リポジトリ内に利用者がいないためテストでも `tsc` でも削除を検出できない (公開型再エクスポート全体に共通する性質)」と記録している。公開型が壊れても気付けない状態を解消する。

## 現状

- `src/index.ts` は 79 行目で `RedirectInfo` を `./error` から `type` 付きで再エクスポートする。`RedirectInfo` を参照する箇所は `src/error.ts` の定義 (212 行目) と `RequestError.redirect` (257 行目) / コンストラクタ (261-267 行目)、コメント 2 件 (`src/session/bidi.ts` 898 行目と `src/session/bidiResponseUncoveredBranches.test.ts` 78 行目) だけで、`./index` 経由で import する箇所は無い
- `src/index.ts` の型のみの再エクスポートは 17 ブロック 95 名である (`./session` 23 / `./msf` 18 / `./createMediaPublisher` 9 / `./createMediaSubscriber` 9 / `./message` 8 (型 3 と Authorization Token 5) / `./dataStream` 8 / `./properties` 5 / `./publisher` 4 / `./moqtUri` 2 / `./subscriber` 2 / `./codec/types` 2 / `./httpVersion` 1 / `./pendingSubgroupBuffer` 1 / `./fetcher` 1 / `./error` 1 / `./frameSource` 1)
- `src/index.test.ts` は存在しない。`./index` から import するテストは `src/session.test.ts` (15 行目) の `connect` (値) だけで、公開型を固定しているテストは無い
- `tsconfig.json` は 49 行目で `src/**/*.test.ts` と `src/**/*.prop.ts` を exclude する。`tsc --noEmit` (`vp run typecheck`) が型検査するのは 100 ファイルで、テスト / PBT のファイルは 0 件である (実測)。`.test.ts` に型レベルの固定を書いても `tsc --noEmit` では検出できない
- `vite.config.ts` の `lint.options.typeAware` / `typeCheck` (80-81 行目) が有効なため、`vp check` は型検査も行い、テストファイルも対象になる (実測で 303 ファイル)。`.test.ts` に存在しない型を `import type` すると TS2305 で落ちる。`.github/workflows/ci.yml` の lint job は `vp check` を実行し、`prek.toml` の `vp-check` フックも同じ経路を通る
- `src/createMediaPublisher.prop.ts` などの PBT は実行時の不変条件だけを扱うため、型のみの export の有無は観測できない
- `vite-plus/test` は `vitest` を再エクスポートしており、`expectTypeOf` を import できる。実測では型不一致が `vp check` の TS2739 として検出され、`vp test` は実行時に何も起きず成功する
- closed/0645 は受信側の `RequestError.retryInterval` / `redirect` の伝搬を扱った issue であり、公開型の検出可否は対象外のまま残っている

## 設計方針

- `src/index.test.ts` を新設し、公開 API の型再エクスポートを型レベルで固定する。`import type { RedirectInfo } from "./index"` のように `./index` 経由で import し、削除・改名されたら `vp check` が TS2305 で落ちるようにする
- 固定には `expectTypeOf` (`vite-plus/test`) を使う。型レベルのみの検証であり実行時は no-op のため、モック・スタブを使わず既存のテスト流儀 (`import { test, expectTypeOf } from "vite-plus/test"`) に収まる
- `RedirectInfo` は現在の形 (`connectUri: string` / `trackNamespace: Uint8Array[]` / `trackName: Uint8Array`。`src/error.ts` 212-235 行目) を `expectTypeOf` の `toEqualTypeOf` で固定する。フィールドの削除や型の変更も検出できるようにする
- 型のみの再エクスポートは実行時に観測できないという性質が 95 名すべてに共通するため、`RedirectInfo` だけでなく 95 名を 1 ファイルで `import type` して参照する。存在の固定は型エイリアスからの参照 (削除・改名の検出)、形の固定は代表的な公開型の `expectTypeOf` (フィールドの削除・型変更の検出) の 2 段構えにする
- 列挙は `src/index.ts` の `export type` ブロックと 1 対 1 に対応させ、同じブロック構成で並べる。型 export を追加したときにこのファイルへ足す運用であることをファイル冒頭のコメントに書く (追加漏れは型検査では検出できないため)
- 期待する形は `src/error.ts` の定義をそのまま写すのではなく、公開 API としての契約にする (`RequestError.redirect` が `RedirectInfo | undefined` であること、`RedirectInfo` が `connectUri` / `trackNamespace` / `trackName` を持つこと)
- `tsconfig.json` の exclude は変更しない。テストを `tsc --noEmit` の対象に含める変更は本 issue の目的に対して過剰であり、`vp check` が既にテストファイルを型検査している
- 検出できることを変異テストで確認する。`src/index.ts` から `type RedirectInfo` の行を削除した状態と、`src/error.ts` の `RedirectInfo` のフィールドを 1 つ削った状態で `npx vp check` が落ちることを確認し、確認後は元に戻す
- 対象は `src/index.test.ts` のみとする。実行時の挙動を持つコードは変えないため `CHANGES.md` は変更しない
- テストは日本語のコメントと日本語のテスト名で書き、何を固定しているかをコメントで説明する

## 完了条件

- `src/index.test.ts` が追加され、`./index` から `import type` した公開型を型レベルで固定する
- `src/index.ts` から `type RedirectInfo` の行を削除すると `npx vp check` が `Module '"./index"' has no exported member 'RedirectInfo'` (TS2305) で落ちる
- `src/error.ts` の `RedirectInfo` のフィールドを削除または型変更しても `npx vp check` が落ちる
- 型のみの再エクスポート 95 名が `src/index.ts` のブロックと 1 対 1 で列挙されている
- 追加したテストは実行時には何もしない (`npx vp test --run` が通過し、テスト数が 1 件以上増える)
- モック・スタブを追加しない
- `src/index.test.ts` 以外のファイルを変更しない (`CHANGES.md` を含む)
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed/0645 (`RedirectInfo` を公開再エクスポートに加えた issue。本 issue はその「残した課題」) / 0654 / 0677 (公開 API の変更を伴う未着手 issue)
- draft-ietf-moq-transport-21 §9.4.1 (Redirect Structure) / §9.4.2 (REQUEST_ERROR の Redirect は REDIRECT のときだけ存在する)
- `src/index.ts` の再エクスポート、`src/error.ts` の `RedirectInfo` / `RequestError`、`tsconfig.json` の exclude、`vite.config.ts` の `lint.options.typeCheck`、`.github/workflows/ci.yml` の lint job と typecheck job、`prek.toml` の `vp-check` / `vp-typecheck` フック

## 解決方法

{未着手}
