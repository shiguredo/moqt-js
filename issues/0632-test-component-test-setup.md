# コンポーネントテスト基盤 (Vitest Browser Mode) を導入する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/test-component-test-setup
- Polished: 2026-09-29

## 目的

devtools の Preact コンポーネント (signal を読んで DOM と canvas を描く層) を、コンポーネント単体で軽量に検証する手段が無い。`shiguredo-typescript` はコンポーネントテストに Vitest Browser Mode (`*.ct.tsx` + vitest-browser-preact) を使うことを定めているが、このリポジトリには `*.ct.tsx` が 1 つも無く、`vite.config.ts` の `test.include` も `src/**/*.{test,prop}.ts` と `devtools/src/**/*.{test,prop}.ts` のみである。

そのため devtools のコンポーネントは、実リレーが要る E2E か、dev サーバーを起動したうえで `page.evaluate` からモジュールを直接 import する E2E でしか検証できず、signal の変更が DOM に反映される経路 (テキストの表示、表示の切り替え、再描画) を単体で固定できない。「音声トラックを購読したときにメーターの値が実値へ切り替わるか」も、実音声を流す相互運用 harness か、実アプリを起動した E2E に委ねるしかない。

## 現状

- `devtools/src/components/AudioMeter.tsx` (受信した音声のレベルメーターと波形) の canvas 描画は、`tests/e2e/devtools-audio-meter.spec.ts` から `drawAudioMeter` を直接呼んで検証している
- `tests/e2e/devtools-audio-meter.spec.ts` には、`page.evaluate` から `AudioMeter` を import して実ブラウザで描画し、signal を書き換えて DOM テキスト (`layout-audio-peak` 等) と項目の位置・高さを検証するテストもある。ただし dev サーバーの起動が必須で、`*.ct.tsx` のようなコンポーネント単体の仕組みではない
- `devtools/src/components/SubscriberPanel.tsx` は `AudioMeter` を常に描画し (音声トラックを購読していない間も表示し値は「-」)、`active` / `levelActive` (どちらも `instance.audioSubscriber.value !== null`) の切り替えで「-」と実値を出し分ける。E2E では「-」の状態しか固定できない
- `devtools/src/signals/statsSnapshot.test.ts` は純関数 (`buildSubscriberStats`) のみを検証しており、コンポーネントは対象外
- `vite.config.ts` の `test` に `environment` が無く、jsdom / happy-dom も未導入のため、Preact の描画は Node 環境では検証できない
- 既存の E2E (`tests/e2e/`) は devtools の dev サーバーを起動して実ブラウザで動かすため、コンポーネント 1 つの表示を確認するには重い

## 設計方針

- Vitest Browser Mode を導入し、`devtools/src/**/*.ct.tsx` をテスト対象に加える。ブラウザは既存の E2E と同じ Playwright の Chromium を使う。`vitest-browser-preact` (レンダラ) と `@vitest/browser` / `@vitest/browser-playwright` (ブラウザプロバイダ) を固定バージョンで追加する
- 既存の Node テスト (`*.test.ts` / `*.prop.ts`) は Node のまま実行する。単一の `test` 設定で `test.browser` を有効にすると既存テストまでブラウザ実行になるため、`test.projects` での分離または CT 専用の設定を使い、`npx vp test --run` で両方が実行されるようにする
- `vite.config.ts` の lint 緩和パターン (`**/*.test.ts` / `**/*.prop.ts`) に `*.ct.tsx` も含め、`npx vp check` が通る状態にする
- `vitest-browser-preact` の `render` でコンポーネントを描画し、`@preact/signals` の signal を書き換えて DOM の変化を検証する
- 対象は devtools のコンポーネントとし、少なくとも `AudioMeter` (`active` / `levelActive` の切り替えと signal 駆動の canvas 再描画) を含める。`SubscriberPanel` は `subscriberInstances` にインスタンスを登録して描画し、メーターが常に表示され `audioSubscriber` が null の間は「-」であることを固定する範囲とする (実値への切り替えは実音声が必要なため対象外)。ライブラリ (`src/`) は純関数と Node で動くテストの方針を維持する
- 役割は「純関数 = Node の単体テスト」「コンポーネント = Browser Mode」「アプリ全体の結合 = Playwright の E2E」「実リレー = 相互運用 harness」に分ける。`tests/e2e/devtools-audio-meter.spec.ts` のうちコンポーネント単体を検証している部分 (`drawAudioMeter` の描画、`AudioMeter` のレイアウト・テキスト) は `*.ct.tsx` へ移し、アプリ全体を確認する E2E だけを残す (shiguredo-typescript の「コンポーネント単体で検証できるものを E2E テストで書かないこと」に従う)
- CI に Browser Mode の実行を足す。Browser Mode には Playwright Chromium が必要で、`vp test` を実行する build job (`ci.yml`) はブラウザを導入していないため、ブラウザを導入した job (e2e job) で `vp test` を実行するか、Playwright を導入する job を足す

## 完了条件

- `npx vp test --run` で `*.ct.tsx` が実行され、既存の Node テスト (`*.test.ts` / `*.prop.ts`) も従来どおり通る
- `AudioMeter` の DOM テキスト (peak / rms / LOC Audio Level / voice activity) と signal 駆動の canvas 再描画が固定される
- `active` / `levelActive` の切り替えでメーターの値が「-」と実値に切り替わることが固定される
- `SubscriberPanel` のメーターが常に描画され、`audioSubscriber` が null の間は「-」であることが固定される
- `tests/e2e/devtools-audio-meter.spec.ts` からコンポーネント単体の検証が `*.ct.tsx` へ移り、E2E にはアプリ全体の確認だけが残る
- CI のブラウザを導入した job で Browser Mode が実行される
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level: RFC 6464 §3 の -dBov と voice activity を vi64 の最下位 8 bit に符号化する)
- RFC 6464 §3 (level は -dBov で 0〜127 が 0〜-127 dBov。デジタル無音は 127)

## 解決方法

{未着手}
