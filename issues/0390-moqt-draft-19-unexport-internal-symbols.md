# 外部から使用されていない内部関数の export を非公開化する

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/refactor-moqt-draft-19-unexport-internal-symbols
- Polished: {YYYY-MM-DD}

## 目的

同一ファイル内でしか使われていない export を非公開化し、公開 API 面を縮小する。いずれも index.ts から re-export されておらず、外部から import されていない。

## 優先度根拠

export されているが外部から参照されていないシンボルは、意図しない公開 API として誤用される可能性がある。非公開化は機械的変更でありリスクが低い。Low。

## 現状

外部から import されていない export (確認済み):

- `src/session/namespaceLoops.ts:37` `namespaceHandleGoaway`
- `src/session/bidi.ts:253` `bidiReadResponseFromBidiStream`
- `src/session/bidi.ts:656` `bidiReadRequestStreamMessages`
- `src/session/bidi.ts:941` `bidiSendJoiningFetch`
- `src/session/bidi.ts:69` `RequestStreamInfo`
- `src/session/publish.ts:35` `publishGetDatagramWriter`
- `src/session/publish.ts:82` `publishSendObjectInternal`
- `src/session/publish.ts:226` `publishClosePublisherStreamInternal`
- `src/session/stream.ts:25` `StreamStatsUpdate`
- `src/pendingSubgroupBuffer.ts:22` `PendingNotifyReason`
- `src/pendingSubgroupBuffer.ts:52` `PendingSubgroupEntry`
- `src/session.ts:213` `SessionImplOptions`
- `src/createMediaSubscriber.ts:59/94/108` `resolveAuthorizationToken` / `ProcessCatalogPayloadResult` / `processCatalogPayload`
- `src/session/types.ts:26/36/46/56` `NamespaceSubscriptionState` / `TracksSubscriptionState` / `NamespacePublicationState` / `PublisherStreamState`
- `src/message/parameter.ts:32/97` `MAX_FULL_TRACK_NAME_SIZE` / `MAX_KVP_VALUE_LENGTH` (同一ファイル内でのみ使用)
- `src/session.ts:3915-3929` 末尾の再 export ブロック (13 シンボル。全消費者が `session/params.ts` から直接 import しており `./session` 経由の import はゼロ)

## 設計方針

- 上記の export キーワードを除去し、モジュールローカルにする。
- `SessionImplOptions` と `RequestStreamInfo` は型エイリアス経由で参照されるため、型チェックで影響を確認する。
- `src/session.ts` 末尾の再 export ブロックは重複のため削除する。

## 完了条件

- 対象シンボルが外部から import できなくなり、モジュールローカルになること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- 特になし (リポジトリ内部の整理)

## 注記 (0371 実装時)

- 0371 で新設した `incomingClassifyFirstBidiMessage` (src/session/incoming.ts) は、`incoming.ts` 内部と `incoming.test.ts` からのみ参照され、session.ts から直接 import されない。テストで使用するため export を維持すること (0390 の非公開化対象に含めない)。

## 解決方法

未着手。
