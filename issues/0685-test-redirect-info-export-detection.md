# 公開型 RedirectInfo の再エクスポートが壊れても検出できない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-redirect-info-export-detection
- Polished: 2026-10-25

## 目的

`src/index.ts` は公開 API の入口であり、値と型の再エクスポートを並べている。型のみの再エクスポートは実行時のモジュール名前空間に現れないため、テストからは観測できない。`type RedirectInfo` はリポジトリ内に import する利用者がおらず、`src/index.ts` の 1 行を削除しても型検査もテストも落ちない。

closed/0645 は `RedirectInfo` を公開再エクスポートに加えた issue であり、「残した課題」に「`type RedirectInfo` の公開再エクスポートは、リポジトリ内に利用者がいないためテストでも `tsc` でも削除を検出できない (公開型再エクスポート全体に共通する性質)」と記録している。公開型が壊れても気付けない状態を解消する。

## 現状

- `src/index.ts` の `./error` からの再エクスポートブロックで `RedirectInfo` を `type` 付きで再エクスポートする。`RedirectInfo` を参照する箇所は `src/error.ts` の `RedirectInfo` 定義と `RequestError.redirect` / `RequestError` のコンストラクタ、コメント 2 件 (`src/session/bidi.ts` の `buildRequestErrorFromDecoded` の JSDoc と `src/session/bidiResponseUncoveredBranches.test.ts` の `RequestError.redirect` を assert する箇所のコメント) だけで、`./index` 経由で import する箇所は無い
- `src/index.ts` の型のみの再エクスポートは 30 ブロック 149 名である
  - `./session` 28 / `./msf` 19 / `./playout/mediaPlayout` 15 / `./createMediaSubscriber` 11 / `./createMediaPublisher` 10 / `./dataStream` 8 / `./message` 8 (型 3 と Authorization Token 5 の 2 ブロック) / `./audioPublishCatchUp` 6 / `./properties` 5 / `./playout/audioPlayoutTimingStats` 5 / `./publisher` 4
  - `./audioSource` 3 / `./playout/audioDelayFeedback` 3 / `./playout/timeline` 3 / `./playout/videoPlayoutSession` 3 / `./moqtUri` 2 / `./subscriber` 2 / `./codec/types` 2 / `./playout/audioPlayoutSession` 2 / `./httpVersion` 1 / `./pendingSubgroupBuffer` 1 / `./fetcher` 1 / `./error` 1 / `./frameSource` 1 / `./playout/audioPlayout` 1 / `./playout/audioReceiveCatchUp` 1 / `./catchUpGate` 1 / `./playout/timingSummary` 1 / `./audioTimestampClock` 1
- `src/index.test.ts` は存在しない。`./index` から import するテストは `src/session.test.ts` の `import { connect } from "./index"` だけで、公開型を固定しているテストは無い
- `tsconfig.json` の `exclude` は `src/**/*.test.ts` と `src/**/*.prop.ts` を除外する。`tsc --noEmit` (`vp run typecheck`) が型検査するのは 151 ファイルで、テスト / PBT のファイルは 0 件である (実測)。`.test.ts` に型レベルの固定を書いても `tsc --noEmit` では検出できない
- `vite.config.ts` の `lint.options.typeAware` / `typeCheck` が有効なため、`vp check` は型検査も行い、テストファイルも対象になる (実測で 593 ファイル)。`.test.ts` に存在しない型を `import type` すると TS2305 で落ちる。`.github/workflows/ci.yml` の lint job は `vp check` を実行し、`prek.toml` の `vp-check` フックも同じ経路を通る
- `src/createMediaPublisher.prop.ts` などの PBT は実行時の不変条件だけを扱うため、型のみの export の有無は観測できない
- `vite-plus/test` は `vitest` を再エクスポートしており、`expectTypeOf` を import できる。実測では型不一致が `vp check` の TS2739 として検出され、`vp test` は実行時に何も起きず成功する
- closed/0645 は受信側の `RequestError.retryInterval` / `redirect` の伝搬を扱った issue であり、公開型の検出可否は対象外のまま残っている

## 設計方針

- `src/index.test.ts` を新設し、公開 API の型再エクスポートを型レベルで固定する。`import type { RedirectInfo } from "./index"` のように `./index` 経由で import し、削除・改名されたら `vp check` が TS2305 で落ちるようにする
- 固定には `expectTypeOf` (`vite-plus/test`) を使う。型レベルのみの検証であり実行時は no-op のため、モック・スタブを使わず既存のテスト流儀 (`import { test, expectTypeOf } from "vite-plus/test"`) に収まる
- `RedirectInfo` は現在の形 (`connectUri: string` / `trackNamespace: Uint8Array[]` / `trackName: Uint8Array`。`src/error.ts` の `RedirectInfo`) を `expectTypeOf` の `toEqualTypeOf` で固定する。フィールドの削除や型の変更も検出できるようにする
- 型のみの再エクスポートは実行時に観測できないという性質が 149 名すべてに共通するため、`RedirectInfo` だけでなく 149 名を 1 ファイルで `import type` して参照する。存在の固定は、149 名を要素に持つ 1 つの型エイリアス (タプル型) を作り、`expectTypeOf` に渡して参照する (削除・改名の検出)。形の固定は、代表例として `RedirectInfo` と `RequestError.redirect` を `expectTypeOf` で固定する (フィールドの削除・型変更の検出)。`RequestError` は値の再エクスポートであり 149 名には含まれないため、形の固定のために同じ `import type` のリストへ加える
- 列挙は `src/index.ts` の型を再エクスポートしているブロック (`export type` と `export { ... type ... }` の両方) と 1 対 1 に対応させ、同じモジュール順・同じグループ構成で並べる。`./message` は型 3 と Authorization Token 5 の 2 ブロックに分かれているため、テストファイルでも 2 グループに分ける。型 export を追加したときにこのファイルへ足す運用であることをファイル冒頭のコメントに書く (追加漏れは型検査では検出できないため)
- 期待する形は `src/error.ts` の定義をそのまま import して比較するのではなく、`./index` 経由の公開型を、公開 API としての契約としてテストファイル内に書いた期待型と比較する (`RedirectInfo` が `connectUri` / `trackNamespace` / `trackName` を持つこと、`RequestError.redirect` が `RedirectInfo | undefined` であること)
- `tsconfig.json` の `exclude` は変更しない。テストを `tsc --noEmit` の対象に含める変更は本 issue の目的に対して過剰であり、`vp check` が既にテストファイルを型検査している
- 検出できることを変異テストで確認する。`src/index.ts` の `./error` からの再エクスポートから `type RedirectInfo` を削除した状態と、`src/error.ts` の `RedirectInfo` のフィールドを 1 つ削った状態、`src/error.ts` の `RequestError.redirect` の型を `RedirectInfo | undefined` 以外に変えた状態で `npx vp check` が落ちることを確認し、確認後は元に戻す
- 対象は `src/index.test.ts` のみとする。実行時の挙動を持つコードは変えないため `CHANGES.md` は変更しない
- テストは日本語のコメントと日本語のテスト名で書き、何を固定しているかをコメントで説明する

## 完了条件

- `src/index.test.ts` が追加され、`./index` から `import type` した公開型を型レベルで固定する
- `src/index.ts` の `./error` からの再エクスポートから `type RedirectInfo` を削除すると `npx vp check` が `Module '"./index"' has no exported member 'RedirectInfo'` (TS2305) で落ちる
- `src/error.ts` の `RedirectInfo` のフィールドを削除または型変更しても `npx vp check` が落ちる
- `src/error.ts` の `RequestError.redirect` の型を `RedirectInfo | undefined` 以外に変えても `npx vp check` が落ちる
- 型のみの再エクスポート 149 名が `src/index.ts` の型を再エクスポートしているブロックと 1 対 1 で列挙されている
- 追加したテストは実行時には何もしない (`npx vp test --run` が通過し、テスト数が 1 件以上増える)
- モック・スタブを追加しない
- `src/index.test.ts` 以外のファイルを変更しない (`CHANGES.md` を含む)
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed/0645 (`RedirectInfo` を公開再エクスポートに加えた issue。本 issue はその「残した課題」) / closed/0654 / closed/0677 (公開 API の変更を伴う issue)
- draft-ietf-moq-transport-22 §9.4.1 (Redirect Structure) / §9.4.2 (REQUEST_ERROR の Redirect は REDIRECT のときだけ存在する)
- `src/index.ts` の再エクスポート、`src/error.ts` の `RedirectInfo` / `RequestError`、`tsconfig.json` の `exclude`、`vite.config.ts` の `lint.options.typeCheck`、`.github/workflows/ci.yml` の lint job と typecheck job、`prek.toml` の `vp-check` / `vp-typecheck` フック

## 解決方法

{未着手}
