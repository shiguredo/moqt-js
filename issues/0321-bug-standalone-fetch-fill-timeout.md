# Standalone Fetch で FILL_TIMEOUT パラメータを送信する

- Priority: High
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-standalone-fetch-fill-timeout

## 目的

Standalone Fetch (`Session.fetch()`) でも `FILL_TIMEOUT` パラメータを `FETCH` メッセージに含めるように修正する。現在は `FetchOptions` に `fillTimeout` が定義されているが、`Session.fetch()` 内部では `parameters: []` のままで追加されていない。Joining Fetch 側では正しく付与されている。

## 優先度根拠

`FILL_TIMEOUT` は relay/subscriber が過去の object をどこまで遡って取得すべきかを指示する重要なパラメータである。Standalone Fetch で欠落していると、サーバー側がデフォルト動作を使用し、意図しない範囲の object が返却されたり、必要な object が取得できなかったりする。API オプションと実装の不一致はバグとして High。

## 現状

- `src/session.ts` の `FetchOptions` 型 (L506-L524) には `fillTimeout?: bigint` が定義されている。
- `src/session.ts` の `Session.fetch()` (L1552-L1563) では、`FETCH` メッセージを構築する際に `parameters: []` を設定しており、`fillTimeout` が追加されていない。
- Joining Fetch の経路では `FILL_TIMEOUT` パラメータが正しく付与されていることが確認されている。

```typescript
// src/session.ts:1552-1563 (概略)
const fetchMessage: Fetch = {
  // ...
  parameters: [], // fillTimeout が含まれていない
};
```

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.2.5 (FILL_TIMEOUT)**: `FILL_TIMEOUT` は `SUBSCRIBE`、`FETCH`、`JOINING FETCH` 等で使用可能なパラメータ。
- **§10.12.1 (FETCH)**: `FETCH` メッセージはパラメータリストを含み、`FILL_TIMEOUT` を送信できる。

## 設計方針

`Session.fetch()` 内で `FetchOptions.fillTimeout` が指定されている場合、`FETCH` メッセージの `parameters` に `FILL_TIMEOUT` パラメータを追加する。

- パラメータ追加は `parameters` 配列の構築時に行う。
- `fillTimeout` が指定されていない場合は、空配列または他のパラメータのみのままとする。
- Joining Fetch 側の実装と共通化可能であれば helper 関数を抽出し、重複を避ける。
- `fillTimeout` の値範囲検証は、必要に応じて `params.ts` 等の既存検証関数を利用する。

## 完了条件

- `Session.fetch()` で `fillTimeout` オプションが指定された場合、`FETCH` メッセージに `FILL_TIMEOUT` パラメータが含まれる
- `fillTimeout` が指定されない場合の既存挙動が変わらない
- Joining Fetch 側との共通化または一貫性が保たれる
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
