# Sans I/O な Session プロトコル層を導入する

Created: 2026-04-19
Model: Claude Opus 4.7

## 概要

現在の `src/session.ts` (3839 行) は WebTransport I/O と MOQT プロトコル状態管理が密結合しており、以下の問題を抱えている。

- 単体テストで WebTransport 相当を用意しないと検証できず、fast-check ベースの PBT を書きにくい
- draft 改訂時の差分がファイル全体に散らばり、仕様との対応が追いにくい
- 状態遷移コードが非同期 I/O の中に埋もれて読みにくい

姉妹実装 moqt-rs で確立している sans-I/O Session 状態機械のアーキテクチャを moqt-js に導入し、以下を達成する。

- I/O ゼロの純粋な状態機械を別層として切り出す
- draft 追従のコストをプロトコル層に閉じ込める
- `SessionEvent` を discriminated union 化して I/O 層と状態管理層の責務を明確に分離する
- fast-check ベースの PBT を各モジュールに追加する

## RFC 根拠

本作業は `draft-ietf-moq-transport-17` の以下のセクションを正確に実装するための再構築である。

- Section 3 (Sessions)
- Section 5 (Subscriptions and Publications)
- Section 6 (Track Discovery)
- Section 9 (Control Messages)

参考: https://www.ietf.org/archive/id/draft-ietf-moq-transport-17.html

## 設計判断

| 項目             | 決定                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| コアクラス名     | `SessionProtocol`                                                                                                             |
| コアファイル     | `src/session/protocol.ts`                                                                                                     |
| メソッド命名     | `handleControl` / `handleRequest` / `handleStreamMessage` / `nextEvent` / `tick` / `close` / `SessionProtocol.createClient()` |
| `SessionState`   | `"setup" \| "established" \| "closing" \| "closed"` (破壊的変更、4 状態化)                                                    |
| `SessionEvent`   | discriminated union、`type` フィールド camelCase                                                                              |
| 数値型           | `bigint` 統一                                                                                                                 |
| エラー           | 既存 `src/error.ts` の `SessionError` クラスを再利用                                                                          |
| 例外方針         | コア内部の違反は `closeSession` イベントで伝える。throw は最小                                                                |
| 非同期禁止       | コア層は `Promise` / `async` / `setTimeout` / `Date.now()` / WebTransport 参照なし                                            |
| 時刻駆動         | コアは `tick(nowMs: number): void`                                                                                            |
| ディレクトリ     | `src/session.ts` 廃止、`src/session/` に完全移行                                                                              |
| 公開 API         | `Session` interface / `connect()` は維持                                                                                      |
| `ControlMessage` | `src/message/control.ts` に discriminated union を新設                                                                        |

## ブランチ

- `feat/sans-io-session-protocol`

## Phase 分解

| #   | Phase                   | 主な成果物                                                                                    |
| --- | ----------------------- | --------------------------------------------------------------------------------------------- |
| 0   | 足場                    | `src/session/{index,impl}.ts` 新設、旧 `src/session.ts` を移動、`src/message/control.ts` 新設 |
| 1   | 型                      | `src/session/types.ts` (Role / Transport / SessionState / SessionEvent / 各エンティティ型)    |
| 2   | SETUP                   | `src/session/protocol.ts` (createClient / handleControl / nextEvent / tick / close)           |
| 3   | Request ID              | `src/session/requestId.ts` (parity / 重複 / required_delta 検証)                              |
| 4   | Subscription            | `src/session/subscription.ts`                                                                 |
| 5   | Fetch                   | `src/session/fetch.ts`                                                                        |
| 6   | Namespace / TrackStatus | `src/session/namespace.ts`                                                                    |
| 7   | AuthTokenCache          | `src/session/authTokenCache.ts` + `src/message/parameter.ts` 拡張                             |
| 8   | GOAWAY / tick           | `src/session/goaway.ts`                                                                       |
| 9   | 整理                    | `src/session/impl.ts` から二層管理の重複を削除                                                |

## 各 Phase の作業サイクル

1. テスト先行 (`*.prop.ts` と影響を受ける既存 `*.test.ts` を先に書く/修正)
2. プロトコル側実装
3. `SessionImpl` の該当プリミティブ状態をプロトコル呼び出しに置換
4. `vp run typecheck` / `vp run test` / `vp run build` すべて緑
5. `CHANGES.md ## develop` に該当エントリを追記
6. 1 Phase = 1 コミット

## 影響範囲

- **破壊的変更**: `SessionState` の値域が `"connected" | "closed"` から `"setup" | "established" | "closing" | "closed"` に変わる。本プロジェクト内で外部から `SessionState` を参照している箇所は確認時点で 0 件 (`src/session.ts` 内部のみ)。
- **内部改名**: `src/controlStream.ts` の `ControlMessage` 型を `RawControlMessage` に改名する (外部 export なしのため安全)。
- **新設**: `src/session/protocol.ts` ほか、`src/message/control.ts`
- **移動**: `src/session.ts` → `src/session/impl.ts`

## リスク

| ID  | リスク                                                              | 緩和                                         |
| --- | ------------------------------------------------------------------- | -------------------------------------------- |
| R1  | 同期イベント駆動と既存非同期フローの順序逆転                        | Phase ごとに既存テスト緑を厳守               |
| R2  | Phase 7 で message 層拡張に伴いテスト期待値が変わる                 | テスト先行で修正、CHANGES に `[CHANGE]` 明記 |
| R3  | Phase 3 の Request ID 検証追加で既存リレー相手の e2e が壊れる可能性 | PBT で精査、壊れたら別 issue で対応          |

Completed: 2026-04-19

## 解決方法

全 10 コミット (Phase 0 〜 Phase 9) で sans-I/O な `SessionProtocol` を新設した。
各 Phase で `vp check` / `vp run typecheck` / `vp run test` / `vp run build` がすべて緑を維持。
最終的に 32 test ファイル / 418 件の単体テスト + PBT がすべてパスする状態で完了した。

### 実装した成果物

- `src/session/protocol.ts`: `SessionProtocol` クラス本体 (sans-I/O な MOQT セッション状態機械)
- `src/session/types.ts`: Role / Transport / SessionState / SessionEvent / 各種エンティティ型
- `src/session/requestId.ts`: `RequestIdGenerator` / `RequestIdTracker`
- `src/session/subscription.ts`: Subscription のヘルパー関数
- `src/session/fetch.ts`: Fetch のヘルパー関数
- `src/session/namespace.ts`: Namespace / TrackStatus のヘルパー関数
- `src/session/authTokenCache.ts`: AuthTokenCache クラス
- `src/session/*.prop.ts`: 各モジュールの fast-check ベースの PBT
- `src/message/control.ts`: `ControlMessage` discriminated union
- `src/session/index.ts`: 公開 API の re-export
- `src/session/impl.ts`: I/O ラッパー層 (旧 `src/session.ts` を移動)

### 破壊的変更

- `SessionState` の値域を `"connected" | "closed"` から `"setup" | "established" | "closing" | "closed"` の 4 値に変更した。本プロジェクト内で外部から参照している箇所は 0 件だったため安全。
- `src/controlStream.ts` の `ControlMessage` 型を `RawControlMessage` に改名した (外部 export なし)。

### 残課題 (別 issue で扱う)

- `SessionImpl` の `pendingSubscribe` / `pendingPublish` / `pendingFetch` 等の Promise 管理と、`SessionProtocol` が持つ `SubscriptionEntry` / `FetchEntry` 等のエンティティ管理の完全統合 (現状は二層管理)。
- `AUTHORIZATION_TOKEN` パラメータの内容 (REGISTER / USE_ALIAS / USE_VALUE / DELETE) をデコードするパーサーの追加。現状は `AuthTokenCache` の API のみ用意しており、SETUP 内のトークン消費ロジックは未実装。
- Rust 側の実装との相互運用テスト (クロス実装 PBT) の追加。
