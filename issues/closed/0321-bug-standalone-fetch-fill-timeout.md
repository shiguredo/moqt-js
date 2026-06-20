# Standalone Fetch で FILL_TIMEOUT パラメータを送信する

- Priority: High
- Created: 2026-06-17
- Completed: 2026-06-20
- Model: Opus 4.8
- Branch: feature/fix-standalone-fetch-fill-timeout
- Polished: 2026-06-20

## 目的

`Session.fetch()` （Standalone Fetch）でも `FILL_TIMEOUT` パラメータを `FETCH` メッセージに含めるように修正する。`FetchOptions` に `fillTimeout` が定義されているが、`fetch()` 内部では `parameters: []` のままで追加されていない。

## 優先度根拠

`FILL_TIMEOUT` は relay が欠損オブジェクトの fill 待機に費やす最大時間を指示するパラメータである。Standalone Fetch で欠落していると、サーバー側がデフォルト動作を使用し、意図しない待機時間が発生する。API オプションと実装の不一致はバグとして High。

## 現状

- `src/session.ts` L514: `FetchOptions.fillTimeout?: bigint` が定義されている
- `src/session.ts` L1552-1563: `fetch()` の `FETCH` メッセージ構築で `parameters: []` 固定
- `src/session/bidi.ts` L874-879: Joining Fetch 側では `fillTimeout` が存在する場合に `FILL_TIMEOUT` パラメータを正しく追加している

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.2.5 (FILL_TIMEOUT)**: `FILL_TIMEOUT` (Parameter Type 0x0A) は `FETCH` メッセージに出現可能 (MAY)
- **§10.12.1 (FETCH)**: `FETCH` メッセージはパラメータリストを含む

## 設計方針

`Session.fetch()` の `FETCH` メッセージ構築時に、`options.fillTimeout` が指定されていれば `FILL_TIMEOUT`（varint エンコード）パラメータを `parameters` 配列に追加する。`bidi.ts` L874-879 の実装と同一のパターンを用いる。

変更にあたり、`parameters: []` を `parameters: [] as Parameter[]` に型アサーションする。TypeScript は `[]` を `never[]` と推論するため、`.push()` で `Parameter` 型の要素を追加する際に型エラーとなるのを防ぐ（`bidi.ts` L871 で既に同様の対処が行われている）。

## 変更対象ファイル

- `src/session.ts`: `fetch()` の `parameters: []` を条件付きで `fillTimeout` を含めるように修正する（6 行程度の追加）
- `CHANGES.md` に `[FIX]` エントリを追記する

## テスト方針

- 既存の全テストが PASS することを必須とする
- `fetch()` は WebTransport 双方向ストリーム送信を含むため直接単体テスト不可。`decodeFetchPayload` → `encodeFetchPayload` のラウンドトリップテストで `fillTimeout` パラメータの有無を検証する

## 完了条件

- `Session.fetch()` で `fillTimeout` オプションが指定された場合、`FETCH` メッセージに `FILL_TIMEOUT` パラメータが含まれる
- `fillTimeout` 未指定時は既存挙動が変わらない
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリが追記される

## 解決方法

`Session.fetch()` の `FETCH` メッセージ構築時に `options.fillTimeout` が指定されていれば `FILL_TIMEOUT` パラメータを追加するようにした。`bidi.ts` の Joining Fetch と同一のパターンを使用した。

変更ファイル:

- `src/session.ts`: `fetch()` の `parameters` に `fillTimeout` 追加
- `CHANGES.md`: `[FIX]` エントリ追記
