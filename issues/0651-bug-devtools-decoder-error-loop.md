# devtools の購読側で非対応 codec のときに Worker が再生成され続ける

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-decoder-error-loop
- Polished: 2026-09-23

## 目的

devtools の購読側は Catalog が広告する codec をそのまま `VideoDecoder` へ渡し、対応確認をしない。非対応 codec では `VideoDecoder.configure` が同期 throw せず、Worker から `configured` の通知が届いた後に非同期の error が届くため、購読側は configure が成功したものとして扱う。error を受けるたびに `DecoderWrapper.reset()` が Worker を作り直すため、生成と破棄が止まらない。実 Chromium (Playwright 1.63.0 の Chromium 153、ヘッドレス) で `hvc1.1.6.L93.B0` を configure すると 3 秒間に 890 回前後の再生成を観測した。別の測定では 2,000 回台まで増え、環境により再生成が観測されない場合もあった。`vp09.99.99.99` でも同程度だった。回数そのものに実装は依存させず、再生成が止まらないことを問題として扱う。

購読側の codec は Catalog から来る。devtools の codec 選択 (h265 を含む) は配信側だけが読み、配信側は `VideoEncoder.isConfigSupported` が false なら拒否するため、devtools の UI 経由では配信側と購読側で同じ非対応 codec になりにくい。ただし encoder が対応して decoder が非対応の codec では同一ブラウザでも再現し得る。確実に再現するのは、購読側で非対応の codec を広告する publisher へ接続したときである。ループを止め、利用者にエラーを表示する。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` は `DecoderWrapper` の error コールバックで `decodeErrors` を増やし、`void decoderInstance.reset()` を呼ぶ。回数の上限も同一 config の禁止も無い
- `devtools/src/utils/DecoderWrapper.ts` の `reset()` は `teardown()` の後に `configure(this.lastConfig)` を呼び、`configureWorker` が `new DecoderWorker()` で Worker を作り直す。`configure` の前に codec の対応確認をしない
- `devtools/src/webcodecs-devtools/workers/decoder.worker.ts` の `init` は `decoder.configure(message.config)` を try/catch で囲まず、その直後に `configured` を返す。非同期の error はその後に `error` として届く。同期 throw を捕まえる経路が無いため、その場合は `configured` が送られず main 側の `configure` の Promise が未解決のまま残り、Worker の `onerror` 経由で error コールバックへ入る
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` は Catalog の codec から config を組み立てるだけで `VideoDecoder.isConfigSupported` を呼ばない。devtools で `VideoDecoder.isConfigSupported` を使うのは `devtools/src/webcodecs-devtools/signals.ts` だけである (音声側の `AudioEncoder` / `AudioDecoder.isConfigSupported` は `devtools/src/codec-test/support.ts` にもある)
- `devtools/src/utils/DecoderWrapper.ts` は `get state()` を持ち、Worker モードでは `configured` から `"configured"` / `"unconfigured"` を、直接モードでは `VideoDecoder.state` を返す。`devtools/src/codec-test/types.ts` の「デコーダー Wrapper は state ゲッターを持たない」というコメントはこれと食い違っている
- `devtools/src/utils/DecoderWrapper.test.ts` は configure / decode / reset / Worker 往復を Node の vitest では実行できないと明記し、未設定時の状態機械だけを固定している
- 同型の無条件 reset がライブラリ側にもある (`src/codec/VideoDecoder.ts` の `reset()` と `src/createMediaSubscriber.ts` の映像デコーダーの error コールバック)。ライブラリ側は 0677 が扱う

## 設計方針

- `DecoderWrapper.configure` の先頭で `VideoDecoder.isConfigSupported(config)` を `await` し、`supported` が false のときと Promise が reject したときの両方を非対応として扱う。WebCodecs の仕様では `isConfigSupported` は不正な config に対して同期 throw せず reject した Promise を返すため、`await` を try/catch で囲って同じ扱いにする。Worker を作らず (直接モードでは `VideoDecoder` を作らず)、`Decoder codec not supported: <codec>` で reject する
- 非対応と判定した config は `lastConfig` に残さない (`reset()` が同じ config を再試行しないようにする)
- 事前確認は `configure` の 1 箇所に入れ、`configureWorker` を呼ぶ前に main スレッドで判定する (現行は `new DecoderWorker()` を先に実行するため、順序を入れ替える)。Worker モードと直接モードの両方を守り、codec-test ページから実ブラウザで駆動して固定できる
- 利用者への表示は既存の経路を使う。`configure` の reject は `startSubscribing` の外側の catch が受けて status を error にし、statusMessage を `失敗: ...` にするため、新しい表示経路は作らない
- 復帰の上限を入れる。同じ config でエラー後に再初期化するのは、復号フレームを 1 枚も出力しないまま連続 3 回までとし、復号フレームを 1 枚でも出力したら回数を 0 に戻す。予算は再初期化の試行で消費し、`configure` が reject した場合も 1 回分消費する (試行の数であって成功の数ではない)
- 上限の管理は 0677 が `src/codec/decoderResetBudget.ts` に作る純粋クラス `DecoderResetBudget` をそのまま import して使う。devtools 用に別実装を作らない (`devtools/src/hooks/usePublisher.ts` が `src/` のモジュールを import している前例と同じ)。0677 の完了後に実装する (0677 も `tests/e2e/codec-wrappers.spec.ts` / `devtools/src/codec-test/` / `CHANGES.md` を対象にするため同時に進めない)。上限・復帰・0 未満防止は 0677 が `src/codec/decoderResetBudget.test.ts` で固定し、0651 はブラウザ側の配線を扱う
- 予算を 0 に戻す条件は 2 つだけとする (`DecoderResetBudget` の契約と同じ)。`configure` が `lastConfig` と参照が異なる (`!==`) config を受け取ったとき (判定は `lastConfig` への代入より前に行う) と、復号フレームを出力したときである。`reset()` は同じ `lastConfig` を渡して `configure` に再入するため、この再入で戻すと上限が無効になりループが止まらない
- `reset()` は再初期化したかどうかを `Promise<boolean>` で返し、例外を投げない (`configure` の reject も false として扱う)。上限に達したときと `lastConfig` が無いときは false を返し、Worker もデコーダーも作り直さない
- error コールバックは同期のため、`reset()` の結果は async IIFE で `await` して見る。false なら status を error にし、statusMessage に理由を出して teardown する (既存の `startSubscribing` の外側の catch と同じ終状態)。停止後に上書きしないよう `signal.aborted` を確認する。`useSubscriber` の `void decoderInstance.reset()` は上限判定の結果を受け取る必要があるため、結果を見る経路へ変える
- Worker 側で `configure` の非同期 error を待ってから `configured` を返す設計は採らない。WebCodecs に configure 成功の非同期通知は無いため待てない。同期 throw を error 応答に変換し、`configured` より前に error を受け取ったら Worker を破棄 (`teardown()`) してから `configure` の Promise を reject する (未解決のまま残さない)。ただし事前確認を入れると `DecoderWrapper` は有効な config だけを送り、`signals.ts` も事前確認済みのため、この経路はどちらの呼び出し元からも到達しない。契約違反 (未解決 Promise の残留) を残さないための防御であり、検証はブラウザ依存のためレビューで確認する。Worker のメッセージ種別 (`configured` / `decoded` / `skipped` / `error`) は変えない
- 対象は `devtools/src/utils/DecoderWrapper.ts` / `devtools/src/hooks/useSubscriber.ts` / `devtools/src/webcodecs-devtools/workers/decoder.worker.ts` / `devtools/src/codec-test/` / `tests/e2e/codec-wrappers.spec.ts` / `CHANGES.md` とする。`devtools/src/utils/DecoderWrapper.test.ts` は現行の未設定時の状態機械のテストを維持し、上限のテストは 0677 の Node テストに置く
- 対象外は音声デコーダー (error で reset を呼ばない)、`devtools/src/webcodecs-devtools/signals.ts` の経路 (`isConfigSupported` で事前確認済み)、ライブラリ側 (`src/codec/VideoDecoder.ts` の `reset()` と `src/createMediaSubscriber.ts` の同型ループ。0677 が扱う) とする。`decoder.worker.ts` は購読側と共有するため init の変更は `signals.ts` にも届くが、`signals.ts` は error 応答で `decoderError` / `decoderStatus` を更新する経路を既に持つため表示は改善し、後退しない
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- 非対応 codec (`isConfigSupported` が false、または reject した config) では Worker を作らず (直接モードでは `VideoDecoder` を作らず)、`configure` が `Decoder codec not supported: <codec>` で reject する
- 非対応 codec で購読を開始すると再生成ループに入らず、status が error になり statusMessage に理由が出る
- 上限のカウンタ (上限 3・復帰・0 未満防止) は 0677 の `src/codec/decoderResetBudget.test.ts` で固定され、`DecoderWrapper` はそのクラスを import している (devtools 側に別実装が無い)。上限到達時に `reset()` が false を返すことと、予算が戻る 2 条件 (異なる config / 復号フレームの出力) は実ブラウザの e2e で固定する (復号フレームの出力は 1 枚の encode → decode で駆動し、組めない場合は理由をコメントに明記してレビューで確認する)
- `reset()` は再初期化の有無を `Promise<boolean>` で返し、例外を投げない。上限到達後と `lastConfig` が無いときは false を返し、Worker もデコーダーも作り直さない
- 予算は `reset()` の再入では戻らず、`lastConfig` と異なる config の `configure` と復号フレームの出力でのみ戻る (これが無いと上限が機能しない)
- 一時的な decode エラーからの復帰 (再初期化 1 回で復号が再開する場合) の挙動が変わらない
- Worker の init が `configure` の同期 throw を error 応答に変換し、`configured` より前に error を受け取った `configure` の Promise が Worker の破棄後に reject する (未解決のまま残らない)。この経路は事前確認によりどちらの呼び出し元からも到達しないため、レビューで確認する。同じ Worker を使う `signals.ts` の表示が後退しない
- 実ブラウザの挙動が `devtools/src/codec-test/` に足すケースと `tests/e2e/codec-wrappers.spec.ts` で固定される。新ケースは `devtools/src/utils/DecoderWrapper.ts` を import し、既存の videoDecoder 系 (ライブラリ側 `src/codec/VideoDecoder.ts` を import するケース) は流用しない。ケースは 2 つに分ける。(1) `VideoDecoder.isConfigSupported` が false を返す codec 文字列 (`vp09.99.99.99`) を使い、テスト内で非対応であることを確認してから駆動する。pin するのは `configure` の reject・`state` が `unconfigured` のままであること (判定が生成より前にあるため、どちらのモードでも Worker も `VideoDecoder` も存在しない)・`reset()` が同じ config を再試行せず false を返すことである。`isConfigSupported` が reject する分岐は `codec: ""` で固定する。(2) `isConfigSupported` が true になる codec で `configure` し、予算の各条件を毎回予算を使い切った状態から駆動する。(a) 同じ config で `reset()` を連続して呼ぶと 3 回は true、4 回目は false になり、上限到達後は Worker も `VideoDecoder` も作り直さない。(b) 予算を使い切った状態で 1 枚の encode → decode により復号フレームを出力すると予算が戻り、`reset()` が再び true を返す。(c) 予算を使い切った状態で参照の異なる config を `configure` しても予算が戻り、`reset()` が再び true を返す。(b) の配線が codec-test で組めない場合は、理由をコメントに明記してレビューで確認する (0677 の非対応 codec 候補と同じ扱い)。あわせて `devtools/src/codec-test/types.ts` の「デコーダー Wrapper は state ゲッターを持たない」という陳腐化したコメントを実態に合わせる (新ケースが `state` を観測するため)
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/webcodecs-devtools/signals.ts` (`VideoDecoder.isConfigSupported` で事前確認する既存の例)
- `tests/e2e/codec-wrappers.spec.ts` (codec-test ページを実 Chromium で駆動する既存テスト)
- 0677 (ライブラリ側の同型。`DecoderResetBudget` と `src/codec/decoderResetBudget.ts` の出所。0677 の完了後に着手する)
- `src/codec/VideoDecoder.ts` / `src/createMediaSubscriber.ts` (同型の欠陥。ライブラリ側は 0677)

## 解決方法

{未着手}
