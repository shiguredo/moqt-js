# リクエスト種別ごとの送信可能パラメータ不足

- Created: 2026-09-06
- Completed: 2026-09-13
- Branch: feature/add-request-parameter-coverage
- Polished: YYYY-MM-DD

## 目的

仕様が送信可とするパラメータを送れず、群順序の要求や認可付き取得ができない。不足分を追加する必要がある。

## 現状

- `src/session/params.ts` の `buildSubscribeTracksParameters` は `GROUP_ORDER` / `FORWARD` / Range Filters / `INCLUDE_PROPERTIES` のみで、`LOCATION_FILTER` / `FILL_PARAMETERS` / `SUBSCRIBER_PRIORITY` / `AUTHORIZATION_TOKEN` を送れない (§10.20.1、§5.1.6、§10.2.2)。
- `buildFetchParameters` は `GROUP_ORDER` / `SUBSCRIBER_PRIORITY` を送れない (§10.2.7、§10.2.8)。`§10.13` の要求群順序を指定できない。
- `TrackStatusOptions` / `publishNamespace` / `SubscribeTracksOptions` は `AUTHORIZATION_TOKEN` を送れない (§10.2.2)。

## 設計方針

1. 各ビルダーと Options 型に不足パラメータを追加する (既存の送信ガードと検証に合わせる)。
2. 受信側の受理範囲と対になっていることを確認する。

## 完了条件

- 上記パラメータを各リクエストで送信できること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10.20.1 / §10.2.2 / §10.2.7 / §10.2.8 / §5.1.6 / §10.13

## 解決方法

各ビルダーと Options 型に不足パラメータを追加した。出現可能かは `refs/moq/draft-ietf-moq-transport-21.txt` の各節の明文で確認している。

### FETCH (`FetchOptions`)

- `subscriberPriority?: number` を追加し、`buildFetchParameters` が `SUBSCRIBER_PRIORITY` (0x20) を送るようにした。§9.20.9 は "It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE" と定める。
- `groupOrder?: "Ascending" | "Descending"` を追加し、`GROUP_ORDER` (0x22) を送るようにした。§9.20.19 は "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH" と定める。FETCH_OK には出現できないため、応答でエコーされることはない旨をコメントに残した。

### TRACK_STATUS (`TrackStatusOptions`)

- `authorizationToken?: AuthorizationToken` を追加し、`buildTrackStatusParameters` が `AUTHORIZATION_TOKEN` (0x03) を送るようにした。§9.20.3 は TRACK_STATUS での出現を認めている。

### PUBLISH_NAMESPACE (`PublishNamespaceOptions` を新設)

- `publishNamespace(namespace, callbacks, options?)` に第 3 引数を追加した。`subscribeNamespace` と同じ形で `{ authorizationToken }` を受ける。§9.20.3 は PUBLISH_NAMESPACE での出現を認めている。
- 呼び出し側はリポジトリ内に無く (テストも含めて 0 件)、既存シグネチャとの互換性は保たれる。

### SUBSCRIBE_TRACKS (`SubscribeTracksOptions`)

§9.18.1 の "Any Parameter that can be specified on a Subscription (ie: in SUBSCRIBE) is valid in SUBSCRIBE_TRACKS, unless otherwise specified." と "To join Tracks initiated via the resulting PUBLISHes, the subscriber can specify a Location Filter and optionally include FILL_PARAMETERS" に基づき、4 つを追加した。

- `subscriberPriority?: number` → `SUBSCRIBER_PRIORITY` (0x20)
- `filter?: LocationFilter` → `LOCATION_FILTER` (0x21)
- `fill?: FillRequestOptions` → `FILL_PARAMETERS` (0x23)
- `authorizationToken?: AuthorizationToken` → `AUTHORIZATION_TOKEN` (0x03)。§9.20.3 の "This Parameter MUST NOT be copied from a SUBSCRIBE_TRACKS to the resulting PUBLISH message Parameters." をコメントに残した。

あわせて `buildFillParameters` の `context` 引数に `"SUBSCRIBE_TRACKS"` を追加した (エラーメッセージ用の文字列で、検証規則は外側の呼び出しと同じ)。

### 受信側の受理範囲との対称性

`GROUP_ORDER` / `SUBSCRIBER_PRIORITY` は `PUBLISH_ALLOWED_PARAMS` に含まれており、SUBSCRIBE_TRACKS の結果として届く PUBLISH でも受理される。受信側の変更は不要だった。

### テスト

`src/session/params.test.ts` に 11 件追加した (`buildFetchParameters` の 4 件、`buildTrackStatusParameters` の 2 件、`buildSubscribeTracksParameters` の 5 件)。未指定時に従来どおりの構成になることも検証している。

## 検証

- `pnpm test run`: 70 ファイル / 2,103 テスト全通過 (追加した 11 件を含む)
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
- 差分: 4 ファイル、+274 / -3 行
