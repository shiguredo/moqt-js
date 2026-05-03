# Canvas ダミー映像で relay 経由 pub/sub の E2E テストを追加する

Created: 2026-04-30
Model: Opus 4.7

## 概要

issue 0114 では `connect()` の SETUP 完了までを検証した。実 relay (Sora MOQT 等) を介して、moqt-js が **VP8 で publish した Canvas ダミー映像を別クライアントが subscribe してデコードできる** ことまで自動検証する。

## 根拠

- e2e-test の本来の期待値は relay を介した pub / sub の動作確認
- `getUserMedia` は Playwright で扱うのに難がある。Canvas `captureStream()` で MediaStream を作れば回避できる
- VP8 はブラウザ・relay 双方の対応範囲が広い

## スコープ

- Playwright の **2 つの BrowserContext** (Publisher 用 / Subscriber 用) を立ち上げ、同じ relay (`TEST_MOQT_HTTPS_URI`) に対して同一 namespace で pub/sub する
- 5 秒間 publish/subscribe を継続し、その間に **デコードに失敗しない** ことを成功条件とする
- ピクセル値検査は本 issue の対象外
- 認証トークンは両 context に同じ `TEST_MOQT_AUTH_TOKEN` を渡す前提

## 成功条件

- `publisher` の `onError` が一度も呼ばれない
- `subscriber` の `onError` が一度も呼ばれない
- 5 秒経過時点で `publisher.state === "publishing"` (途中で `closed` / `stopped` に遷移していない)
- 5 秒経過時点で `subscriber.state === "active"` (途中で `closed` に遷移していない)

`subscriber.getStats().video.framesReceived` の閾値判定は relay 挙動依存で flaky になりうるため、本 issue では入れない。

## 変更内容

### 共通ヘルパ

- `tests/e2e/helpers.ts` を新設し、`waitForE2EReady(page)` を `connect.spec.ts` から切り出す
- `connect.spec.ts` も helpers 経由に変更する

### Vite アプリ側 (`tests/e2e/main.ts`)

- `publishCanvas({ url, authorizationTokenValue, namespace, durationMs })` を追加
  - 320x240 の Canvas を `setInterval` で塗り続ける (時刻に応じた色変化)
  - `canvas.captureStream(30)` で MediaStream を生成
  - `createMediaPublisher` (video のみ、`codec: "vp8"`、`bitrate: 500_000`) で `publisher.start(stream)`
  - `durationMs` 経過後に `publisher.close()` し、`{ finalState, errors }` を返す
- `subscribeCanvas({ url, authorizationTokenValue, namespace, durationMs })` を追加
  - `createMediaSubscriber` (video のみ、`codec: "vp8"`) で `subscriber.start()`
  - `durationMs` 経過後に `subscriber.close()` し、`{ finalState, errors, hasVideoTrack }` を返す

### spec (`tests/e2e/pubsub.spec.ts`)

- `browser.newContext()` を 2 つ作って Publisher 用 / Subscriber 用 Page にする
- namespace は `["e2e", crypto.randomUUID()]` でユニーク化
- Subscriber を先に subscribe 開始 → 200 ms 後に Publisher を起動 → `Promise.all` で待つ
- 成功条件 (上記) を assert

### 設定

- `playwright.config.ts` の `timeout` を `10_000` から `30_000` に引き上げる (Catalog 待ち + 5 秒受信 + 後片付けに 10 秒は厳しい)

## 影響範囲

- 新規: `tests/e2e/helpers.ts`、`tests/e2e/pubsub.spec.ts`
- 変更: `tests/e2e/main.ts`、`tests/e2e/connect.spec.ts`、`playwright.config.ts`、`CHANGES.md`
