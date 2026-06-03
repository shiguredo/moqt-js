# normalizeRequestErrorCode / normalizePublishDoneCode が未使用で Grease 正規化が機能していない

- Priority: High
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 Section 14 の MUST 要件を満たすため、未知の REQUEST_ERROR コードおよび PUBLISH_DONE コード受信時に INTERNAL_ERROR として正規化する関数をすべての受信箇所で実際に呼び出す。

## 背景

#0197 で `normalizeRequestErrorCode()` と `normalizePublishDoneCode()` が `src/error.ts` に定義され、単体テストも追加された。しかし各呼び出し箇所への挿入は未実施のまま close された。#0197 は完了条件を満たしていないため、本来は AGENTS.md の reopen 規約に従い reopen すべきだが、既に後続 issue が多数積まれているため、本 issue で残作業を対応する。#0197 完了条件の「未知のエラーコードが INTERNAL_ERROR に正規化される」は、本 issue 完了をもって達成とみなす。

## 優先度根拠

仕様上の MUST 要件違反。Grease エラーコード (`0x7f * N + 0x9d`) や将来追加される未知のエラーコードを受信した場合、正規化されずに未知のコードとして扱われ、アプリケーションの誤動作を引き起こす可能性がある。

## 現状

`src/error.ts:81-97` に `normalizeRequestErrorCode()` と `normalizePublishDoneCode()` が定義されているが、生産コードから一度も import されていない。受信処理ではエラーコードを単純に `Number(decoded.errorCode) as RequestErrorCode` とキャストするのみで、正規化が行われていない。

### REQUEST_ERROR 受信箇所

| 関数                                  | ファイル:行               | 現在のコード                                    |
| ------------------------------------- | ------------------------- | ----------------------------------------------- |
| `bidiReadPublishResponse`             | `src/session/bidi.ts:204` | `Number(decoded.errorCode) as RequestErrorCode` |
| `bidiReadSubscribeResponse`           | `src/session/bidi.ts:306` | `Number(decoded.errorCode) as RequestErrorCode` |
| `bidiReadFetchResponse`               | `src/session/bidi.ts:393` | `Number(decoded.errorCode) as RequestErrorCode` |
| `bidiReadTrackStatusResponse`         | `src/session/bidi.ts:442` | `Number(decoded.errorCode) as RequestErrorCode` |
| `bidiReadRequestStreamMessages`       | `src/session/bidi.ts:497` | `Number(decoded.errorCode) as RequestErrorCode` |
| `startNamespaceStreamLoop`            | `src/session.ts:1812`     | `Number(decoded.errorCode) as RequestErrorCode` |
| `startTracksStreamLoop`               | `src/session.ts:2016`     | `Number(decoded.errorCode) as RequestErrorCode` |
| `startNamespacePublicationStreamLoop` | `src/session.ts:2244`     | `Number(decoded.errorCode) as RequestErrorCode` |

### PUBLISH_DONE 受信箇所

| 関数                    | ファイル:行               | 現在のコード                                             |
| ----------------------- | ------------------------- | -------------------------------------------------------- |
| `bidiHandlePublishDone` | `src/session/bidi.ts:765` | `subscriber.handleEnd(msg.statusCode, msg.reasonPhrase)` |

`subscriber.handleEnd` 内 (`src/subscriber.ts`) で `isPublishDoneErrorStatus` によるエラー判定が行われるが、未知の statusCode は正規化されずに通過する。

## 設計方針

### normalizeRequestErrorCode の挿入

各 REQUEST_ERROR 受信箇所で、`error.ts` から `normalizeRequestErrorCode` を import し、キャスト前に正規化する：

```typescript
// 変更前
Number(decoded.errorCode) as RequestErrorCode;

// 変更後
normalizeRequestErrorCode(Number(decoded.errorCode));
```

`normalizeRequestErrorCode` の戻り値は `RequestErrorCode` 型のため、`as` キャストは不要になる。

### normalizePublishDoneCode の挿入

`bidiHandlePublishDone` 内の `handleEnd` 呼び出し前に正規化する。修正対象は `src/session/bidi.ts` の 1 箇所のみ。

### retryInterval の扱い

正規化の結果 `INTERNAL_ERROR (0x0)` になった場合、retryInterval は wire format 上の値をそのまま保持する。仕様 Section 14 は retryInterval に言及しておらず、既存の INTERNAL_ERROR 発生時の動作との一貫性のため特殊処理は行わない。retryInterval が 0 の場合は「再試行不可」として既存動作を維持する。

### 型に関する注意

`normalizeRequestErrorCode(code: number)` と `normalizePublishDoneCode(code: number)` は引数に `number` を取るが、Grease 値 (`0x7f * N + 0x9d`) の最大は `0x3fffffffffffffde` であり `Number.MAX_SAFE_INTEGER` を超える。実用上、エラーコードの wire format 上の値がこの範囲に達することはないが、防御的には `bigint` を受け取るようにシグネチャを変更する方が安全。この変更は本 issue のスコープ外とし、別途検討する。

### 対象外

以下の正規化は本 issue では対応しない：

- `normalizeSessionErrorCode`: 未定義のため対象外
- `normalizeDataStreamErrorCode`: 未定義のため対象外
- Data Stream Reset Error Code の正規化: 未知のストリームリセットコードは `INTERNAL_ERROR` に正規化されるべきだが、関数が存在しないため別 issue で対応

## テスト

`src/error.test.ts` に既存の単体テストがある。本 issue では以下の結合レベルのテストを追加する：

- Grease REQUEST_ERROR コード (`0x9D`) を受信した場合、INTERNAL_ERROR に正規化されること
- Grease PUBLISH_DONE コードを受信した場合、INTERNAL_ERROR に正規化されること
- 正規化後 INTERNAL_ERROR でセッションが閉じられないこと（Section 14 の MUST NOT 要件）
- 既知のコード (ex: `GOING_AWAY (0x6)`) は正規化で変更されないこと

## 完了条件

- Grease エラーコード (`0x7f * N + 0x9d`) を受信した場合、INTERNAL_ERROR として正規化されること
- 正規化された INTERNAL_ERROR の場合、セッションを閉じないこと（仕様 Section 14 に従う）
- テストが追加されていること
- `CHANGES.md` の `## develop` セクションに `[FIX]` エントリを追記すること

## 解決方法

1. `src/error.ts` の `normalizeRequestErrorCode` / `normalizePublishDoneCode` を各呼び出し箇所で import
2. REQUEST_ERROR 受信 8 箇所で `Number(decoded.errorCode) as RequestErrorCode` を `normalizeRequestErrorCode(Number(decoded.errorCode))` に置き換え
3. `bidiHandlePublishDone` で `msg.statusCode` を `normalizePublishDoneCode(Number(msg.statusCode))` で正規化してから `handleEnd` に渡す
4. 結合テストを追加

## 仕様引用

draft-ietf-moq-transport-18 Section 14 (Grease):

> Receipt of an unknown error code in any error context (Session
> Termination, REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST
> be treated as equivalent to INTERNAL_ERROR for that context. An
> endpoint MUST NOT close the session because it received an unknown
> error code in a REQUEST_ERROR or PUBLISH_DONE.
