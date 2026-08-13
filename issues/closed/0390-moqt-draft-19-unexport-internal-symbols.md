# 外部から使用されていない内部シンボルの export を非公開化する

- Priority: Low
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/refactor-moqt-draft-19-unexport-internal-symbols
- Polished: 2026-08-12

## 目的

同一ファイル内でしか使われていない export を非公開化し、公開 API 面を縮小する。対象は関数・型・定数と、`src/session.ts` 末尾の再 export ブロック (他ファイルのシンボルのパススルー) を含む。いずれも `src/index.ts` から re-export されておらず、外部から import されていない (テストから import されるシンボルは対象外。下記注記)。

## 優先度根拠

export されているが外部から参照されていないシンボルは、意図しない公開 API として誤用される可能性がある。非公開化自体は低リスクだが、対象の洗い出し (テストからの参照・index.ts re-export・0397 との調整) と `src/session.prop.ts` の import 移行を伴う。Low。

## 現状

外部から import されていない export (定義ファイル以外の生産コード・テスト・index.ts の 3 面で grep 検証済み。参照位置はシンボル名で示す):

- `namespaceHandleGoaway` (`src/session/namespaceLoops.ts`) — 生産コード・テストから未参照。
- `bidiReadResponseFromBidiStream` (`src/session/bidi.ts`) — 生産コード・テストから未参照。
- `bidiSendJoiningFetch` (`src/session/bidi.ts`) — 生産コード・テストから未参照 (0393 が FETCH 配線で変更予定。下記注記)。
- `RequestStreamInfo` (`src/session/bidi.ts`) — 型。`BidiSessionInternal` の `requestStreams` フィールド型として bidi.ts 内で使用。
- `publishGetDatagramWriter` / `publishSendObjectInternal` / `publishClosePublisherStreamInternal` (`src/session/publish.ts`) — 生産コード・テストから未参照。
- `StreamStatsUpdate` (`src/session/stream.ts`) — 型。stream.ts 内でのみ使用。
- `PendingNotifyReason` / `PendingSubgroupEntry` (`src/pendingSubgroupBuffer.ts`) — 型。pendingSubgroupBuffer.ts 内でのみ使用。
- `SessionImplOptions` (`src/session.ts`) — 型。session.ts のコンストラクタ引数でのみ使用。
- `ProcessCatalogPayloadResult` (`src/createMediaSubscriber.ts`) — 型。createMediaSubscriber.ts 内でのみ使用。
- `NamespaceSubscriptionState` / `NamespacePublicationState` / `PublisherStreamState` (`src/session/types.ts`) — 型。session/types.ts 内でのみ使用。
- `TracksSubscriptionState` (`src/session/types.ts`) — 型。リポジトリ全体で定義以外の参照がゼロ (完全未参照のため非公開化ではなく**削除**する。0387 の判断基準に同じ)。
- `MAX_FULL_TRACK_NAME_SIZE` / `MAX_KVP_VALUE_LENGTH` (`src/message/parameter.ts`) — 定数。同一ファイル内でのみ使用 (0384 が新設するバイト長版検証も parameter.ts 内)。
- `isSessionLevelNamespace` / `isReservedNamespace` / `RESERVED_NAMESPACE_PREFIX` / `SESSION_LEVEL_NAMESPACE` (`src/message/parameter.ts`) — 0375 の実装で `isRejectedReceiveNamespace` (同一ファイル内) のみが `isSessionLevelNamespace` を使用。他は実行パスから未使用。`src/message/index.ts` からの re-export も除去する (0397 の要求を反映)。完全未参照ではあるが、draft-19 §3.2.1 / §3.2.2 の予約名前空間検証に将来使用する可能性があるため、削除せず非公開化とする。
- `src/session.ts` 末尾の再 export ブロック (`buildPublishParameters` 等 13 シンボルを `./session/params` から再 export) — 消費者は `./session/params` から直接 import 済み。ただし `src/session.prop.ts` が 8 シンボルを `./session` 経由で import しているため、再 export ブロック削除時は session.prop.ts の import を `./session/params` に移行する。

テストから import されているため**対象外** (0371 の注記の原則「テストで使用する export は維持する」):

- `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) — bidi.test.ts から import され 24 箇所のテストが直接駆動 (0370 / 0374 の実装テストが同関数を駆動する)。0397 / 0409 も同じ関数を対象とする。
- `resolveAuthorizationToken` / `processCatalogPayload` (`src/createMediaSubscriber.ts`) — createMediaSubscriber.test.ts から import され使用。
- `notifySubscriberFin` / `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` (`src/session/bidi.ts`) — 0374 で新設。production (session.ts) からも使用されるため対象外 (0374 の注記の要求)。
- `incomingClassifyFirstBidiMessage` (`src/session/incoming.ts`) — incoming.test.ts から import され使用 (0371 の注記どおり)。

変更対象ファイル: 上記の定義ファイル + `src/session.prop.ts` (import 移行) + `src/message/index.ts` (4 定数の re-export 除去) + `CHANGES.md`。

## 設計方針

- 上記対象シンボルの export キーワードを除去し、モジュールローカルにする (`TracksSubscriptionState` は定義ごと削除)。
- `RequestStreamInfo` / `SessionImplOptions` 等の型は、非公開化後も `tsc --noEmit` で影響がないことを確認する (宣言出力なしのため、public シンボルが非公開型を参照してもエラーにならない点に注意)。
- `src/session.ts` 末尾の再 export ブロックは削除し、`src/session.prop.ts` の import を `./session/params` に移行する。
- `src/message/index.ts` から `isSessionLevelNamespace` / `isReservedNamespace` / `RESERVED_NAMESPACE_PREFIX` / `SESSION_LEVEL_NAMESPACE` の re-export を除去する。
- テストから import されるシンボル (上記対象外リスト) は非公開化しない。

## 完了条件

- 対象シンボルが外部から import できなくなり、モジュールローカルになること (テストから import されるシンボルは維持)。
- `TracksSubscriptionState` が削除され、リポジトリ内に参照が残らないこと。
- `src/session.ts` 末尾の再 export ブロックが削除され、`src/session.prop.ts` の import が `./session/params` に移行されていること。
- `CHANGES.md` の `## develop` の `### misc` に `[CHANGE]` エントリがあること (シンボル削除・非公開化を伴う変更の先例に従い [CHANGE] で記載する。先例: 「[CHANGE] PublishOk 型と encodePublishOkPayload を削除する (#0290)」)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- 特になし (リポジトリ内部の整理)

## 注記 (0371 実装時)

- 0371 で新設した `incomingClassifyFirstBidiMessage` (src/session/incoming.ts) は、`incoming.ts` 内部と `incoming.test.ts` からのみ参照され、テストで使用するため export を維持すること (非公開化対象に含めない)。同じ原則をテストから import される `bidiReadRequestStreamMessages` (0370 / 0374 のテストが駆動) / `resolveAuthorizationToken` / `processCatalogPayload` にも適用する (現状の対象外リスト参照)。

## 注記 (0375 実装時)

- 0375 の実装後、`isSessionLevelNamespace` / `isReservedNamespace` / `RESERVED_NAMESPACE_PREFIX` / `SESSION_LEVEL_NAMESPACE` (`src/message/parameter.ts`) は実行パスから未使用のため、非公開化対象に含める (0397 の要求を反映。`src/message/index.ts` からの re-export も除去する)。

## 注記 (0397 との調整)

- 0397 (doc-0390-keep-export-note) は 0390 に次の注記追加を要求している: (1) `bidiReadRequestStreamMessages` の export を維持する旨、(2) 0370 への相互参照 (0370 のテストが同関数を駆動するため)、(3) 0375 新設 4 シンボル (`isSessionLevelNamespace` / `isReservedNamespace` / `RESERVED_NAMESPACE_PREFIX` / `SESSION_LEVEL_NAMESPACE`) の対象リスト追加。いずれも本 issue に反映済み (対象外リスト・注記 (0375 実装時)・対象リスト参照)。0374 の注記要求 (0374 新設の `notifySubscriberFin` / `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` は production からも使用されるため対象外) も反映済み (対象外リスト参照)。

## 注記 (0393 との調整)

- 0393 (FETCH 配線) は `bidiSendJoiningFetch` を変更予定 (JoiningFetchOptions に rangeFilters 追加)。0390 は同関数の export 除去のみで競合しないが、0393 が bidi.ts の構造を変えるため、実装順の競合時は 0390 側で再検証する。

## 解決方法

- 以下 12 シンボルの export を除去し、モジュールローカルにした:
  - `namespaceHandleGoaway` (src/session/namespaceLoops.ts)
  - `RequestStreamInfo` / `bidiReadResponseFromBidiStream` (src/session/bidi.ts)
  - `publishGetDatagramWriter` / `publishClosePublisherStreamInternal` (src/session/publish.ts)
  - `StreamStatsUpdate` (src/session/stream.ts)
  - `PendingNotifyReason` / `PendingSubgroupEntry` (src/pendingSubgroupBuffer.ts)
  - `SessionImplOptions` (src/session.ts)
  - `ProcessCatalogPayloadResult` (src/createMediaSubscriber.ts)
  - `NamespacePublicationState` / `PublisherStreamState` (src/session/types.ts)
  - `MAX_KVP_VALUE_LENGTH` / `isSessionLevelNamespace` (src/message/parameter.ts)
- `src/session.ts` 末尾の再 export ブロック (12 シンボル) を削除し、`src/session.prop.ts` の import を `./session/params` に移行した
- 完全未参照の 3 シンボル (`RESERVED_NAMESPACE_PREFIX` / `SESSION_LEVEL_NAMESPACE` / `isReservedNamespace`) は、issue の設計方針では「非公開化」とされていたが、noUnusedLocals により完全未使用の非公開シンボルはコンパイルエラーになるため**削除**に変更した (0387 の判断基準と同じ)
- `src/message/index.ts` から上記 4 シンボルの re-export を除去した
- **実装時の状況変化により対象外になったシンボル** (後続 issue の実装で使用開始):
  - `bidiSendJoiningFetch` (0393 で bidi.test.ts から使用)
  - `publishSendObjectInternal` (0363 で publish.test.ts から使用)
  - `TracksSubscriptionState` (0385 で bidi.ts / namespaceLoops.ts から production で使用。issue の「削除」方針は対象外に変更)
  - `MAX_FULL_TRACK_NAME_SIZE` (0384 で parameter.test.ts から使用)
  - `NamespaceSubscriptionState` (bidi.ts / namespaceLoops.ts から production で使用)
- `CHANGES.md` の `## develop` 末尾の `### misc` に `[CHANGE]` エントリを追加した
