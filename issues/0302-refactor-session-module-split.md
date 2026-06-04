# session.ts をさらにモジュール分割する

- Priority: Medium
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/refactor-session-module-split
- Polished: 2026-06-04

## 目的

`session.ts` (4125 行) の `SessionImpl` に集中している責務を、既存の `src/session/` 配下に追加分割し、保守性・可読性・テスト容易性を向上させる。

## 優先度根拠

`SessionImpl` (`src/session.ts:825-4125`、約 3300 行) に多数の責務が集中しており、可読性・差分レビュー・テストのしやすさを損なう。ただし直接の不具合ではなく、後方互換を保つ純粋なリファクタのため Medium。

## 現状

### 既に分割済み (`src/session/`)

- `bidi.ts` (約 1013 行): 双方向ストリーム上の request/response 処理。`BidiSessionInternal` インターフェース経由で `SessionImpl` の状態にアクセスする free function 群
- `stream.ts`: 受信データストリーム処理の純粋ヘルパー (統計更新・`handleObject` はコールバック経由)
- `params.ts`: WebTransport や状態に依存しない純粋関数群 (PBT 対象)
- `errors.ts`: read loop の catch から使うエラー判定純関数 (`isSessionClosedError`)

### `session.ts` に残存している `SessionImpl` の責務

- 状態フィールド群 (`src/session.ts:826-1028`): `sessionState` / `transport` / 制御ストリーム / `nextRequestId` / 多数の Map (`publishers` / `subscribers` / `subscribersByAlias` / `fetchers` / `pending*` / `namespaceSubscriptions` / `tracksSubscriptions` / `namespacePublications` / `publisherStreams` / `closedSubgroups`) / 統計カウンタ群
- `initialize` (1095)
- 公開 API: `publish` (1227) / `subscribe` (1331) / `fetch` (1461) / `trackStatus` (1548) / `subscribeNamespace` (1613) / `subscribeTracks` (1698) / `publishNamespace` (2208) / `goaway` (2473) / `close` (2555) / `getStatistics` (2523)
- namespace 系ストリームループ 3 種: `startNamespaceStreamLoop` (1778) / `startTracksStreamLoop` (2022) / `startNamespacePublicationStreamLoop` (2289)
- 送信系: `sendObject` (2825) / `sendObjectInternal` (2855) / `closePublisherStream` (2971) / `closePublisherStreamInternal` (2980) / `sendDatagram` (3018) / `sendPublishDone` (3073)
- 受信系: `handleIncomingDatagram` (3625) / 単方向データストリームループ / `handleSubgroupStream` / `waitForFetcher` (3689)
- 内部ヘルパ: `closeWithError` (2718) / `notifyErrorIfActive` (2732) / `emitDebug` (2743) / `sendControlMessage` (2761) / `sendRequestOnBidiStream` (2793)

## 設計方針

`bidi.ts` で確立した「free function + Internal インターフェース」パターンを踏襲する。`SessionImpl` のメソッドを、`SessionInternal` インターフェースを引数に受け取る free function として `src/session/` 配下のモジュールへ抽出し、`SessionImpl` は状態保持・公開 API・各 free function への委譲に縮小する。

### 抽出単位

| 新規モジュール                  | 抽出する責務                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/types.ts`          | `SessionInternal` 内部インターフェース・共有型 (既存の `BidiSessionInternal` を包含または拡張)                                         |
| `src/session/namespaceLoops.ts` | `startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop`                                           |
| `src/session/publish.ts`        | `sendObject` / `sendObjectInternal` / `closePublisherStream(Internal)` / `sendDatagram` / `sendPublishDone` と `publisherStreams` 管理 |
| `src/session/incoming.ts`       | `handleIncomingDatagram` / 単方向データストリームループ / `handleSubgroupStream` / `waitForFetcher`                                    |

`initialize` と公開 API (`publish` / `subscribe` / `fetch` 等)、状態フィールド、`closeWithError` / `emitDebug` 等の中核ヘルパは `SessionImpl` (session.ts) に残し、オーケストレーターとする。

## 関連 issue と実装順序

本 issue が抽出対象とするメソッドには、未対応のバグ修正・リファクタ issue が重なっている。**同一メソッドの二重改変による conflict を避けるため、以下を先に完了させてから本リファクタを行うことを推奨する。**

- **#0297** (`handleIncomingDatagram` の PADDING fast-path 修正、High) -> `incoming.ts` 抽出対象
- **#0301** (`sendDatagram` の writer 競合修正、High) -> `publish.ts` 抽出対象
- **#0305** (`sendObjectInternal` の `releaseLock` 修正、Medium) -> `publish.ts` 抽出対象
- **#0291** (namespace ループの GOAWAY ハンドリング重複解消、Low) -> `namespaceLoops.ts` 抽出対象。#0291 で共通化してから抽出するか、本リファクタで共通化も取り込むか、実装時に調整する

## 変更対象ファイル

- `src/session/types.ts` / `src/session/namespaceLoops.ts` / `src/session/publish.ts` / `src/session/incoming.ts`: 新規作成 (抽出)
- `src/session.ts`: 抽出したメソッドを free function 呼び出しへ委譲し、大幅に縮小する
- 各抽出モジュールに対応する `*.test.ts` (既存テストの移設・追加)
- 機能変更がないため `CHANGES.md` への追記は不要 (内部リファクタ。必要なら `### misc` に記載)

## テスト方針

- 公開 API・挙動を変えない純粋なリファクタのため、既存の全テスト (`session.test.ts` / `session.prop.ts` / `session/bidi.test.ts` 等) が変更なしで PASS することを必須とする
- 抽出した free function は `bidi.test.ts` の `BidiSessionInternal` テストハーネスと同様に、`SessionInternal` のテスト実装を用いて単体テスト可能になる。可能な範囲でテストを追加する
- モックやスタブは利用しない

## 後方互換の影響

- 公開 API に変更はない (内部リファクタのみ)
- `moqt-js` からの export 構成は変えない

## 完了条件

- `namespaceLoops.ts` / `publish.ts` / `incoming.ts` / `types.ts` が抽出され、`SessionImpl` が各 free function へ委譲する構造になっている
- `session.ts` が大幅に縮小される (目安: 2000 行以下、理想は 1500 行以下。行数より責務の分離を優先する)
- 公開 API に変更がなく、既存の全テストが PASS する
