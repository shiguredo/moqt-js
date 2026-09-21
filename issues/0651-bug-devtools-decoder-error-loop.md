# devtools の購読側で非対応 codec のときに Worker が再生成され続ける

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-decoder-error-loop
- Polished: {YYYY-MM-DD}

## 目的

devtools の購読側は Catalog が広告する codec をそのまま `VideoDecoder` へ渡し、対応確認をしない。非対応 codec では `VideoDecoder.configure` が同期 throw せず、Worker から `configured` の通知が届いた後に非同期の error が届くため、購読側は configure が成功したものとして扱う。error を受けるたびに `DecoderWrapper.reset()` が Worker を作り直すため、生成と破棄が止まらない。実 Chromium (Playwright 1.63.0 の Chromium 153、ヘッドレス) で `hvc1.1.6.L93.B0` を configure すると 3 秒間に 890 回前後 (毎秒 300 回前後、環境により 850 回程度まで下振れする) の再生成を観測した。`vp09.99.99.99` でも同程度である。同じ codec でも実行環境によっては再現しない (ヘッド付きの Chromium では再生成されなかった)。

購読側の codec は Catalog から来る。devtools の codec 選択 (h265 を含む) は配信側だけが読み、配信側は `VideoEncoder.isConfigSupported` が false なら拒否するため、同一ブラウザの配信と購読の組み合わせでは再現しない。購読側で非対応の codec を広告する publisher へ接続したときに再現する。ループを止め、利用者にエラーを表示する。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は `DecoderWrapper` の error コールバックで `decodeErrors` を増やし、`void decoderInstance.reset()` を呼ぶ。回数の上限も同一 config の禁止も無い
- `devtools/src/utils/DecoderWrapper.ts` の `reset()` は `teardown()` の後に `configure(this.lastConfig)` を呼び、`configureWorker` が `new DecoderWorker()` で Worker を作り直す。`configure` の前に codec の対応確認をしない
- `devtools/src/webcodecs-devtools/workers/decoder.worker.ts` の `init` は `decoder.configure(message.config)` の直後に `configured` を返す。非同期の error はその後に `error` として届く。`configure` の同期 throw を捕まえる経路が無いため、その場合は `configured` が送られず main 側の `configure` の Promise が未解決のまま残り、Worker の `onerror` 経由で error コールバックへ入る
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` は Catalog の codec から config を組み立てるだけで `VideoDecoder.isConfigSupported` を呼ばない。devtools で `VideoDecoder.isConfigSupported` を使うのは `devtools/src/webcodecs-devtools/signals.ts` だけである (音声側の `AudioEncoder` / `AudioDecoder.isConfigSupported` は `devtools/src/codec-test/support.ts` にもある)
- `devtools/src/utils/DecoderWrapper.test.ts` は configure / decode / reset / Worker 往復を Node の vitest では実行できないと明記し、未設定時の状態機械だけを固定している
- 同型の無条件 reset がライブラリ側にもある (`src/codec/VideoDecoder.ts` の `reset()` と `src/createMediaSubscriber.ts` の映像デコーダーの error コールバック)

## 設計方針

- `DecoderWrapper.configure` の先頭で `VideoDecoder.isConfigSupported(config)` を呼び、`supported` が false のときと `isConfigSupported` が throw したとき (不正な codec 文字列) の両方を非対応として扱う。Worker を作らず (直接モードでは `VideoDecoder` を作らず)、`Decoder codec not supported: <codec>` で reject する
- 事前確認は `configure` の 1 箇所に入れ、`configureWorker` を呼ぶ前に main スレッドで判定する (現行は `new DecoderWorker()` を先に実行するため、順序を入れ替える)。Worker モードと直接モードの両方を守り、codec-test ページから実ブラウザで駆動して固定できる
- 利用者への表示は既存の経路を使う。`configure` の reject は `startSubscribing` の外側の catch が受けて status を error にし、statusMessage を `失敗: ...` にするため、新しい表示経路は作らない
- 復帰の上限を入れる。同じ config でエラー後に再初期化するのは、復号フレームを 1 枚も出力しないまま連続 3 回までとし、復号フレームを 1 枚でも出力したら回数を 0 に戻す。予算は再初期化の試行で消費し、`configure` が reject した場合も 1 回分消費する (試行の数であって成功の数ではない)。一時的な decode エラーからの復帰は 1 回で足り、恒久エラーでは実測で毎秒 300 回前後再生成されるため 3 回で十分に止まる
- 回数の管理は `DecoderResetBudget` という純粋クラスとして `devtools/src/utils/DecoderWrapper.ts` から export する (`ConfigureGenerationTracker` と同じ「純粋なロジック + Node テスト、ブラウザ配線は e2e とレビュー」の方針)。`devtools/src/utils/DecoderWrapper.test.ts` で上限・復帰・0 未満防止を固定する
- 予算を 0 に戻すのは、`configure` が `lastConfig` と異なる config を受け取ったときだけとする。`reset()` は同じ `lastConfig` を渡して `configure` に再入するため、この再入で戻すと上限が無効になりループが止まらない
- `reset()` は再初期化したかどうかを `Promise<boolean>` で返し、例外を投げない (`configure` の reject も false として扱う)。上限に達したときと `lastConfig` が無いときは false を返し、Worker もデコーダーも作り直さない
- error コールバックは同期のため、`reset()` の結果は async IIFE で `await` して見る。false なら status を error にし、statusMessage に理由を出して teardown する (既存の `startSubscribing` の外側の catch と同じ終状態)。停止後に上書きしないよう `signal.aborted` を確認する。`useSubscriber` の `void decoderInstance.reset()` は上限判定の結果を受け取る必要があるため、結果を見る経路へ変える
- Worker 側で `configure` の非同期 error を待ってから `configured` を返す設計は採らない。WebCodecs に configure 成功の非同期通知は無く、成否は error コールバックでしか分からないため待てない。同期 throw だけを error 応答に変換し、`configured` より前に error を受け取ったら `configure` の Promise を reject する (未解決のまま残さない)。Worker のメッセージ種別 (`configured` / `decoded` / `skipped` / `error`) は変えない
- 対象外は音声デコーダー (error で reset を呼ばない)、`devtools/src/webcodecs-devtools/signals.ts` の経路 (`isConfigSupported` で事前確認済み)、ライブラリ側 (`src/codec/VideoDecoder.ts` の `reset()` と `src/createMediaSubscriber.ts` の同型ループ) とする。ライブラリ側は別 issue で扱う。`decoder.worker.ts` は購読側と共有するため init の変更は `signals.ts` にも届くが、`signals.ts` は error 応答で `decoderError` / `decoderStatus` を更新する経路を既に持つため表示は改善し、後退しない

## 完了条件

- 非対応 codec (`isConfigSupported` が false、または throw する codec 文字列) では Worker を作らず (直接モードでは `VideoDecoder` を作らず)、`configure` が `Decoder codec not supported: <codec>` で reject する
- 非対応 codec で購読を開始すると再生成ループに入らず、status が error になり statusMessage に理由が出る
- 復号フレームを得ないまま再初期化が続く場合は 3 回で打ち切られ、Worker の再生成が止まる。打ち切りも同じ経路で利用者に表示される
- `reset()` は再初期化の有無を `Promise<boolean>` で返し、例外を投げない。上限到達後と `lastConfig` が無いときは false を返し、Worker もデコーダーも作り直さない
- 予算は `reset()` の再入では戻らず、`lastConfig` と異なる config の `configure` と復号フレームの出力でのみ戻る (これが無いと上限が機能しない)
- 一時的な decode エラーからの復帰 (再初期化 1 回で復号が再開する場合) の挙動が変わらない
- Worker の init で `configure` の同期 throw が error 応答になり、`configured` より前に error を受け取った `configure` の Promise が reject する (未解決のまま残らない)。同じ Worker を使う `signals.ts` の表示が後退しない
- 上限と復帰のカウンタの挙動が `devtools/src/utils/DecoderWrapper.test.ts` で固定される
- 実ブラウザの挙動が `devtools/src/codec-test/` に足すケースと `tests/e2e/codec-wrappers.spec.ts` で固定される。新ケースは `devtools/src/utils/DecoderWrapper.ts` を import し、既存の videoDecoder 系 (ライブラリ側 `src/codec/VideoDecoder.ts` を import するケース) は流用しない。前提として `VideoDecoder.isConfigSupported` が false を返す codec 文字列 (`vp09.99.99.99`) を使い、テスト内で非対応であることを確認してから駆動する。再生成回数の計測は不要で、`configure` の reject・`state` が `unconfigured` のままであること (判定が生成より前にあるため、どちらのモードでも Worker も `VideoDecoder` も存在しない)・`reset()` が上限で false を返すことを pin する。`isConfigSupported` が throw する分岐は `codec: ""` で固定する
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/webcodecs-devtools/signals.ts` (`VideoDecoder.isConfigSupported` で事前確認する既存の例)
- `tests/e2e/codec-wrappers.spec.ts` (codec-test ページを実 Chromium で駆動する既存テスト)
- `src/codec/VideoDecoder.ts` / `src/createMediaSubscriber.ts` (同型の欠陥。ライブラリ側は別 issue)

## 解決方法

{未着手}
