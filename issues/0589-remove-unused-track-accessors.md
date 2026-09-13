# 未使用の Track アクセサ (namespace / trackName) を削除する

- Created: 2026-09-12
- Completed: 2026-09-13
- Branch: feature/remove-unused-track-accessors
- Polished: {YYYY-MM-DD}

## 目的

`SubscriberImpl` / `FetcherImpl` / `PublisherImpl` の `get namespace()` と `get trackName()` は、リポジトリ全体から読み取られておらず、公開インターフェース (`Subscriber` / `Fetcher` / `Publisher`) にも宣言されていない。死にコードを削除し、保守対象と意図しない公開面を減らす。

## 現状

- `src/subscriber.ts` の `SubscriberImpl`、`src/fetcher.ts` の `FetcherImpl`、`src/publisher.ts` の `PublisherImpl` に `get namespace()` / `get trackName()` がある。
- `Subscriber` / `Fetcher` / `Publisher` の各インターフェースはこれらを宣言していない。
- `src/` / `tests/` / `devtools/` / `examples/` / `docs/` / `README.md` を横断検索しても、これらのアクセサを読む箇所が無い (同名の `.namespace` / `.trackName` は MSF カタログやメッセージ型、設定オブジェクトなど別ドメインのオブジェクトに対する読み取り)。
- `PublisherImpl` の private フィールド `publisherNamespace` / `publisherTrackName` はこれら 2 つのアクセサからのみ参照されているため、アクセサだけを削除すると `noUnusedLocals` により `tsc --noEmit` が失敗する。
- `SubscriberImpl` / `FetcherImpl` の同名 private フィールドは比較キーの生成 (`getFullTrackNameKey`) で使うため残す必要がある。

## 設計方針

1. `SubscriberImpl` / `FetcherImpl` / `PublisherImpl` の `get namespace()` / `get trackName()` を削除する。
2. `PublisherImpl` の private フィールド `publisherNamespace` / `publisherTrackName` とコンストラクタでの代入も削除する (`SubscriberImpl` / `FetcherImpl` の同名フィールドは残す)。
3. 挙動は変えない。公開 API にも影響しない (`src/index.ts` は各インターフェースの型のみを再エクスポートしている)。
4. 削除後に読み取りが残っていないことを `rg` で確認し、`tsc --noEmit` とテストで裏付ける。

## 完了条件

- 3 クラスから未使用の `get namespace()` / `get trackName()` が削除され、`PublisherImpl` の未使用 private フィールドも削除されていること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加すること (未使用コードの削除のため)。

## 関連

- `SubscriberImpl` (`src/subscriber.ts`) / `FetcherImpl` (`src/fetcher.ts`) / `PublisherImpl` (`src/publisher.ts`)

## 解決方法

設計方針のとおり、3 クラスから未使用のアクセサを削除した。挙動と公開 API は変えていない。

- `src/subscriber.ts` の `SubscriberImpl` から `get namespace()` / `get trackName()` を削除した。private フィールド `subscriberNamespace` / `subscriberTrackName` は `getFullTrackNameKey()` の比較キー生成で使うため残した。
- `src/fetcher.ts` の `FetcherImpl` から `get namespace()` / `get trackName()` を削除した。private フィールド `fetcherNamespace` / `fetcherTrackName` は同じく比較キー生成で使うため残した。
- `src/publisher.ts` の `PublisherImpl` から `get namespace()` / `get trackName()` を削除し、これらからのみ参照されていた private フィールド `publisherNamespace` / `publisherTrackName` とコンストラクタでの代入も削除した。
- `PublisherImpl` のコンストラクタ引数 `namespace` / `trackName` は、`PublisherImpl` を生成する箇所がリポジトリ全体で 74 箇所 (ほとんどがテスト) あり、引数順を変えると広範囲の書き換えになるため残し、未使用引数として `_namespace` / `_trackName` に改名した。`noUnusedParameters` は `_` 接頭辞を許容する。
- `CHANGES.md` の `## develop` の `### misc` に `[CHANGE]` を追加した。

## 検証

- 削除後に `rg` で `get namespace()` / `get trackName()` の読み取りが残っていないことを確認した。
- `pnpm test run`: 70 ファイル / 2,090 テスト全通過
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
- 差分: 4 ファイル、+8 / -30 行
