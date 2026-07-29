# session.ts をさらにモジュール分割する

- Priority: Medium
- Created: 2026-06-04
- Model: qwen3.7-plus
- Branch: feature/refactor-session-module-split
- Polished: 2026-07-30
- Updated: 2026-07-24

## 目的

`session.ts` の `SessionImpl` に集中している責務を、既存の `src/session/` 配下に追加分割し、保守性・可読性・テスト容易性を向上させる。

## 優先度根拠

`SessionImpl` (`src/session.ts` の大部分) に多数の責務が集中しており、可読性・差分レビュー・テストのしやすさを損なう。ただし直接の不具合ではなく、後方互換を保つ純粋なリファクタのため Medium。

## 現状

### 既に分割済み (`src/session/`)

- `bidi.ts`: 双方向ストリーム上の request/response 処理。`BidiSessionInternal` インターフェース経由で `SessionImpl` の状態にアクセスする free function 群。`bidiReadRequestStreamMessages` は role 引数 (`"publish" | "subscribe"`) を受け取る
- `stream.ts`: 受信データストリーム処理の純粋ヘルパー（統計更新・`handleObject` はコールバック経由）。`processSubgroupObjects` は `SubscriberImpl[]` を受け取り同一 alias の全 subscription に配送する
- `params.ts`: WebTransport や状態に依存しない純粋関数群 (PBT 対象)。`buildSubscribeTracksParameters` / `rangeFilterTypeToParamType` を含む
- `errors.ts`: read loop の catch から使うエラー判定純関数 (`isSessionClosedError` / `toProtocolViolationSessionError`)

### `session.ts` に残存している `SessionImpl` の責務

- 状態フィールド群: `sessionState` / `transport` / 制御ストリーム / `nextRequestId` / 多数の Map (`publishers` / `subscribers` / `subscribersByAlias` (`Map<bigint, SubscriberImpl[]>`) / `fetchers` / `pending*` / `namespaceSubscriptions` / `tracksSubscriptions` / `namespacePublications` / `publisherStreams` / `publisherSendQueues` / `closedSubgroups`) / 統計カウンタ群 / `datagramWriter` / `callbacks` / `peerMaxRequestUpdates` / `peerMaxFilterRanges`
- `initialize`: 制御ストリーム確立と SETUP 送受信。ピアの MAX_REQUEST_UPDATES / MAX_FILTER_RANGES をフィールドに保持する
- 公開 API: `publish` / `subscribe` / `fetch` / `trackStatus` / `subscribeNamespace` / `subscribeTracks` / `publishNamespace` / `goaway` / `close` / `getStatistics`
- 内部ループ群: `startControlMessageLoop` / `startIncomingStreamLoop` / `startDatagramLoop`
- namespace 系ストリームループ 3 種: `startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop`
- 送信系: `sendObject` / `sendObjectInternal` / `closePublisherStream` / `closePublisherStreamInternal` / `sendDatagram` / `getDatagramWriter` / `sendPublishDone`
- 受信系: `handleIncomingDatagram` / `handleIncomingStream` / `handleSubgroupStream` / `waitForFetcher`
- 内部ヘルパ: `closeWithError` / `notifyErrorIfActive` / `emitDebug` / `sendControlMessage` / `sendRequestOnBidiStream` / `handleGoawayOnNamespaceStream` / `handleControlMessage`
- 統計ラッパー: `processFetchObjects` / `processSubgroupObjects` — 統計カウンターを stream.ts の純粋関数に注入する薄いブリッジ
- ファクトリメソッド: `createNamespaceSubscription` / `createTracksSubscription` / `createNamespacePublication`
- close メソッド: `closeNamespaceSubscription` / `closeTracksSubscription` / `closeNamespacePublication`

## 設計方針

`bidi.ts` で確立した「free function + Internal インターフェース」パターンを踏襲する。`SessionImpl` のメソッドを、`SessionInternal` インターフェースを引数に受け取る free function として `src/session/` 配下のモジュールへ抽出し、`SessionImpl` は状態保持・公開 API・各 free function への委譲に縮小する。

### SessionInternal インターフェースの完全定義

`SessionInternal` は `BidiSessionInternal` を継承し、抽出先モジュールが必要とする追加フィールドを宣言する。全抽出先の要件を満たす最終的なインターフェース定義を以下に示す。

```typescript
// src/session/types.ts

import type { BidiSessionInternal, RequestStreamInfo } from "./bidi";
import type {
  ConnectCallbacks,
  NamespaceSubscriptionCallbacks,
  TracksSubscriptionCallbacks,
  NamespacePublicationCallbacks,
  NamespaceSubscription,
  TracksSubscription,
  NamespacePublication,
} from "../session";

// namespaceLoops.ts / incoming.ts / publish.ts から参照される状態型
export interface NamespaceSubscriptionState {
  callbacks: NamespaceSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  stream?: WebTransportBidirectionalStream;
  streamReader?: ReadableStreamDefaultReader<Uint8Array>;
  controlReader?: ControlStreamReader;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

export interface TracksSubscriptionState {
  callbacks: TracksSubscriptionCallbacks;
  state: "active" | "closed";
  namespacePrefix: string[];
  stream?: WebTransportBidirectionalStream;
  streamReader?: ReadableStreamDefaultReader<Uint8Array>;
  controlReader?: ControlStreamReader;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

export interface NamespacePublicationState {
  callbacks?: NamespacePublicationCallbacks;
  state: "pending" | "active" | "closed";
  namespace: string[];
  stream: WebTransportBidirectionalStream;
  streamReader: ReadableStreamDefaultReader<Uint8Array>;
  controlReader: ControlStreamReader;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

export interface PublisherStreamState {
  groupId: bigint;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  previousObjectId: bigint;
}

// SessionInternal = BidiSessionInternal の全フィールド + 抽出先が必要とする追加フィールド
export interface SessionInternal extends BidiSessionInternal {
  // ============================================================
  // namespaceLoops.ts 用
  // ============================================================
  readonly namespaceSubscriptions: Map<bigint, NamespaceSubscriptionState>;
  readonly tracksSubscriptions: Map<bigint, TracksSubscriptionState>;
  readonly namespacePublications: Map<bigint, NamespacePublicationState>;

  createNamespaceSubscription(requestId: bigint): NamespaceSubscription;
  createTracksSubscription(requestId: bigint): TracksSubscription;
  createNamespacePublication(requestId: bigint): NamespacePublication;

  // ============================================================
  // publish.ts 用
  // ============================================================
  readonly publisherStreams: Map<bigint, PublisherStreamState>;
  readonly publisherSendQueues: Map<bigint, Promise<void>>;
  readonly closedSubgroups: Set<string>;
  // Writable である必要あり: getDatagramWriter が ??= で遅延代入するため
  datagramWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  // 抽出先 free function からインクリメントされるため readonly 不可
  statsUnidirectionalStreamsOpened: number;

  // ============================================================
  // incoming.ts 用
  // ============================================================
  // handleIncomingDatagram が statsUnidirectionalStreamsReceived をインクリメントする。
  // 他の受信統計フィールド（statsObjectsReceivedViaFetch 等）は handleIncomingStream が
  // processFetchObjects ラッパー経由でインクリメントするが、handleIncomingStream は
  // SessionImpl に残留するため types.ts に露出不要。
  statsUnidirectionalStreamsReceived: number;

  // ============================================================
  // publish.ts 用（追加分）
  // ============================================================
  // draft-ietf-moq-transport-19 §10.3.1.6: ピアの MAX_FILTER_RANGES（0 = Range Filter 送信禁止）
  peerMaxFilterRanges: number;

  readonly callbacks: ConnectCallbacks;
}
```

**注意点**:

- `BidiSessionInternal` からの継承フィールド（`transport`, `sessionState`, `nextRequestId`, `publishers`, `subscribersByAlias` (`Map<bigint, SubscriberImpl[]>`), `fetchers`, `pendingSubgroupBuffer`, `fetcherReadyCallbacks`, `requestStreams`, `goawayReceivedOnRequestStreams`, `statsControlMessagesSent`, `controlWriter`, `emitDebug()`, `closeWithError()`, `peerMaxRequestUpdates`, 各種 pending Map）は `SessionInternal` に宣言不要（継承で自動的に含まれる）
- `callbacks` を `SessionInternal` に追加する。これは `incoming.ts` に抽出される `handleIncomingDatagram` の catch 節と、`namespaceLoops.ts` に抽出される namespace ループ内のデバッグ出力に使用する。namespace ループ内の `this.callbacks.debug?.()` 呼び出しは `emitDebug()` に統一せず、既存の `emitDebug` が `getMessageTypeName(type)` を内部で呼び type=0 に対して `"UNKNOWN(0x0)"` を出力してしまう問題を回避するため、`callbacks.debug` に直接アクセスするパターンを維持する。この `emitDebug` の問題は本 issue の範囲外とし、別 issue で `emitDebug` に optional `typeName` パラメータを追加して根本修正する
- `datagramWriter` は `WritableStreamDefaultWriter<Uint8Array> | undefined` で宣言するが、`readonly` にしない。遅延初期化（`??= `）で代入されるため、`SessionImpl` が `implements SessionInternal` でコンパイルエラーにならないよう注意
- `NamespaceSubscription` / `TracksSubscription` / `NamespacePublication` は `session.ts` で `export interface` 定義済みであり、`types.ts` が `import type` で参照する。`types.ts` が `session.ts` を import しても、`session.ts` は常に `types.ts` を `import type` で参照するため循環参照は発生しない（TypeScript の型レベル import は循環可能）
- `CloseNamespaceSubscription` / `closeTracksSubscription` / `closeNamespacePublication` は `SessionImpl` に残す。`SessionInternal` の `createNamespaceSubscription` 等が返すオブジェクトの `unsubscribe` / `done` コールバックは、`SessionImpl` 側でクロージャ経由で close メソッドをバインドする。具体的には以下のパターンで実装する:

```typescript
// SessionImpl.createNamespaceSubscription(requestId) 内
const unsubscribe = async (): Promise<void> => {
  await this.closeNamespaceSubscription(requestId);
};
```

抽出先の free function はファクトリメソッドの戻り値のみを使用し、close メソッドを直接呼ばない

- `namespaceSubscriptions` / `tracksSubscriptions` / `namespacePublications` の `readonly` 修飾は「Map 変数そのものの再代入禁止」を意味し、内容の不変性を保証するものではない。各ループの finally ブロックでの `delete(requestId)` は問題なく動作する。同様に `closedSubgroups: Set<string>` への `add()` / `delete()` も `readonly` で禁止されない
- `createNamespaceSubscription` / `createTracksSubscription` / `createNamespacePublication` は現在 `private` メソッドだが、`SessionInternal` インターフェースで宣言するため `SessionImpl` での可視性を public に変更する必要がある。ただしこれらのメソッドは `Session` 公開インターフェースには含まれず、`moqt-js` から export されないため、外部 API の後方互換性には影響しない
- `NamespaceSubscriptionState` / `TracksSubscriptionState` の `streamReader` / `controlReader` / `writer` は optional だが、`NamespacePublicationState` のこれらは必須である。これは、subscription 側がストリーム確立前（`pending` 状態）に状態オブジェクトを生成するため optional であり、publication 側は `createBidirectionalStream` 完了後にストリーム参照が確定した状態で生成するため必須となる設計上の非対称性に由来する。抽出先 free function では `namespaceSubscriptions.get()` 後の null チェックでガード済みのため、optional のままでも安全にアクセスできる

### `handleSubgroupStream` 抽出に関する判断

`handleSubgroupStream` は本リファクタでは **`SessionImpl` に残す**。

根拠:

- `PendingSubgroupBuffer.add()` が返す entry オブジェクトを経由した `Promise.race` によるレース制御（`reader.read()` と `entry.notified` の競合）は `SessionInternal` インターフェースでは表現しきれない密結合を持つ
- 抽出に必要な `SessionInternal` への追加フィールドが過大になる（`pendingSubgroupBuffer` の内部 entry 操作、`cancelStreamQuiet` 等）
- #0293 の「状態結合が強い」という判断は本質的に正しく、free function 抽出には不向き
- 代替として `handleSubgroupStream` の内部処理のうち純粋計算部分（existing code が既に `processSubgroupObjects` を呼んでいる部分）をさらに細かく抽出することは可能だが、本 issue の範囲外とする

### `handleIncomingStream` 抽出に関する判断

`handleIncomingStream` は **`SessionImpl` に残す**。

根拠:

- `handleIncomingStream` は subgroup ストリームを検出すると `this.handleSubgroupStream(reader, header, initialPayloadBuffer)` を呼び出す。`handleSubgroupStream` は本リファクタで `SessionImpl` に残すため、`handleIncomingStream` を free function 化するとこの呼び出し経路を `SessionInternal` 経由で露出する必要があり、interface が不必要に肥大化する
- `handleIncomingStream` は fetch / subgroup / padding / 未知ストリームの 4 分岐と 2 重の while ループを持つ複合ロジックであり、分岐先に対する状態管理が密結合している。特に `waitForFetcher` の Promise 制御と `handleSubgroupStream` の非同期呼び出しの順序保証を free function 化で維持するのは困難

この判断により、`incoming.ts` の抽出範囲は後述の抽出単位テーブルに従う。

### `processSubgroupObjects` ラッパー抽出の影響

`processSubgroupObjects` ラッパーは現在 `this.processSubgroupObjects(...)` として `SessionImpl` の private メソッドだが、`incoming.ts` に free function として抽出する。`SessionImpl` に残る `handleSubgroupStream` からの呼び出しは `processSubgroupObjects(session, ...)` に変更される。

同様に `processFetchObjects` ラッパーも `incoming.ts` に抽出し、`SessionImpl` に残る `handleIncomingStream` からの呼び出しは `processFetchObjects(session, ...)` に変更される。

いずれの変更も純粋な呼び出し形式の変更であり、ロジックは変わらない。

### 抽出単位

| 新規モジュール                  | 抽出する責務                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/types.ts`          | `SessionInternal` インターフェースと共有型。`BidiSessionInternal` を継承し、抽出先モジュールが必要とする追加フィールドを宣言する  |
| `src/session/namespaceLoops.ts` | `startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop` / `handleGoawayOnNamespaceStream`    |
| `src/session/publish.ts`        | `sendObject` / `sendObjectInternal` / `closePublisherStream(Internal)` / `sendDatagram` / `getDatagramWriter` / `sendPublishDone` |
| `src/session/incoming.ts`       | `handleIncomingDatagram` / `waitForFetcher` / `processFetchObjects` ラッパー / `processSubgroupObjects` ラッパー                  |

`initialize`、公開 API (`publish` / `subscribe` / `fetch` 等)、状態フィールド、`closeWithError` / `emitDebug`、`handleIncomingStream`、`handleSubgroupStream`、`closeNamespaceSubscription` / `closeTracksSubscription` / `closeNamespacePublication`、`createNamespaceSubscription` / `createTracksSubscription` / `createNamespacePublication` は `SessionImpl` (session.ts) に残し、オーケストレーターとする。

### モジュール依存グラフ

```
session.ts ──→ types.ts ──→ bidi.ts
    │              │
    ├──→ namespaceLoops.ts ──→ types.ts
    ├──→ publish.ts ──→ types.ts
    ├──→ incoming.ts ──→ types.ts
    │                      │
    └──────────────────────┘ (processSubgroupObjects 抽出により
                               handleSubgroupStream が incoming.ts を import)

namespaceLoops.ts ──→ bidi.ts (handleGoawayOnNamespaceStream が bidi.validate* を呼ぶ)
types.ts ──→ session.ts (import type: 7 種の型を参照)
bidi.ts ──→ session.ts (import type: SessionState, JoiningFetchOptions 等)
```

`session.ts → types.ts → bidi.ts → session.ts` のチェーンは型レベルの循環を形成するが、すべての辺が `import type` であるため TypeScript コンパイラは受理する。値レベル（実行時）での循環依存は発生しない。`types.ts → session.ts` の辺は型エイリアスのみが必要とするため、値の import は行わない。

`waitForFetcher` は `SessionImpl` の `fetcherReadyCallbacks` Map を使用するため、`SessionInternal` 経由でアクセスして free function 化する。Fetcher が登録されるかタイムアウト（5 秒、既存の挙動を維持）するまで待つロジックは変わらない。タイムアウト後のコールバック配列からの除去は既存コードと同様に行わない（`resolved` フラグによる二重実行防止のみ）。

### 実装上の注意

- `handleGoawayOnNamespaceStream` は 3 つの namespace ループから共通に呼ばれるため `namespaceLoops.ts` に抽出する。このメソッドは `bidi.validateNoDuplicateGoawayOnRequestStream` を呼ぶが、概念的には namespace ループの共通処理であり `bidi.ts` ではなく `namespaceLoops.ts` に置く方が適切
- `getDatagramWriter` は `session.datagramWriter ??= session.transport.datagrams.writable.getWriter()` を free function 内で実行する。`datagramWriter` は `SessionInternal` 上で writable として宣言するため `??=` が可能
- `namespaceLoops.ts` で用いる局所変数 `callbacks`（`NamespaceSubscriptionCallbacks` 型への destructure）と `session.callbacks`（`ConnectCallbacks` 型）は名前が衝突する。free function 内で `session.callbacks` を直接使う場合は、局所変数名を `subCallbacks` 等に変更して衝突を避ける
- 公開 API が `PublisherImpl` / `SubscriberImpl` / `FetcherImpl` に設定するコールバック (`onSendObject`, `onSendDatagram` 等) は、`SessionImpl` 側で free function をキャプチャするラッパーを作成してバインドを維持する。具体的には `publish()` メソッド内で以下のように free function をクロージャに閉じ込める:

```typescript
// session.ts の publish() 内
const sessionRef = this as unknown as SessionInternal;
impl.onSendObject = (params: SendObjectParams) => publishSendObject(sessionRef, impl, params);
impl.onSendDatagram = (params: SendDatagramParams) => publishSendDatagram(sessionRef, impl, params);
impl.onSendPublishDone = () => publishSendPublishDone(sessionRef, impl);
```

このパターンは既存の `bidi.ts` 抽出時に `SessionImpl` が `bidi*` free function を import してコールバックに設定したのと同様である。

- `publisherSendQueues` による Promise チェーン排他制御: `sendObject` と `closePublisherStream` は同一の `publisherSendQueues` Map に対して `.catch(() => {})` → `.then(...)` のパターンでシリアライズを行う。両 free function とも `session.publisherSendQueues` を介して同一のパターンでチェーンを構築することで、同一トラックの逐次実行を保証する。これは draft-ietf-moq-transport-19 §2.2 の「Objects from the same Subgroup MUST NOT be sent on different streams, unless one of the streams was reset prematurely, or upstream conditions have forced objects from a Subgroup to be sent out of Object ID order」を実装するための要件である

## 仕様書参照

抽出先モジュールが担当するプロトコル機能について、実装時の正しさ確認のため以下の節を参照する。

| 抽出モジュール      | 関連する仕様節                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `namespaceLoops.ts` | §3.3, §6.1, §6.2, §10.4 (GOAWAY), §10.15 (PUBLISH_NAMESPACE), §10.18 (SUBSCRIBE_NAMESPACE), §10.19 (SUBSCRIBE_TRACKS)                                        |
| `publish.ts`        | §2.2 (Subgroups), §10.10 (PUBLISH), §10.11 (PUBLISH_DONE), §11.2 (Objects), §11.3 (Datagrams), §11.3.1 (Object Datagram), §11.4.3 (Closing Subgroup Streams) |
| `incoming.ts`       | §11.2, §11.3, §11.4, §11.4.2 (Subgroup Header), §11.4.4 (Fetch Header)                                                                                       |

## 前提 issue

### 完了済み

本 issue が抽出対象とするメソッドに影響する以下の issue はすべて完了している:

- **#0297** (`handleIncomingDatagram` の PADDING fast-path 修正、High): 完了 (Completed: 2026-06-05)
- **#0301** (`sendDatagram` の writer 競合修正、High): 完了 (Completed: 2026-06-05)
- **#0305** (`sendObjectInternal` の `releaseLock` 修正、Medium): 完了 (Completed: 2026-06-05)
- **#0291** (namespace ループの GOAWAY ハンドリング重複解消、Low): 完了 (Completed: 2026-06-05)。共通メソッド `handleGoawayOnNamespaceStream` が導入済みのため、本リファクタではそのまま抽出する
- **#0317** (subscribe-tracks-publish-reception): 完了。`startTracksStreamLoop` に PUBLISH 受信処理が追加済み
- **#0319** (subgroup-header-first-object-bit): 完了。`sendObjectInternal` に FIRST_OBJECT bit 対応が追加済み
- **#0320** (end-of-group-track-status): 完了
- **#0323** (object-subgroup-validation): 完了。`sendObjectInternal` / `handleSubgroupStream` に検証が追加済み

### 先行完了が必要な open bug issue

なし。上記の open bug issue はすべて完了している。

## 変更対象ファイル

- `src/session/types.ts` / `src/session/namespaceLoops.ts` / `src/session/publish.ts` / `src/session/incoming.ts`: 新規作成 (抽出)
- `src/session.ts`: 抽出したメソッドを free function 呼び出しへ委譲し、大幅に縮小する
- 各抽出モジュールに対応する `*.test.ts` (既存テストの移設・追加)
- `CHANGES.md` への追記は `### misc` に `[UPDATE]` で記載する（公開 API 変更なしの内部リファクタのため）

## テスト方針

- 既存の全テストが変更なしで PASS することを必須とする。対象テスト:
  - `src/session.prop.ts` (PBT, `SessionImpl` 非依存)
  - `src/session/bidi.test.ts` (双方向ストリームの単体テスト)
  - `src/session/stream.test.ts` (純粋関数の単体テスト)
  - `src/session/params.test.ts` (純粋関数の単体テスト)
  - `src/session/errors.test.ts` (純粋関数の単体テスト)

- 各抽出先のテスト戦略:

| モジュール          | PBT                           | 単体テスト                                                                                                 | テスト実装要件                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespaceLoops.ts` | 非対象 (async + 副作用多)     | 抽出する（非同期ストリームループの単位テストは WebTransport 接続なしでは実現困難なため、同期処理部分のみ） | REQUEST_OK / REQUEST_ERROR のデコード分岐、GOAWAY ハンドリング等の純粋ロジックを抽出して単体テスト。非同期ループ全体のテストは既存の `session.prop.ts` 等の PBT/統合テストでカバーする                                                             |
| `publish.ts`        | 非対象 (Map mutation + async) | 抽出する                                                                                                   | `publisherSendQueues` の Promise チェーン排他制御を実際の Map を用いて検証。`sendObject` の逐次実行保証と `closedSubgroups` チェックを含める                                                                                                       |
| `incoming.ts`       | 非対象                        | 抽出する                                                                                                   | `handleIncomingDatagram` の type 分岐（PADDING / Object Datagram / エラー経路）を検証。`waitForFetcher` の registration callback と timeout 経路を検証。これらの free function は WebTransport 非依存または制御可能な依存のみのため mock/stub 不要 |
| `types.ts`          | 不要 (宣言のみ)               | 不要                                                                                                       | —                                                                                                                                                                                                                                                  |

- 単体テストのテストハーネスパターン:
  - `BidiSessionInternal` のテストと同様に、`SessionInternal` の部分実装オブジェクトを作成し `as unknown as SessionInternal` で型アサーションする
  - テスト対象の free function がアクセスするフィールドのみ実際の値を設定する。未使用フィールドは設定不要（型アサーションによりコンパイルが通る）
  - `publisherSendQueues` の排他制御テストでは、実際の `Map<bigint, Promise<void>>` インスタンスを使用してチェーンの逐次性を検証する

## 後方互換の影響

- 公開 API に変更はない (内部リファクタのみ)
- `moqt-js` からの export 構成は変えない
- `session.ts` の public メソッド (`publish` / `subscribe` / `fetch` / `close` 等) のシグネチャは変更しない
- `session.prop.ts` の PBT は `./session` から純粋関数 (`buildPublishParameters` 等) を import しており、`SessionImpl` に依存していないため free function 化後も影響を受けない

## 完了条件

- `namespaceLoops.ts` / `publish.ts` / `incoming.ts` / `types.ts` が抽出され、`SessionImpl` が各 free function へ委譲する構造になっている
- 公開 API に変更がなく、既存の全テストと新規追加した抽出先モジュールのテストが PASS する
- 責務の分離が達成されている（行数削減は必須の完了条件ではなく、抽出対象のメソッドが free function として正しく動作することを優先する）

### 過去の検討 (#0293)

#0293 で同様の `incoming.ts` 抽出が検討され、不要と判断された。

本 issue では以下の点で #0293 と状況・設計が異なる:

- `SessionInternal` インターフェースを経由することで、状態へのアクセスを型安全に行える（#0293 時点では `SessionInternal` の概念がなかった）
- 抽出対象を `incoming.ts` だけでなく `namespaceLoops.ts` / `publish.ts` と並行して進めることで、全体の整合性を保ちつつ分割できる
- 内部状態との結合が強い `handleSubgroupStream` は抽出を断念し `SessionImpl` に残す（#0293 の問題の核心を認める）
- #0293 の代替案「`IncomingStreamHandler` クラス導入」ではなく「free function + `SessionInternal` インターフェース」を選択する。これは既存の `bidi.ts` パターンの一貫性を保ち、クラス階層の複雑化を避けるためである
