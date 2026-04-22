# Transport を webTransport に固定し quic を削除

Created: 2026-04-22
Completed: 2026-04-22
Model: Claude Opus 4.7

## 概要

`Transport = "quic" | "webTransport"` 型と `_transport` フィールドを `SessionMachine` から削除する。
moqt-js はブラウザ専用クライアントであり、ネイティブ QUIC は利用できないため `webTransport` 固定で良い。

## 背景

AGENTS.md の moqt-js 方針:

> - ブラウザでのみ動作

`Transport` 型は `"quic"` バリアントを持つが:

- `SessionMachine.createClient()` の呼び出し箇所は `Session.initialize()` 内の `"webTransport"` 固定 1 箇所のみ
- 全テスト (`*.prop.ts` / `*.test.ts`) も `"webTransport"` リテラルを渡している
- `_transport === "quic"` のような分岐は存在しない (型上は未使用)

ブラウザでは [W3C WebTransport](https://www.w3.org/TR/webtransport/) しか使えず、ネイティブ QUIC stack へのアクセスは不可能。
`"quic"` バリアントは到達不能で、純粋な型負債となっている。

## 設計判断

- `Transport` 型自体を削除する
- `SessionMachine` のコンストラクタと `createClient()` から `transport` 引数を削除する
- `_transport` フィールドと `transport` getter を削除する
- 全テスト (`*.prop.ts` / `*.test.ts`) の `createClient` 呼び出しから `"webTransport"` リテラルを削除する
- `machine.prop.ts` の `transportArb` を削除する

## 作業内容

1. `src/session/types.ts` から `Transport` 型を削除
2. `src/session/machine.ts`:
   - コンストラクタから `transport` 引数を削除
   - `_transport` フィールドと `transport` getter を削除
   - `createClient()` シグネチャを `(setup)` に変更 (0090 適用後)
3. `src/session/session.ts` の `SessionMachine.createClient("webTransport", ...)` を `SessionMachine.createClient(...)` に置換
4. `src/session/*.prop.ts` / `*.test.ts` の `createClient` 呼び出しを更新
5. `src/session/machine.prop.ts` の `transportArb` 削除
6. `vp run typecheck` / `vp run test` / `vp run build` を全て通すこと

## 補足

`Setup` メッセージ自体は draft-ietf-moq-transport-17 §9.4 で transport 共通の制御メッセージなので、
`SessionMachine` から transport 概念を消しても仕様準拠性に影響は無い。
