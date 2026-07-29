# MSF URI fragment の connection による transport 選択を適用する

- Priority: Medium
- Created: 2026-07-24
- Completed: 2026-07-30
- Model: Composer
- Branch: feature/change-msf-connection-fragment-transport
- Polished: 2026-07-30

## 目的

draft-ietf-moq-msf-01 §11.1.1 の `connection=q|wt` は Native QUIC / WebTransport の選択を示す。"connection - mandates the client to use a particular connection type when connecting to the server. There are two allowed values - 'q' or 'wt'. 'q' indicates that a Native QUIC connection MUST be used. 'wt' indicates that a WebTransport connection MUST be used."。`getConnectionParameter` は実装済みだが、接続 API への強制適用は未配線である (`#0316` で helper まで)。

## 優先度根拠

fragment で `connection=q` と指定してもサイレントに無視され、WebTransport で接続される。呼び出し側は Native QUIC を意図しているのに異なる transport で接続し、想定外の挙動になり得る。helper はあるので適用配線の欠落が実害になるため Medium。

## 現状

- `parseMsfFragmentValue` / `getConnectionParameter` (`src/msf.ts`) は `"q"` / `"wt"` を返す。`q` / `wt` 以外は `undefined` を返す（silent ignore）
- 高レベル API の connect は WebTransport 前提で、`connection` 値を見て分岐・拒否しない
- `connect()` (`src/index.ts`) 内で `normalizeMoqtUri(url)` が fragment を解析済み。`new WebTransport(httpsUrl, transportOptions)` は無条件実行
- `SessionImpl.fragment` (`src/session.ts`) に `MoqtFragment | null` が既に公開されている
- reserved key のうち range / c4m helper は `#0356`。本 issue は `connection` の transport 適用のみ

## 設計方針

1. `connect()` (`src/index.ts`) 内の `new WebTransport()` 直前にチェックを挿入する。`fragment.type === "msf"` の場合のみ `parseMsfFragmentValue` を呼び出し、`getConnectionParameter` で `connection` 値を取得する
2. `connection=q` は Native QUIC 未実装のため明確にエラーとする（エラーメッセージはプロジェクト慣例に従い先頭小文字・期待値と実値を含む）
3. `connection=wt` は現行 WebTransport 接続を許可する（実質 no-op。既存挙動を維持するだけ）
4. `connection` 欠如時は現状どおり（デフォルト WebTransport）
5. `q` / `wt` 以外の不正値は `getConnectionParameter` が `undefined` を返すため、`connection` 欠如と同じ扱いにする（silent ignore。仕様は不正値の reject を規定していない）

## 完了条件

- fragment の `connection` が接続開始前に解釈される
- `connection=q` (Native QUIC 未実装時) で失敗理由が分かるエラーになる
- テストがある
- `CHANGES.md` の `## develop` に `[CHANGE]` を追記する
- `vp test run` / `vp build` が pass する

## 関連

- `#0316` (closed) `getConnectionParameter`
- `#0356` URI fragment reserved key helper (range / c4m。本適用とは独立)
