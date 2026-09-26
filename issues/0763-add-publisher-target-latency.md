# publisher が catalog に targetLatency と renderGroup を載せる

- Created: 2026-09-26
- Completed: {YYYY-MM-DD}
- Branch: feature/add-publisher-target-latency
- Polished: 2026-09-26

## 目的

MSF の `targetLatency` は「符号化から表示までの wallclock の差」で、同じ render group と alternate group の track は同じ値でなければならない (draft-ietf-moq-msf-01 §5.2.8)。`renderGroup` は同じ group の track を同時に描画するための表明である (§5.2.11)。購読側は 0635 で `targetLatency` を表示時刻に使うが、リポジトリ内の publisher (`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts`) は catalog にこの 2 つを載せていない。catalog に載っていなければ購読側は「宣言が無い」として再生の遅れを自分で選ぶフォールバックになり (`src/createMediaSubscriber.ts` の `effectiveTargetLatencyMs` と `resolveSharedTargetLatencyMs`)、`targetLatency` の経路は単体テストでしか動かない。実機で確かめられるようにする。

本 issue は「catalog に載る」ところまでとする。載せた値を購読側が使うことの実機確認は 0636 が持つ。`renderGroup` は購読側が実質読んでいない (`src/msf/tracks.ts` の `getTracksByRenderGroup` は利用者ゼロ、devtools の購読側にも参照が無い) ため、本 issue では catalog に載るところまでとし、購読側が読むかどうかは 0636 の範囲にする。

## 現状

- `src/createMediaPublisher.ts` の `createCatalogTracks` は音声と映像の track に `isLive: true` / `role` / codec / bitrate / 解像度などを載せるが、`targetLatency` と `renderGroup` は載せない
- `devtools/src/hooks/usePublisher.ts` の `buildPublisherCatalog` も同じ (`PublisherCatalogOptions` に指定する口が無い)
- `src/msf/types.ts` の `CatalogTrack` には `targetLatency` / `renderGroup` があり、`src/msf/catalogTrackValidation.ts` の `pickLatencyAndBuffers` と `pickOptionalNumber` が値の型と `buffers` との併存禁止を検証しているため、載せた catalog は既存の検証を通る
- 送信側の TIMESTAMP は、映像が `src/mediaClock.ts` の `WallClockMapper`、音声が `LOC.toUnixEpochMicroseconds` で、どちらも壁時計である。ただし値は「符号化の完了時刻」ではなく「フレームを読んだ (撮った) 時刻」である (`src/createMediaPublisher.ts` の映像と音声の送出)。購読側が守る表示時刻は「撮影 + targetLatency」になり、符号化にかかった時間の分だけ符号化から表示までが短くなる
- devtools の publisher 設定は数値も列挙も `<select>` で既定値が常に 1 つ選ばれ、signal も常に数値である (`devtools/src/signals/connectionSettings.ts`)。既定値のとき URL に載せない扱いは `mode` / `audioDelivery` / `useDedicatedWorker` / `jitterBuffer` にあるが、値そのものに「未指定」を持つ設定は無い

## 設計方針

- `src/codec/types.ts` の `MediaPublisherOptions` に `targetLatency` (ms) と `renderGroup` (整数) を任意で足し、`createCatalogTracks` が音声と映像の**両方**の track に同じ値を載せる。1 つの値だけを持つことで §5.2.8 の「同じ render group と alternate group の track は同一の値でなければならない MUST」を 1 つの publisher インスタンスの中では構造で守る。音声と映像を別の publisher で配信して同じ `renderGroup` を指定した場合は守れないが、それを検出する仕組みは無い (受信側の catalog の検証は track 単位で、跨ぎで一致を見ない。購読側の `resolveSharedTargetLatencyMs` が購読した 2 track について `onError` で通知するだけである)
- 指定しないときは catalog に載せない (§5.2.8 は「宣言が無く `isLive` が true のとき、購読側が遅延を選んでよい MAY」であるため、載せないことが購読側のフォールバックの経路になる)
- `targetLatency` と `renderGroup` は独立の任意指定にする (片方だけでもよい)。`renderGroup` を指定しないと「同じ group の track を同時に描画する SHOULD」は表明されないが、`targetLatency` の同一値 MUST は 1 つの値で満たされる
- `buffers` は publisher のオプションにも catalog にも無いため §5.2.8 の MUST NOT には抵触しない。`buffers` を publisher に足す作業は本 issue に含めない (排他の型表現が必要になったらそのときの issue で扱う)
- publisher では値の検証を足さない (受信側の catalog の検証は `src/msf/catalogTrackValidation.ts` が持つ)。`renderGroup` の整数性は encode 側でも decode 側でも検証されないため、指定する値は呼び出し側の責任になる
- devtools の publisher は `PublisherCatalogOptions` (音声と映像の子設定を持つ親) のトップレベルに同じ 2 つを足す。設定は signal を `number | null` (`null` が未指定) にし、`<select>` に「未指定」(ラベルは `Unset`。UI は英語表記) を既定として用意する。選択肢と URL の受理値は同じ許可リスト定数から作る (`devtools/src/signals/connectionSettings.ts` の `AUDIO_BITRATES` と同じ形。`TARGET_LATENCY_OPTIONS` は `[0, 50, 100, 200, 500]`、`RENDER_GROUP_OPTIONS` は `[0, 1]` を初期値にする)。URL クエリは指定があるときだけ `targetLatency` / `renderGroup` を載せ、`initFromUrl` が許可リストで検証して読み戻す。`targetLatency` の 0 ms と `renderGroup` の 0 は有効値であるため「0 = 未指定」とは扱わない (未指定は空値の `<option>` から `null` に写す)
- devtools の `targetLatency` の候補値は 200 ms 以下を主にする (購読側は表示の遅れを `MAX_PLAYOUT_DELAY_MS` = 500 ms とキューの長さの小さい方で切り下げる。キュー由来の上限は `(24 - 4) × フレーム間隔` で、30 fps は約 667 ms、60 fps は約 333 ms、jitter buffer 無効 (12 枚) の 30 fps は約 267 ms になる。500 ms を候補に残す場合は 30 fps かつ jitter buffer 有効のときだけ切り下げられないことを注記する)
- 実機での確認 (購読側が `targetLatency` どおりの時刻に表示するか) は 0636 が持つ。本 issue は「catalog に載る」ところまでとする。0636 の完了条件には「devtools の購読側が catalog の `targetLatency` を読み、`window.moqtDevTools.getSubscriber(id)` の統計と data-testid に出る使っている目標遅延が publisher の設定値と一致する」を反映済みである。ライブラリ側の `getStats().avSync.targetLatencyMs` は devtools の購読には無い API であり、devtools の確認には使えない

## 変更対象

- `src/codec/types.ts`: `MediaPublisherOptions` に `targetLatency` と `renderGroup` を足す
- `src/createMediaPublisher.ts`: `createCatalogTracks` が両方の track に同じ値を載せる
- `devtools/src/hooks/usePublisher.ts`: `PublisherCatalogOptions` に同じ 2 つを足し、`buildPublisherCatalog` が載せる。呼び出し側 (`usePublisher`) から設定を渡す
- `devtools/src/signals/connectionSettings.ts`: 2 つの signal (`number | null`) と URL クエリの生成・読み取り
- `devtools/src/components/ConnectionSettings.tsx`: 「未指定」を既定にした選択
- `docs/HIGH_LEVEL_API.md`: `MediaPublisherOptions` の記載 (publisher のオプションの節)
- `CHANGES.md`: `## develop` に `[ADD]` を 2 件 (ライブラリと moqt-devtools)。devtools の変更も別エントリにする (既存の慣例)
- テスト: `src/createMediaPublisher.test.ts` と `devtools/src/hooks/usePublisher.test.ts`、`devtools/src/signals/connectionSettings.test.ts`

## 完了条件

- `createMediaPublisher` が、指定した `targetLatency` (ms) と `renderGroup` を catalog の音声と映像の両方の track に載せる。送信した catalog の payload を `decodeCatalogMessage` で読み戻し、両方の track の値が指定どおりであることを検証する (`src/createMediaPublisher.test.ts` の `publishCatalog` を駆動する既存の形を使う。既存の記録用 publisher は payload を記録していないため、payload を記録する制御口を足す。映像の track を載せるには `resolvedVideo` と `mediaStream` の注入も要る)
- 指定しないときは catalog に載らない。片方だけ指定したときはその片方だけが載る (送信した payload の JSON にキーが無いことを見る。符号化は `undefined` を落とすため、キーの有無は復号してからではなく payload そのもので確かめる)
- devtools の publisher が、設定と URL クエリで指定した同じ 2 つを catalog に載せ、未指定のときは URL にも catalog にも載らない (`devtools/src/hooks/usePublisher.test.ts` と `devtools/src/signals/connectionSettings.test.ts` の URL 往復)。`buildPublisherCatalog` への配線は接続を要する `startPublishing` を経由するため単体テストで観測できない (モックは使えない)。設定から `PublisherCatalogOptions` を組み立てる純関数を切り出してそれを検証し、`usePublisher` の配線そのものは E2E に委ねる
- `docs/HIGH_LEVEL_API.md` の publisher のオプションの記載と実装が一致する
- `CHANGES.md` の `## develop` に `[ADD]` を 2 件載せる (ライブラリと moqt-devtools)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 実装順

1. `src/codec/types.ts` と `src/createMediaPublisher.ts` に足し、`src/createMediaPublisher.test.ts` で catalog の payload を検証する
2. devtools の `PublisherCatalogOptions` と `buildPublisherCatalog` に足し、`devtools/src/hooks/usePublisher.test.ts` で検証する
3. devtools の signal・URL クエリ・設定 UI を足し、`devtools/src/signals/connectionSettings.test.ts` で URL の往復を検証する
4. `docs/HIGH_LEVEL_API.md` と `CHANGES.md` を更新する

この順で先に 0763 を終わらせてから 0636 に進む (0636 の実機確認は publisher が catalog に載せていることが前提になる)

## 参照

- draft-ietf-moq-msf-01 §5.2.7 (isLive: true の後に false を送らない MUST。publisher は `isLive: true` 固定で、false の track の `targetLatency` は購読側が無視する MUST の対象になる)
- draft-ietf-moq-msf-01 §5.2.8 (targetLatency: 符号化から表示までの wallclock の差 (ms)。宣言が無く `isLive` が true のときは購読側が遅延を選んでよい MAY。同じ render group と alternate group の track は同一の値でなければならない MUST。`buffers` と併存しない MUST NOT)
- draft-ietf-moq-msf-01 §5.2.9 (buffers: `targetLatency` と併存しない。publisher は出さない)
- draft-ietf-moq-msf-01 §5.2.11 (renderGroup: 同じ group の track は同時に描画する SHOULD)
- 0635 (購読側で `targetLatency` を表示時刻に使う実装。設計方針と解決方法に、共有の時間軸・同じ render group の値の解決規則・上限とフォールバックの扱いがある)
- 0636 (devtools の A/V 同期。実機での確認を持つ。完了条件に「devtools の購読側が catalog の `targetLatency` を読み、統計と data-testid に出る目標遅延が publisher の設定値と一致する」を反映済み)
- 0762 (購読側の映像の表示時刻を決める `PlayoutBuffer` を `src/` へ移した。当時は catalog の `targetLatency` を使わず、0635 で使うようになった)
- 0683 (publisher が catalog を再送する。未着手であり、実装されれば保持した payload をそのまま送り直すため本 issue で載せた値も再送に載る)
- 0693 (符号化時の catalog の検証。`createCatalog` / `encodeCatalog` の検証は未実装で、`renderGroup` の整数性はどこでも検証されない)

## 解決方法

{未着手}
