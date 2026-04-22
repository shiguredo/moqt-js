# Role を client に固定し server 分岐を削除

Created: 2026-04-22
Completed: 2026-04-22
Model: Claude Opus 4.7

## 概要

`Role = "client" | "server"` 型と `_role` フィールドを `SessionMachine` から削除し、
client 専用の挙動 (Request ID 偶数採番、peer Request ID 奇数 parity 期待) に固定する。
GOAWAY 受信時の `_role === "server"` 分岐も削除する。

## 背景

AGENTS.md の moqt-js 方針:

> - クライアントとしてのみ動作

公開 API は `connect()` 経由の `SessionMachine.createClient()` のみで、`server` role に到達する経路は無い。
`Role` 型の `server` バリアントと、それを参照する分岐は全て dead code である。

draft-ietf-moq-transport-17 §9.1 (Request ID) によると:

- Client は偶数 (0, 2, 4, ...) を採番
- Server は奇数 (1, 3, 5, ...) を採番

クライアント専用の moqt-js では奇数採番は不要、peer (server) は奇数 parity 固定で良い。

## 設計判断

- `Role` 型自体を削除する
- `SessionMachine` から `_role` フィールド、`role` getter を削除する
- `RequestIdGenerator` のコンストラクタから `role` 引数を削除し、初期値を `0n` 固定にする
- `RequestIdTracker` のコンストラクタから `peerRole` 引数を削除し、奇数 parity 期待に固定する
- GOAWAY 受信時の「server が client から non-zero URI を受けた場合に拒否する」分岐を削除する (`machine.ts` 該当箇所)
- GOAWAY 送信時の「client は new_session_uri を空にする」ガードは「常時実施」に変更して残す (draft §9.5 準拠)

## 作業内容

1. `src/session/types.ts` から `Role` 型を削除
2. `src/session/requestId.ts` の `RequestIdGenerator` / `RequestIdTracker` から role 引数を削除
3. `src/session/machine.ts`:
   - コンストラクタから `role` 引数を削除
   - `_role` フィールドと `role` getter を削除
   - `createClient()` シグネチャを `(transport, setup)` に変更
   - GOAWAY 受信時の `_role === "server"` 分岐を削除
   - GOAWAY 送信時の `_role === "client"` ガードを無条件実施に変更
4. `src/session/requestId.prop.ts` から server ケースを削除し client only に整理
5. `src/session/machine.prop.ts` 等の `createClient` 呼び出し更新
6. `vp run typecheck` / `vp run test` / `vp run build` を全て通すこと
