# ライブラリ側の映像デコーダが恒久エラーで Worker を再生成し続ける

- Created: 2026-09-23
- Completed: 2026-09-29
- Branch: feature/fix-video-decoder-reset-loop
- Polished: 2026-09-23

## 目的

`src/codec/VideoDecoder.ts` の `reset()` は上限なく `lastConfig` で再 configure する。`src/createMediaSubscriber.ts` の映像デコーダの error コールバックは `onError` のあとに `reset()` を呼ぶため、恒久的に復号できない場合は error → reset → configure → error が止まらず、Worker の生成と破棄が繰り返される。devtools 側は 0651 で同じ 2 段の対策を入れる予定だが (未着手)、ライブラリ側には事前確認も上限も無い。

## 現状

- `src/codec/VideoDecoder.ts` の `reset()` は `lastConfig` を確認したうえで世代を無効化し、Worker または `VideoDecoder` を作り直して `configureWorker` / `configureDirect` を無条件に呼び、`configured = true` にする。試行回数の上限も、復号フレームの出力で予算を戻す仕組みも無い
- `reset()` は `configure()` を通らず `configureWorker` / `configureDirect` を直接呼ぶ。`configure()` に事前確認を足しても再初期化経路は守れない
- `src/createMediaSubscriber.ts` の `setupDecoders` が `VideoDecoderWrapper` を組み立てる error コールバックは `this.callbacks.onError?.(error)` の後に `void this.videoDecoder?.reset()` を呼ぶ
- `reset()` は失敗を `callbacks.error` に流さず reject する。呼び出しは `void` のため reject が未処理になる。この扱いは 0657 が対象とする
- `devtools/src/utils/DecoderWrapper.ts` には `VideoDecoder.isConfigSupported` の事前確認も復帰予算も無い (0651 が未着手のため)。ライブラリ側の `src/codec/VideoDecoder.ts` にも無い
- devtools の購読経路が使うのは `devtools/src/utils/DecoderWrapper.ts` の `DecoderWrapper` で、ライブラリの `src/codec/VideoDecoder.ts` の `VideoDecoderWrapper` とは別クラスである。0651 の実測 (ヘッドレス Chromium で 3 秒間に 890 回前後の再生成) は devtools 側の観測であり、ライブラリ側の実測は無い
- `src/codec/types.ts` の `VideoCodecType` は 5 値の union で、codec 文字列は `src/codec/config.ts` の固定定数から生成される。不正な codec 文字列を API から渡す経路は無い
- 0651 はライブラリ側 (`src/codec/VideoDecoder.ts` の `reset()` と `src/createMediaSubscriber.ts` の同型ループ) を対象外とし、本 issue で扱うとしている
- 0657 は「`void this.videoDecoder?.reset()` は catch のみとし、`onError` は呼ばない。通知すると恒久的な失敗で通知が反復する」と定めている

## 設計方針

- 0651 と同じ 2 段の対策をライブラリ側にも入れる
  - 事前確認: `VideoDecoder.isConfigSupported(config)` を、`configure()` と `reset()` の両方が通る実行経路 (`configureWorker` / `configureDirect` を呼ぶ直前) に置く。`reset()` は `configure()` を通らないため、`configure()` の先頭だけでは再初期化経路を守れない。false と throw の両方を非対応として扱い、Worker も `VideoDecoder` も作らずに `Decoder codec not supported: <codec>` で失敗する
  - 復帰の予算: 同じ config で再初期化するのは、復号フレームを 1 枚も出力しないまま連続 3 回までとする。復号フレームを 1 枚でも出力したら回数を 0 に戻す。予算は再初期化の試行で消費し、configure が失敗した場合も 1 回分消費する (試行の数であって成功の数ではない)
- 予算を 0 に戻す条件は 2 つだけとする。`configure()` が `lastConfig` と参照が異なる (`!==`) config を受け取ったとき (判定は `lastConfig` への代入より前に行う) と、復号フレームを出力したときである。`reset()` は同じ `lastConfig` で再入するため、この再入では戻さない (戻すと上限が無効になりループが止まらない)
- `reset()` は `Promise<boolean>` を返し、例外を投げない。再初期化したら true、予算切れ・`lastConfig` 無し・事前確認で非対応・再初期化の configure の失敗なら false を返し、Worker もデコーダーも作り直さない。`callbacks.error` は呼ばない。呼ぶと error コールバックが `reset()` を再入させ、通知と再生成が止まらない (0657 も同じ理由で `onError` を呼ばないと定めている)
- `src/createMediaSubscriber.ts` の映像 error コールバックは `reset()` の結果を見る。false なら再生成を打ち切る。decode エラーの通知自体は再生成のたびに起こり得る (初回 + 再初期化 3 回で最大 4 回) が、`reset()` の失敗は通知を増やさない
- 予算切れの終状態を定める。`reset()` は false を返すときに Worker と `VideoDecoder` を破棄して `configured = false` にする (`close()` と同じ後始末)。`decode()` は `configured` が false なら警告して何もしないため、以降のフレームは復号されず decode エラーも出ない。再生成と通知はここで止まる
- 上限の管理は純粋クラス `DecoderResetBudget` として `src/codec/decoderResetBudget.ts` に切り出し、Node の単体テストで固定する (`src/codec/workerConfigure.ts` の `ConfigureGenerationTracker` と同じ「ブラウザ非依存の純粋部分を Node で固定する」方針)
- WebCodecs と Worker は Node の vitest に無いため、Node のテストは純粋クラス (`DecoderResetBudget`) に限定する。事前確認と予算切れは `devtools/src/codec-test/` のテストページから実ブラウザで駆動し、`tests/e2e/codec-wrappers.spec.ts` で固定する (0651 と同じ経路)。`reset()` は公開メソッドなので、同じ config で連続して呼べば予算を消費させられる。`src/createMediaSubscriber.ts` の error コールバック経由の打ち切りだけは WebCodecs の decode エラーを API から確実に起こせないため自動テストで駆動できず、`src/codec/workerConfigure.test.ts` と同じくレビューで確認する
- `reset()` の契約が `Promise<void>` から例外を投げない `Promise<boolean>` に変わる。0657 は同じ `src/createMediaSubscriber.ts` の error コールバックを対象とし、完了条件の「reject する `reset()` を cast で注入して駆動するテスト」と「`videoDecoder.reset()` の失敗は unhandled rejection にならず、`onError` の回数も増えない」の 2 件が読み替え対象になる。本 issue を先に実装する場合は 0657 の当該箇所も更新する (0657 自体の修正は本 issue の対象外)。reject の伝搬そのものは 0657 が扱う
- 対象は `src`、`tests/e2e/codec-wrappers.spec.ts`、`devtools/src/codec-test/` (実ブラウザ駆動の検証経路の追加)、`CHANGES.md` とする。0651 が変更する `devtools/src/utils/DecoderWrapper.ts` と、0657 が扱う reject の伝搬は変更しない
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する

## 完了条件

- 復号フレームを得ないまま再初期化が続く場合、3 回で打ち切られて Worker の再生成が止まる
- 一時的な decode エラーからの復帰 (再初期化 1 回で復号が再開する場合) の挙動が変わらない
- `lastConfig` と参照が異なる config の configure と、復号フレームの出力で予算が 0 に戻る
- `reset()` は予算切れ・`lastConfig` 無しで false を返し、Worker もデコーダーも作り直さない
- `reset()` は `callbacks.error` を呼ばない。恒久エラーで `onError` が通知されるのは decode エラーの分だけで、最大 4 回 (初回 + 再初期化 3 回) で止まる。`reset()` の失敗自体は通知を増やさない
- `VideoDecoder.isConfigSupported` が false を返す config では Worker も `VideoDecoder` も作らず `Decoder codec not supported: <codec>` で失敗する。この確認が `reset()` の再初期化経路でも効く
- `DecoderResetBudget` の上限・復帰・0 未満防止が `src/codec/decoderResetBudget.test.ts` の Node 単体テストで固定される
- `VideoDecoder.isConfigSupported` が false になる codec を `devtools/src/codec-test/` のテストページから実ブラウザで駆動し、`configure()` が `Decoder codec not supported: <codec>` で失敗して `state` が `unconfigured` のままになることを `tests/e2e/codec-wrappers.spec.ts` で固定する。Worker と `VideoDecoder` が作られないことは事前確認の配置で担保し、e2e では `state` とエラーメッセージで確認する。非対応 codec は `devtools/src/codec-test/support.ts` の `AUDIO_CODEC_CANDIDATES` と同じ形で映像の候補を順に試し、`isConfigSupported` が false になる 1 件を実測で選ぶ (0651 の e2e は `vp09.99.99.99` を採る。同 issue は hvc1 の再生成回数が実行環境で変わることも実測している)。候補が尽きた場合は理由をコメントに明記してレビューで確認する
- 非対応 codec の configure が失敗したあと、同じ config で `reset()` を呼んでも Worker も `VideoDecoder` も作られず false を返す (事前確認が `reset()` の再初期化経路でも効く) ことを e2e で固定する
- 同じ config で `reset()` を連続して呼ぶと 3 回は true、4 回目は false になり、以降 `decode()` が `configured = false` により復号しないことを e2e で固定する
- `src/createMediaSubscriber.ts` の error コールバック経由の打ち切りだけは自動テストで駆動できないため、レビューで確認する (`src/codec/workerConfigure.test.ts` と同じ扱い)。`src/createMediaSubscriber.test.ts` は WebCodecs と Worker を起動できないため対象外とする
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- 0651 (devtools 側の同型欠陥。2 段の対策・予算の消費規則・復帰条件は 0651 と同じ方針に揃える。ライブラリ側が本 issue)
- 0657 (高レベル API の送信 reject の伝搬。`reset()` から `onError` を呼ばない方針の出所)
- `src/codec/VideoDecoder.ts` の `reset` / `configure` / `configureWorker` / `configureDirect`、`src/createMediaSubscriber.ts` の `setupDecoders`、`src/codec/workerConfigure.ts`、`devtools/src/utils/DecoderWrapper.ts` (0651 の変更対象)、`devtools/src/codec-test/video.ts` の `runVideoDecoderTest` (実ブラウザ駆動の追加先)、`tests/e2e/codec-wrappers.spec.ts`

## 解決方法

`src/codec/configSupport.ts` に `isVideoDecoderConfigSupported()` を新設し、`VideoDecoder.isConfigSupported` の false と reject の両方を非対応として扱う判定を 1 箇所にまとめた (devtools の codec-test も同じ関数を使う)。`src/codec/VideoDecoder.ts` の `applyConfig()` を configure と reset の共通経路にし、Worker も `VideoDecoder` も作る前にこの確認を通す。非対応なら `Decoder codec not supported: <codec>` で失敗する (WebCodecs 非搭載の環境は別文言にした)。

`src/codec/decoderResetBudget.ts` に純粋クラス `DecoderResetBudget` を新設した。同じ config での再初期化は復号フレームを 1 枚も出力しないまま連続 3 回までとし、復号フレームの出力と `configure()` の呼び出しで消費を 0 に戻す (`reset()` の再入では戻さない)。上限・復帰・0 未満防止は `src/codec/decoderResetBudget.test.ts` の Node 単体テストで固定した。

`reset()` は例外を投げない `Promise<boolean>` になった。`lastConfig` 無し・予算切れ・事前確認の非対応・再初期化の失敗では false を返し、`teardownQuietly()` で Worker と `VideoDecoder` を破棄して `configured` を false にする (以降の `decode()` は何もしない)。`callbacks.error` は呼ばない。`teardown()` は破棄対象を控えてから参照と `configured` を先に落とす形にし、破棄が失敗しても `reset()` が reject しないことを構造的にした。

`configure()` と `reset()` の両方に、対応確認の await をまたいだ追い越し判定を入れた。await の前に世代と `lastConfig` を控え、await の後に変わっていれば生成せずに中断する。これにより、解放 (`close()`) や後発の `configure()` と競合しても、破棄済みの Wrapper が Worker や `VideoDecoder` を作り直してリークすることがない (3 周目のレビューで実測された退行を塞いだ)。

`src/createMediaSubscriber.ts` の映像 error コールバックは `void this.videoDecoder?.reset()` のままにした。打ち切りは `reset()` の中で完結し、呼び出し側に残る作業が無いためである。`VideoDecoderWrapper.decode()` の未構成警告は `warnNotConfiguredOnce()` で 1 回に絞った (打ち切り後は受信のたびに警告が出るため)。

Node テスト (`src/codec/VideoDecoder.test.ts` / `configSupport.test.ts` / `decoderResetBudget.test.ts`) と、`devtools/src/codec-test/video.ts` に追加した実ブラウザ駆動の経路 (`tests/e2e/codec-wrappers.spec.ts` の 10 テスト: 非対応 codec、予算の打ち切り、予算の復帰、configure と close の競合、交錯する reset) で固定した。

設計方針との差 (実装時に判断した点):

- error コールバックは `reset()` の戻り値を見ない。打ち切りは `reset()` 内で完結するため、呼び出し側で結果を扱う必要が無い
- Node テストは純粋クラスに限定せず、WebCodecs の境界 (`globalThis.VideoDecoder`) を置き換えて Wrapper も駆動する。e2e では「configure 成功後に対応確認が false へ変わる」経路を駆動できないため
- 追い越された `reset()` も予算を 1 回分消費する (予算は再初期化の試行で消費する規則のため)。追い越された `configure()` は reject し、その旨のエラーが `start()` の失敗として利用者に届く
- 予算の復帰は「`lastConfig` と参照の異なる config」ではなく「`configure()` が呼ばれたとき」とした (`getVideoDecoderConfig()` が毎回新しいオブジェクトを返すため等価)

`CHANGES.md` の `## develop` の FIX 群先頭に `[FIX]` を追記した。`issues/0657` の「reset() の戻り値を見て結果を扱う」という記述は、上記の判断に合わせて更新した。

`npx vp check` / `npx vp test --run` (3348 テスト) / `npx vp run e2e-test` (76 テスト) が通る。
