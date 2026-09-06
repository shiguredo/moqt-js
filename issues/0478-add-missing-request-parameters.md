# リクエスト種別ごとの送信可能パラメータ不足

- Created: 2026-09-06
- Completed: YYYY-MM-DD
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
