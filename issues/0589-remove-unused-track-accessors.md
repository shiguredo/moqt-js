# 未使用の Track アクセサ (namespace / trackName) を削除する

- Created: 2026-09-12
- Completed: {YYYY-MM-DD}
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
