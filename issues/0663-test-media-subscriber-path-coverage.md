# createMediaSubscriber の受信経路の主要な分岐がテストされていない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-media-subscriber-path-coverage
- Polished: 2026-11-14

## 目的

`src/createMediaSubscriber.ts` は高レベル API であり、受信経路 (Catalog 受信 → トラック解決 → デコーダ構成 → 購読確立 → 映像 / 音声 Object の復号) を持つ。ハンドラ先頭と decode 直前のガード、および Object Property の config 変化を契機にした再構成の成功経路はテストで固定されておらず、分岐が壊れても既存テストは通る。再構成の失敗経路 (codec 解決の throw / onError の throw) は既存テストが固定している。

また、`start()` の段取り (接続 → Catalog 購読 → トラック解決 → 出力 MediaStream 作成 → デコーダ構成 → メディア購読) は WebTransport / MediaStream / AudioContext / MediaStreamTrackGenerator / WebCodecs を必要とし、Node の単体テストでは成功経路を最後まで駆動できない。本 issue では Node で駆動可能な範囲を固定し、駆動できない範囲を対象外として明記する。

## 現状

- テストは `src/createMediaSubscriber.catalog.test.ts` / `src/createMediaSubscriber.lifecycle.test.ts` / `src/createMediaSubscriber.media.test.ts` / `src/createMediaSubscriber.playout.test.ts` / `src/createMediaSubscriber.publish-done.test.ts` に分割されている (現時点で合計 198 テスト)。次を検証している
  - 純関数 (`processCatalogPayload` / `filterPendingCatalogObjects` / `isVideoKeyFrameObject` / `resolveAuthorizationToken` / `catalogFetchFilter`) は `src/createMediaSubscriber.catalog.test.ts`
  - `extractTrackInfo` (role なし解決・未解決通知)、`subscribeCatalog` (FETCH 開始位置・Catalog 取得失敗後の hygiene)、`handleCatalogObject` 経由の catalog 適用は `src/createMediaSubscriber.catalog.test.ts`
  - `handleVideoObject` / `handleAudioObject` (記録用オブジェクトを private フィールドへ注入して直接駆動)、`receiveVideoObject` / `receiveVideoSubgroupEnd` (Group 切替の保留)、`requestNewGroup` は `src/createMediaSubscriber.media.test.ts`
  - `subscribeMediaTracks` と `applyInitialVideoConfig` / `applyInitialAudioConfig` (購読要求前の保留有効化、SUBSCRIBE_OK の Track Property の初期 configure、保留 Object の到着順解放) は `src/createMediaSubscriber.catalog.test.ts`
  - `handleVideoDecodedData` / `handleAudioDecodedData` (復号フレーム破棄の所有権・表示時刻)、targetLatency / avSync の解決は `src/createMediaSubscriber.media.test.ts` / `src/createMediaSubscriber.playout.test.ts`
- 未固定の分岐
  - `handleAudioObject` の先頭ガード (`audioDecoder` が null、または `audioDecoderConfigured` が false のとき、decode に渡さず復号前の段にも積まない)
  - `handleVideoObject` の先頭ガード (`videoDecoder` が null、または `videoDecoderReconfiguring` が true のとき、decode に渡さず復号前の段にも積まない)
  - `decodeVideoObject` の `videoDecoderConfigured` ガード (再構成中ではないが未構成のとき decode に渡さない)
  - Object Property の VIDEO_CONFIG / AUDIO_CONFIG が直前と異なるときの再構成の成功経路。既存テストは再構成の失敗経路 (codec 解決の throw / onError の throw) と close との競合を固定するが、新しい description で configure が成功し、その後に decode されることは固定していない
  - `applyInitialVideoConfig` の configure 失敗の再試行は commit 20985ca8 で挙動が変わり、そのテストも削除された。`applyInitialAudioConfig` の configure 失敗の再試行は元々テストが無い。いずれも現在は固定されておらず、本 issue の config の再構成は Object Property 起点に絞るため対象外とする
- `setupDecoders` は `src/createMediaSubscriber.lifecycle.test.ts` と `src/createMediaSubscriber.playout.test.ts` が直接呼び、`start` / `stop` / `close` は `src/createMediaSubscriber.lifecycle.test.ts` が直接呼ぶ。`setupDecoders` は close 時の中断と opus の configure レートを固定するが、codec / 解像度 / サンプルレート / チャンネルの解決は 0700 が持つ。`stop` / `close` の解放は closed 0654 が持つ。`connectToServer` は `start` 経由で呼ばれ、`openSession` の境界を注入して接続の完了を制御する。Node の単体テストで `createOutputStream` を直接呼ぶテストは無く、`start` の成功経路全体は Node では駆動しない
- 分割後のテストも `new MediaSubscriberImpl(...)` を組み立て、private フィールドへ記録用オブジェクトを注入してハンドラを駆動する形である。`subscribeMediaTracks` の購読確立直後の初期 configure を固定する 2 テスト (映像・音声) は `session.subscribe` の object コールバックから保留キューを経てハンドラまでの配線を固定しているが、session は最小オブジェクトのキャストであり、`start()` の WebTransport 区間は通していない

## 設計方針

- 検証は既存テストと同じ制御口の注入で行う (`as unknown as ...` で private フィールドへ記録用オブジェクトを渡し、差し替えるのは Node に無いブラウザ API (VideoDecoder / AudioDecoder / AudioContext / MediaStreamTrackGenerator) と接続境界 (`openSession` / session) だけとする。判定ロジックを偽装するモックやスタブは使わない。closed 0654 のテストと同じ形)
- 実装クラス (`MediaSubscriberImpl`) そのものは差し替えない
- 実 `ReadableStream` / `WritableStream` を使った実 SessionImpl での駆動は、closed 0666 でセッション層のテストが実ストリームへ移行済みであり、MediaSubscriber のテストへは持ち込まない。`MediaSubscriberImpl` は `connect()` 経由で session を作るため、WebTransport が無い Node では実接続を駆動できない。接続の境界 (`openSession`) を注入すれば `start()` の失敗経路は駆動できるが、成功経路全体 (MediaStream / AudioContext / WebCodecs) は駆動しない (0688 も同じ制約を記している)
- `stop` / `close` の解放テストは closed 0654 が持つ。0654 で確定した契約 (stop で解放し `"stopped"` から再開可能、解放を `disposeAllResources()` に集約) に合わせて書く
- `setupDecoders` の codec / 解像度 / サンプルレート / チャンネルの解決と throw は 0700 が純粋関数へ切り出してテストする。wrapper の生成と configure 配線は WebCodecs を要するため、0700 に合わせて本 issue の対象外とする
- `applyInitial*Config` の configure 失敗の再試行 (映像の `failedVideoConfig` による同一構成の抑止、音声の後続 Object での再試行) は本 issue の対象外とする。config の再構成は Object Property 起点の成功経路だけを固定する
- 対象外: `start()` の WebTransport 実接続区間。実リレーへ接続する e2e は `tests/e2e/relay/` にあるが、`TEST_MOQT_URI` で渡された外部リレーへ接続するものであり、リポジトリがリレーを起動するわけではない。Node の単体テストでは実接続を駆動しない (0703 は c4m/CAT の相互運用をこの harness で扱う)
- テストは `src/createMediaSubscriber.media.test.ts` に追加する (ハンドラの分岐と復号の検証は同ファイルが既に持つ)
- テストのログメッセージは日本語にする

## 完了条件

- `handleAudioObject` が、`audioDecoder` が null または `audioDecoderConfigured` が false のとき、decode を呼ばず、復号前の段 (`audioPreDecodeStage`) にも積まないことが固定される (復号前の段がある購読で固定する)
- `handleVideoObject` が、`videoDecoder` が null または `videoDecoderReconfiguring` が true のとき、decode を呼ばず、復号前の段 (`videoPreDecodeStage`) にも積まないことが固定される (復号前の段がある購読で固定する)
- `decodeVideoObject` が、`videoDecoderConfigured` が false のとき (再構成中ではないが未構成の場合) decode を呼ばないことが固定される
- Object Property の VIDEO_CONFIG / AUDIO_CONFIG が直前と異なるとき、`reconfigureVideoDecoder` / `reconfigureAudioDecoder` が新しい description で configure し、再構成の完了後に decode されることが固定される (映像・音声の両方)
  - 映像は、再構成の契機になった Object が再構成完了後に decode されること
  - 音声は、再構成の契機になった Object は捨てられ、再構成完了後の次の Object が decode されること
- closed 0649 が追加したテスト (保留キュー / 購読直後の初期 configure / config 同一判定。現在は `src/createMediaSubscriber.catalog.test.ts` と `src/createMediaSubscriber.media.test.ts`) が変わらず通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- closed 0654 (createMediaSubscriber の stop() がリソースを解放せず再開もできない。2026-09-29 完了)。`stop` / `close` の解放テストは 0654 が持ち、本 issue はその契約に合わせる
- open 0700 (setupDecoders の解決ロジックが純粋関数でなく単体テストで固定されていない)。codec 解決の純粋関数化とテストは 0700 が持つ
- closed 0649 (Track Property の VIDEO_CONFIG / AUDIO_CONFIG が初期 configure に反映されず最初の Object が捨てられる)。`subscribeMediaTracks` の配線と保留キューのテストを追加済み (現在は `src/createMediaSubscriber.catalog.test.ts` と `src/createMediaSubscriber.media.test.ts`)
- closed 0666 (テスト用の手書きスタブを実ストリームに置き換える。2026-11-11 完了)。セッション層の実 SessionImpl 化は完了しており、MediaSubscriber のテストは最小 session のままとする
- closed 0699 (close 後に in-flight の reconfigure が完了すると audioDecoderConfigured / videoDecoderConfigured が true に戻る。2026-10-09 完了)。close 周りの再構成は `src/createMediaSubscriber.lifecycle.test.ts` が固定している
- pending 0703 (c4m から取り込んだ CAT が relay 側で受理されるか未検証)。`start()` の WebTransport 実接続区間を対象外とする根拠
- open 0688 (connect() のオプション配線がテストで固定されていない)。WebTransport が Node に無い制約を記している

## 解決方法

{未着手}
