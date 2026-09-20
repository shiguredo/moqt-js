# コンポーネントテスト基盤 (Vitest Browser Mode) を導入する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/test-component-test-setup
- Polished: {YYYY-MM-DD}

## 目的

devtools の Preact コンポーネント (signal を読んで DOM と canvas を描く層) を検証する手段が無い。`shiguredo-typescript` はコンポーネントテストに Vitest Browser Mode (`*.ct.tsx` + vitest-browser-preact) を使うことを定めているが、このリポジトリには `*.ct.tsx` が 1 つも無く、`vite.config.ts` の `test.include` も `src/**/*.{test,prop}.ts` と `devtools/src/**/*.{test,prop}.ts` のみである。

そのため devtools のコンポーネントは、実リレーが要る E2E か、`page.evaluate` でモジュールを直接 import する E2E でしか検証できず、signal の変更が DOM に反映される経路 (テキストの表示、条件描画、再描画) を単体で固定できない。実際に「音声を受信したときにメーターが表示されるか」は相互運用 harness 側の確認に委ねるしかなかった。

## 現状

- `devtools/src/components/AudioMeter.tsx` (受信した音声のレベルメーターと波形) は、canvas の描画だけを `tests/e2e/devtools-audio-meter.spec.ts` から `drawAudioMeter` を直接呼んで検証している。`useSignalEffect` による再描画と `data-testid` 付きの DOM テキスト (`audio-peak` / `audio-rms` / `audio-level` / `audio-voice-activity`) は検証されていない
- `devtools/src/components/SubscriberPanel.tsx` の条件描画 (`instance.audioSubscriber.value !== null` でメーターを出す) は、E2E では「音声トラックが無いときに出ない」ことしか固定できない
- `devtools/src/testApi.test.ts` は純関数 (`buildSubscriberStats`) のみを検証しており、コンポーネントは対象外
- `vite.config.ts` の `test` に `environment` が無く、jsdom / happy-dom も未導入のため、Preact の描画は Node 環境では検証できない
- 既存の E2E (`tests/e2e/`) は devtools の dev サーバーを起動して実ブラウザで動かすため、コンポーネント 1 つの表示を確認するには重い

## 設計方針

- Vitest Browser Mode (`test.browser`) を導入し、`devtools/src/**/*.ct.tsx` をテスト対象に加える。ブラウザは既存の E2E と同じ Playwright の Chromium を使う
- `vitest-browser-preact` の `render` でコンポーネントを描画し、`@preact/signals` の signal を書き換えて DOM の変化を検証する
- 対象は devtools のコンポーネント (少なくとも `AudioMeter` と `SubscriberPanel` の条件描画) とする。ライブラリ (`src/`) は純関数と Node で動くテストの方針を維持する
- 既存の Node テスト (`*.test.ts`) と Playwright の E2E はそのまま残す。役割は「純関数 = Node の単体テスト」「コンポーネント = Browser Mode」「実リレー = 相互運用 harness」に分ける
- CI に Browser Mode の実行を足す (Playwright のブラウザは既に e2e job で導入している)

## 完了条件

- `npx vp test --run` で `*.ct.tsx` が実行され、`AudioMeter` の DOM テキストと signal 駆動の再描画が固定される
- `SubscriberPanel` の音声メーターの条件描画が signal の書き換えで検証される
- CI のテスト job で Browser Mode が実行される
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level: RFC 6464 §3 の -dBov と voice activity を vi64 の最下位 8 bit に符号化する)
- RFC 6464 §3 (level は -dBov で 0〜127 が 0〜-127 dBov。デジタル無音は 127)

## 解決方法

{未着手}
