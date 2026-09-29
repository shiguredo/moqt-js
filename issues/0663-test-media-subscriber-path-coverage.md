# createMediaSubscriber の受信経路の主要な分岐がテストされていない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-media-subscriber-path-coverage
- Polished: 2026-09-29

## 目的

`src/createMediaSubscriber.ts` は高レベル API であり、受信経路 (Catalog 受信 → トラック解決 → デコーダ構成 → 購読確立 → 映像 / 音声 Object の復号) を持つ。ハンドラに入る前のガードと config 変更時の再構成の分岐はテストで固定されておらず、分岐が壊れても既存テストは通る。

また、`start()` の段取り (接続 → Catalog 購読 → トラック解決 → 出力 MediaStream 作成 → デコーダ構成 → メディア購読) は WebTransport / MediaStream / AudioContext / MediaStreamTrackGenerator / WebCodecs を必要とし、Node の単体テストでは駆動できない。本 issue では Node で駆動可能な範囲を固定し、駆動できない範囲を対象外として明記する。

## 現状

- `src/createMediaSubscriber.test.ts` は 76 テストで、次を検証している
  - 純関数: `processCatalogPayload` / `filterPendingCatalogObjects` / `isVideoKeyFrameObject` / `resolveAuthorizationToken` / `catalogFetchFilter`
  - `extractTrackInfo` (role なし解決・未解決通知)、`subscribeCatalog` (FETCH 開始位置・Catalog 取得失敗後の hygiene)、`handleCatalogObject` 経由の catalog 適用
  - `handleVideoObject` / `handleAudioObject` (記録用オブジェクトを private フィールドへ注入して直接駆動)、`receiveVideoObject` / `receiveVideoSubgroupEnd` (Group 切替の保留)
  - `subscribeMediaTracks` と `applyInitialVideoConfig` / `applyInitialAudioConfig` (購読要求前の保留有効化、SUBSCRIBE_OK の Track Property の初期 configure、保留 Object の到着順解放)
  - `requestKeyframe`、`handleVideoDecodedData` / `handleAudioDecodedData` (復号フレーム破棄の所有権・表示時刻)、targetLatency / avSync の解決
- 未固定の分岐
  - `handleVideoObject` / `handleAudioObject` の先頭ガード (デコーダが null、または `*DecoderConfigured` が false のとき decode に渡さない)
  - Object Property の VIDEO_CONFIG / AUDIO_CONFIG が直前と異なるときの `reconfigureVideoDecoder` / `reconfigureAudioDecoder` と、再構成完了後に以降の Object が decode されること (適用失敗後の再試行は `applyInitial*Config` 側で固定済みだが、Object Property 起点の再構成は未固定)
- `setupDecoders` / `createOutputStream` / `connectToServer` / `start` / `stop` / `close` を呼ぶテストは無い。`setupDecoders` の codec 解決は 0700、`stop` / `close` は 0654 が持つため、本 issue の対象外とする
- 同ファイルのテストは `new MediaSubscriberImpl(...)` を組み立て、private フィールドへ記録用オブジェクトを注入してハンドラを駆動する形である。`subscribeMediaTracks` の 2 テスト (映像・音声) は `session.subscribe` の object コールバックから保留キューを経てハンドラまでの配線を固定しているが、session は最小オブジェクトのキャストであり、`start()` の WebTransport 区間は通していない

## 設計方針

- 検証は既存テストと同じ制御口の注入で行う (`as unknown as ...` で private フィールドへ記録用オブジェクトを渡し、差し替えるのは Node に無いブラウザ API (VideoDecoder / AudioDecoder / AudioContext / MediaStreamTrackGenerator) の境界だけとする。判定ロジックを偽装するモックやスタブは使わない。0654 の完了条件と同じ形)
- 実装クラス (`MediaSubscriberImpl`) そのものは差し替えない
- 実 `ReadableStream` / `WritableStream` を使った実 SessionImpl での駆動はセッション層の 0666 の方向であり、MediaSubscriber のテストへは持ち込まない (`MediaSubscriberImpl` は `connect()` 経由で session を作るため、WebTransport が無い Node では `start()` を最後まで駆動できない。0688 も同じ制約を記している)
- `stop` / `close` の解放テストは 0654 が持つ。0654 の設計方針 (stop で解放し `"stopped"` から再開可能、解放を `disposeAllResources()` に集約) が確定しているため、本 issue のテストは 0654 の完了後に新しい契約へ合わせて書く (0654 の「参照」も本 issue を 0654 の後に定めている)
- `setupDecoders` の codec / 解像度 / サンプルレート / チャンネルの解決と throw は 0700 が純粋関数へ切り出してテストする。wrapper の生成と configure 配線は WebCodecs を要するため、0700 に合わせて本 issue の対象外とする
- 対象外: `start()` の WebTransport 実接続区間。実リレーを起動する相互運用 harness は現状リポジトリに無く、0703 が先例を作る予定であるため、本 issue では扱わない
- テストのログメッセージは日本語にする

## 完了条件

- `handleVideoObject` / `handleAudioObject` が、デコーダが null または未構成 (`*DecoderConfigured` が false) のとき decode を呼ばないことが固定される (映像・音声の両方)
- Object Property の VIDEO_CONFIG / AUDIO_CONFIG が直前と異なるとき、`reconfigureVideoDecoder` / `reconfigureAudioDecoder` が新しい description で configure し、再構成の完了後に以降の Object が decode されることが固定される (映像・音声の両方)
- 0649 が追加したテスト (保留キュー / 購読直後の初期 configure / config 同一判定) が変わらず通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0654 (createMediaSubscriber の stop がリソースを解放せず再開もできない)。本 issue を 0654 の後に着手する。`stop` / `close` の解放テストは 0654 が持つ
- 0700 (setupDecoders が Node の単体テストで駆動できず解決ロジックが未テストである)。codec 解決の純粋関数化とテストは 0700 が持つ
- closed 0649 (Track Property の config が初期 configure に反映されず最初の Object が捨てられる)。`subscribeMediaTracks` の配線と保留キューのテストを追加済み
- 0666 (テスト用の手書きスタブを実ストリームに置き換える)。セッション層の実 SessionImpl 化
- 0699 (close 後に in-flight の reconfigure が完了すると `*DecoderConfigured` が true に戻る)。同じファイルの close 周りの再構成を扱う

## 解決方法

{未着手}
