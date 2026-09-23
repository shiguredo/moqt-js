# createMediaSubscriber の受信経路がテストされていない

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/test-media-subscriber-path-coverage
- Polished: {YYYY-MM-DD}

## 目的

`src/createMediaSubscriber.ts` は高レベル API でありながら、受信経路と停止経路を呼ぶテストが無い。Catalog からトラックを解決し、デコーダを構成し、映像 / 音声の Object を復号経路へ渡すまでの配線は、部品ごとの単体テストでしか検証されていない。配線が壊れても既存テストは通る。

## 現状

- `src/createMediaSubscriber.test.ts` の 41 テストは `processCatalogPayload` / `filterPendingCatalogObjects` / `resolveAuthorizationToken` / `extractTrackInfo` と、復号済みフレームの破棄 (所有権) の検証に限られる
- `handleVideoObject` / `handleAudioObject` / `setupDecoders` / `subscribeMediaTracks` / `stop` / `close` を呼ぶテストが無い
- 同ファイルは `new MediaSubscriberImpl(...)` を組み立てて復号コールバックを直接呼ぶ形であり、Object のハンドラは一度も通していない
- AGENTS.md はモック・スタブの利用を禁じているため、受信経路は実装クラスと実ストリームで検証する必要がある

## 設計方針

- 実装クラスと実ストリーム (実 `ReadableStream` / `WritableStream`、実 `SessionImpl`、実 Subscriber) を使い、映像 / 音声の Object が復号経路へ入るところまでを検証する
- `stop` と `close` の解放も同じ構成で検証する。0654 で状態遷移そのものを変える可能性があるため、本 issue では現状の契約を固定し、変更が必要になった差分は 0654 側で扱う
- ブラウザ API (`VideoDecoder` / `AudioDecoder` / `AudioContext` / `MediaStreamTrackGenerator`) の差し替えは既存テストと同じ差し替え点を使い、実装クラスそのものは差し替えない
- テストのログメッセージは日本語にする

## 完了条件

- 映像経路 / 音声経路 / 停止経路が実装を使って検証される
- 受信経路の主要な分岐 (未構成時のスキップ、description 変更時の再構成) がテストで固定される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0654 (createMediaSubscriber の stop がリソースを解放せず再開もできない)

## 解決方法

{未着手}
