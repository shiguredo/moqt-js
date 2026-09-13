# HIGH_LEVEL_API.md を現コードに合わせる

- Created: 2026-09-06
- Completed: 2026-09-13
- Branch: feature/fix-high-level-api-doc
- Polished: YYYY-MM-DD

## 目的

ドキュメント通りに書くと実行時失敗・無視される箇所があり、主要 API の欠落もある。現コードと一致させる必要がある。

## 現状

- 存在しない `setStream()` / `ready` 遷移、幽霊オプション `reorderTimeout`、逆の codec 必須表記がある。
- `onCatalog` / `getCatalog` / `catalog` / 認可系 / `pendingSubgroup` が欠落する。
- VIDEO_CONFIG 等の「未配線」一括りが現コード (送信あり) と矛盾する。

## 設計方針

1. 現コードのシグネチャ・状態遷移・オプションに合わせて書き直す。
2. 自動処理の列挙を実装と一致させる。

## 完了条件

- 記載の全 API が現コードと一致すること。
- `vp check` が通ること (markdownlint 対象のため)。

## 解決方法

`docs/HIGH_LEVEL_API.md` を実装 (`src/codec/types.ts` の各インターフェース) と突き合わせて修正した。

### 存在しない API・状態の削除

- `setStream(stream: MediaStream)` を削除した。`MediaPublisher` の実装は `start(stream: MediaStream)` であり、`setStream` はリポジトリ全体に存在しない。メソッド表を `start(stream)` に修正し、使用例 (`publisher.setStream(stream); await publisher.start();`) を `await publisher.start(stream);` に直した。`setStream()` を使っていた「カメラ切り替え」節は実行不能なため削除した。
- `MediaPublisherState` から `"ready"` を削除した。実装の union は `"created" | "publishing" | "paused" | "stopped" | "closed"` であり、`setState()` の呼び出しも `publishing` / `paused` / `stopped` / `closed` の 4 つのみである。状態遷移図も `created ──start(stream)──► publishing` に書き直した。
- 幽霊オプション `reorderTimeout` を削除した。`MediaSubscriberOptions` に存在せず、リポジトリ全体で参照が無い。

### 実装と逆だった記述の修正

- 購読側の `audio.codec` / `video.codec` を必須と書いていたが、実装は `codec?: AudioCodecType` / `codec?: VideoCodecType` であり「省略時は Catalog から自動取得」である。任意に修正した。

### 欠落していた API の追加

- `MediaPublisher.getCatalog()` と `MediaSubscriber.catalog` / `MediaSubscriberCallbacks.onCatalog` を追加した。使用例の節「カタログの受信」も新設した。
- `MediaPublisherOptions` / `MediaSubscriberOptions` の `authorizationToken` / `pendingSubgroup` と、`MediaSubscriberOptions.getAuthorizationToken` を追加した。使用例の節「認可トークン」も新設した。

### 受信側統計の型名の修正

- 「統計情報」節が受信側を `AudioStats` / `VideoStats` と書いていたが、これらは**送信側**の型である。受信側の正しい型 `AudioReceiverStats` / `VideoReceiverStats` と、`getStats()` の戻り値型 `MediaReceiverStats` に修正した。

### LOC コンテナ節

- 「自動処理する LOC Properties」の記述は実装と一致していた (`LOC.encodeAudioProperties` / `LOC.encodeVideoProperties` を呼んでいる)。送信経路の関数名と TIMESTAMP の単位 (Unix epoch マイクロ秒、TIMESCALE なし) を補足した。
- VIDEO_CONFIG / AUDIO_CONFIG / AUDIO_LEVEL / TIMESCALE は高レベル API が送信しないことを明記し、受信側が description を得られない帰結も書いた。

## 検証

- `vp check` が通る (フォーマット 798 ファイル / lint・型チェック 124 ファイル)
- `rg` で `setStream` / `reorderTimeout` / `"ready"` が 0 件になったことを確認した
- `pnpm test run`: 70 ファイル / 2,110 テスト全通過 (テストコードの変更なし)
- 差分: 2 ファイル、+117 / -48 行 (docs は 421 → 484 行)
