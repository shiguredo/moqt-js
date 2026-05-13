# `connect()` の URL を `moqt://` スキームに対応させる

Created: 2026-05-13
Completed: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で `https://` (WebTransport) との使い分けが廃止され、統一 `moqt://` URI スキームが導入された。
WebTransport クライアントは `moqt://` を `https://` に置換して WebTransport セッションを確立する。

> The MOQT URI scheme is defined as follows, using definitions from [RFC3986]:
>
> moqt-URI = "moqt" "://" authority path-abempty [ "?" query ]
>
> -- draft-ietf-moq-transport-18 §3.1.1

> When the client uses WebTransport, it constructs an https URI from the moqt URI by replacing the scheme with https.
> For example, moqt://example.com/path becomes https://example.com/path.
>
> -- draft-ietf-moq-transport-18 §3.1.3

moqt-js の `connect()` は WebTransport 専用のため、スキーム置換 (`moqt://` → `https://`) と
最低限のバリデーションを追加する。Native QUIC の authority/path/query 伝送は対象外。

## 変更内容

### 1. `connect()` に `moqt://` スキーム処理を追加する (`src/index.ts`)

- 関数の先頭で URL 文字列に対してスキーム変換を行う
- `moqt://` で始まる場合は `https://` に置換し、置換後の文字列を `new WebTransport()` に渡す
- `https://` で始まる場合はそのまま通過させる（後方互換のため当面許容する）
- どちらでもない不正なスキームの場合は `Error` を throw する
- fragment (`#...`) が含まれる場合は除去して WebTransport に渡す
  - 除去後の fragment 値の保存は 0183 が担当する

### 2. JSDoc とコード例を `moqt://` に更新する

- `src/index.ts:155` の `@param url` 説明を `MOQT URI (e.g., "moqt://example.com/moqt")` に変更する
- `src/index.ts:164` のコード例の URL を `"moqt://example.com/moqt"` に変更する
- `src/createMediaPublisher.ts:651` の JSDoc の URL 例を更新する
- `src/createMediaSubscriber.ts:712` の JSDoc の URL 例を更新する

### 3. devtools のデフォルト URL を更新する

- `devtools/src/signals/connectionSettings.ts:14` のデフォルト値を `"moqt://127.0.0.1:4443/moqt"` に変更する
- `devtools/src/webtransport-devtools/` 配下は **変更対象外**（純粋な WebTransport デバッグツールであり MOQT URI スキームとは無関係）

### 4. E2E テストのデフォルト URL を更新する

- `tests/e2e/main.ts` のデフォルト URL 文字列を更新する
- `tests/e2e/index.html` のデフォルト値を更新する

## 該当箇所

| ファイル                                        | 変更内容                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `src/index.ts:184-212`                          | `connect()` 関数にスキーム変換ロジックを追加する。JSDoc の URL 例を更新する |
| `src/createMediaPublisher.ts:651`               | JSDoc の `@param url` の例を `moqt://` に更新する                           |
| `src/createMediaSubscriber.ts:712`              | JSDoc の `@param url` の例を `moqt://` に更新する                           |
| `devtools/src/signals/connectionSettings.ts:14` | デフォルト URL を `moqt://127.0.0.1:4443/moqt` に変更する                   |
| `tests/e2e/main.ts`                             | デフォルト URL 文字列を更新する                                             |
| `tests/e2e/index.html`                          | デフォルト値を更新する                                                      |

## 期待される動作

- `connect("moqt://example.com/moqt")` は内部で `new WebTransport("https://example.com/moqt")` を実行する
- `connect("moqt://example.com/moqt?foo=bar")` は `new WebTransport("https://example.com/moqt?foo=bar")` を実行する（クエリ保持）
- `connect("https://example.com/moqt")` は従来通りそのまま WebTransport に渡す（後方互換）
- `connect("moqt://example.com/moqt#track:video")` は fragment を除去し `new WebTransport("https://example.com/moqt")` を実行する
- `connect("moqt://example.com/.well-known/moqt")` は `new WebTransport("https://example.com/.well-known/moqt")` を実行する
- `connect("ftp://example.com/moqt")` は `Error` を throw する
- `connect("")` は `Error` を throw する
- `connect("moqt://")` は `Error` を throw する（authority の host が空）

## テスト方針

### 単体テスト (`src/index.test.ts` を新設する)

- 有効な `moqt://` URL が正しく `https://` に変換されること
- `https://` がそのまま通過すること
- `moqt://` でも `https://` でもないスキームがエラーになること
- クエリパラメータが変換後も保持されること
- fragment が除去されること（変換結果に fragment が含まれないこと）
- 空文字列がエラーになること
- authority の host が空の URL がエラーになること

### 結合テストの確認

- 既存の `setup.test.ts`、`setup.prop.ts` は `connect()` の URL 変換を経由しないため修正不要

## 影響範囲

- `connect()` の URL パラメータの取りうる値が `moqt://` に拡張される（後方互換あり）
- `createMediaPublisher` / `createMediaSubscriber` の `url` パラメータも同様に `moqt://` を受け付ける
- devtools の接続先入力が `moqt://` 形式になる
- API シグネチャに変更はない（`url: string` のまま）

## 関連 issue

- 0183: fragment identifier の保存と利用を追加する（fragment 除去後の値保存は 0183 が担当）
- 0182 を先に実装し、その後に 0183 を実装する順序を推奨する

## 備考

- `new WebTransport()` がブラウザ実装レベルで `moqt://` を直接受け付けるようになった場合、
  スキーム変換ロジックを削除できる。現時点では `https://` のみ受け付ける前提で実装する
- GOAWAY の `newSessionUri` はサーバーから受信する値であり、クライアント側では変換しない
- `.env` の `TEST_MOQT_HTTPS_URI` 変数名は変更しない（値として `moqt://` も `https://` も受け付ける）

## 解決方法

CLAUDE.md (AGENTS.md) の「draft による仕様変更は後方互換性を維持せず破壊的変更を行う」方針に従い、
`https://` の後方互換は維持せず `moqt://` 必須に切り替えた。

- `src/moqtUri.ts` を新設し `normalizeMoqtUri()` を実装した
  - draft-ietf-moq-transport-18 §3.1.3 に従い `moqt://` を `https://` に置換する
  - authority 部 (RFC 3986 §3.2) の host を自前で検証する
    （`new URL("https:///path")` は `https://path/` と解釈されるため URL コンストラクタだけでは検出できない）
  - IPv6 リテラル (`[::1]:port`) と userinfo (`user@host`) に対応する
  - fragment (`#...`) は draft-ietf-moq-transport-18 §3.1.2 に従い除去する
  - `moqt://` 以外のスキーム / 空文字列 / authority host が空の場合は `Error` を throw する
- `src/index.ts` の `connect()` で `normalizeMoqtUri()` を呼び、変換後 URL を `new WebTransport()` に渡す
- `src/index.ts` / `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts` の JSDoc を `moqt://` 例に更新した
- `devtools/src/signals/connectionSettings.ts` のデフォルト URL を `moqt://127.0.0.1:4443/moqt` に変更した
- `src/moqtUri.test.ts` を新設し、変換・バリデーション・fragment 除去の単体テストを追加した
  （issue 本文では `src/index.test.ts` だが、`connect()` は WebTransport を必要とするため
  純粋関数 `normalizeMoqtUri` を独立ファイルに切り出してテスト可能とした）
- `tests/e2e/main.ts` と `tests/e2e/index.html` は env から URL を取得するためデフォルト URL を持たず変更対象外とした
- 後方互換を維持しない方針のため、E2E 環境変数の名前と値を `moqt://` 専用に切り替えた
  - `.env.example` / `.github/workflows/ci.yml` / `tests/e2e/connect.spec.ts` / `tests/e2e/pubsub.spec.ts` の
    `TEST_MOQT_HTTPS_URI` を `TEST_MOQT_URI` に変更した
  - GitHub Secrets / ローカル `.env` の値は別途 `moqt://` 形式に更新する必要がある

確認:

- `vp run test` 全 558 件パス
- `vp run build` 成功
