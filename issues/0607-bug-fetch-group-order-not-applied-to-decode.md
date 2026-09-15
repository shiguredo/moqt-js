# FETCH の GROUP_ORDER が復号に反映されない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetch-group-order-decode
- Polished: {YYYY-MM-DD}

## 目的

`Session.fetch()` の `groupOrder` オプションで Descending を指定すると、ワイヤには GROUP_ORDER パラメータが載るが FETCH 応答の復号は Ascending の式のままになる。draft-ietf-moq-transport-21 §11.4.1.1 は Group Order によって Group ID の計算式が変わることを定めており、現状は 2 件目以降の Object の Location が誤る。取得した Object をアプリへ誤った Group ID で渡すため、FILTER 評価やカタログ構築にも影響する。

## 現状

- `buildFetchParameters` (`src/session/params.ts`) は `options.groupOrder` を GROUP_ORDER (0x22) として送信する
- `FetcherImpl` (`src/fetcher.ts`) の `fetchGroupOrder` は `GroupOrder.ASCENDING` で初期化され、`setFetchOkInfo` の第 4 引数 `groupOrder` に値を渡す経路がない
- `Session.fetch()` (`src/session.ts`) は FETCH_OK 受理時に `setFetchOkInfo` を 3 引数で呼ぶ (`src/session/bidi.ts`)
- `SessionImpl` は `incomingProcessFetchObjects` へ `fetcher.getGroupOrder()` を渡すため、Descending を要求しても Ascending の式 (`prior + delta + 1`) で復号する
- fill fetch 経路は `resolveFillGroupOrder` で要求時の値を `FillFetchTarget.groupOrder` に保持しており、通常 FETCH だけが非対称になっている

draft-ietf-moq-transport-21 §11.4.1.1:

> If the Group ID Delta field is present on an Object other than the first, the Group ID is computed from the Group ID Delta and the prior Object's Group ID. If the Group Order is Ascending, the Group ID is the prior Object's Group ID plus the Group ID Delta + 1. If the Group Order is Descending, the Group ID is the prior Object's Group ID minus the (Group ID Delta + 1).

## 設計方針

- `Session.fetch()` が確定した Group Order を `FetcherImpl` へ渡す。`setFetchOkInfo` の第 4 引数を使うか `setGroupOrder` を新設するかは実装時に決める
- Group Order はリクエスト側の値であり FETCH_OK には出現しない (§9.20.9 の出現先一覧)。`Session.fetch()` の `options.groupOrder` を単一の出所とし、FETCH_OK のデコード結果からは導かない
- fill fetch と同じく「要求時の値を保持して復号に使う」形に揃える

## 完了条件

- `session.fetch(..., { groupOrder: "Descending" })` で取得した FETCH 応答の 2 件目以降の Group ID が Descending の式で復号される
- `groupOrder` 省略時は Ascending として復号される
- Descending 指定で複数 Group の FETCH 応答をデコードするテストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.20.9 (GROUP ORDER Parameter)
- draft-ietf-moq-transport-21 §11.4.1.1 (Flags)
- draft-ietf-moq-transport-21 §3.3.1 (Location Filters)
