# REQUEST_OK の Track Properties 空チェックが REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK で漏れている

- Priority: High
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Branch: feature/draft-18
- Polished: 2026-06-03

- Completed: 2026-06-03

## 目的

draft-ietf-moq-transport-18 Section 10.5 の MUST 要件を満たすため、REQUEST_OK エイリアス応答での Track Properties 空チェック漏れを修正する。

## 背景

#0235 で PUBLISH_OK の空チェックは `decodePublishOkPayload` に実装されたが、REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の 3 つは対応漏れのまま close された。#0235 の完了条件には全 4 種の対応が含まれていたため本来は reopen が必要だが、既に `Polished: 2026-06-03` 付与後に close され後続 issue が積まれているため、本 issue で残り 3 つを対応する。本 issue 完了後、#0235 は reopen せずに本 issue と合わせて対応完了とみなす。

#0235 では PUBLISH_OK 専用の `decodePublishOkPayload`（他と共有されない独立関数）内で空チェックが実装された。`decodeRequestOkPayload` は複数の応答種別で共用される汎用関数であるため、責務分離の観点から呼び出し元でチェックする方式が選択された。本 issue でもこの方針に従い、各呼び出し元でデコード後に空チェックを行う。`decodeRequestOkPayload` 自体は変更しないため、既存 PBT テスト (`src/message/session.prop.ts`) への影響はない。

## 優先度根拠

仕様上の MUST 要件違反。PROTOCOL_VIOLATION でセッションを閉じるべきケースを検出できておらず、不正なサーバー実装に対して誤動作する可能性がある。

## 現状

`decodeRequestOkPayload` (`src/message/session.ts`) は Track Properties の空チェックを行わない。同関数の全呼び出し箇所は以下の 5 箇所：

| エイリアス             | 呼び出し関数                          | ファイル:行           | Track Properties 許可 | 空チェック |
| ---------------------- | ------------------------------------- | --------------------- | --------------------- | ---------- |
| TRACK_STATUS_OK        | `bidiReadTrackStatusResponse`         | `src/session/bidi.ts` | 許可                  | 不要       |
| REQUEST_UPDATE_OK      | `bidiHandleRequestUpdateOk`           | `src/session/bidi.ts` | **禁止**              | **漏れ**   |
| SUBSCRIBE_NAMESPACE_OK | `startNamespaceStreamLoop`            | `src/session.ts`      | **禁止**              | **漏れ**   |
| SUBSCRIBE_TRACKS_OK    | `startTracksStreamLoop`               | `src/session.ts`      | 仕様未定義            | 不要       |
| PUBLISH_NAMESPACE_OK   | `startNamespacePublicationStreamLoop` | `src/session.ts`      | **禁止**              | **漏れ**   |

SUBSCRIBE_TRACKS_OK は仕様 Section 10.5 の空チェック対象一覧に含まれていないため、空チェック不要。

## 設計方針

#0235 と同じ「呼び出し元で空チェック」方式を採用する。`decodeRequestOkPayload` のシグネチャを変更せず、各呼び出し箇所でデコード後に `trackProperties.length > 0` をチェックし、空でなければ `ProtocolViolationError` を throw する。

### 修正対象

1. `src/session/bidi.ts` (`bidiHandleRequestUpdateOk` 内): `decodeRequestOkPayload` 呼び出し直後にチェック追加
2. `src/session.ts` (`startNamespaceStreamLoop` 内): 同様
3. `src/session.ts` (`startNamespacePublicationStreamLoop` 内): 同様

### エラーメッセージ

既存の `decodePublishOkPayload` に倣い、以下の形式とする：

- REQUEST_UPDATE_OK: `"REQUEST_UPDATE_OK must not contain Track Properties"`
- SUBSCRIBE_NAMESPACE_OK: `"SUBSCRIBE_NAMESPACE_OK must not contain Track Properties"`
- PUBLISH_NAMESPACE_OK: `"PUBLISH_NAMESPACE_OK must not contain Track Properties"`

### テスト

空チェックは `decodeRequestOkPayload` ではなく各呼び出し元に追加するため、テストはセッションレベルで行う。既存の `src/session/` 配下のテストファイルに以下の観点で追加する：

- 空 Track Properties の正常系（3 エイリアスそれぞれでエラーが発生しないこと）
- 非空 Track Properties の異常系（3 エイリアスそれぞれで `ProtocolViolationError` が throw されること）
- TRACK_STATUS_OK の退行確認（非空 Track Properties がエラーにならないこと）
- SUBSCRIBE_TRACKS_OK の退行確認（非空 Track Properties がエラーにならないこと）

`decodeRequestOkPayload` 自体に変更はないため、`src/message/session.prop.ts` の既存 PBT テストへの影響はない。

## 完了条件

- REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の応答で Track Properties が存在する場合、`ProtocolViolationError` が throw されセッションが閉じられること
- TRACK_STATUS_OK では正常に Track Properties がパースされること（既存動作を壊さない）
- SUBSCRIBE_TRACKS_OK では空チェックが行われないこと（既存動作を壊さない）
- テストが追加されていること
- `CHANGES.md` の `## develop` セクションに `[FIX]` エントリを追記すること

## 解決方法

空チェックは以下の 3 箇所で実装済みであることを確認した：

1. `src/session/bidi.ts:818` (`bidiHandleRequestUpdateOk`) - REQUEST_UPDATE_OK 用の空チェック
2. `src/session.ts:1797` (`startNamespaceStreamLoop`) - SUBSCRIBE_NAMESPACE_OK 用の空チェック
3. `src/session.ts:2241` (`startNamespacePublicationStreamLoop`) - PUBLISH_NAMESPACE_OK 用の空チェック

テストを以下の 2 ファイルに追加した：

1. `src/message/session.prop.ts` - `decodeRequestOkPayload` の非空 Track Properties ラウンドトリップ PBT テストを追加
2. `src/session/bidi.test.ts` - `bidiHandleRequestUpdateOk` の空 / 非空 Track Properties テストを追加

`CHANGES.md` の `## develop` セクションに `[FIX]` エントリを追記した。

## 仕様引用

draft-ietf-moq-transport-18 Section 10.5 (REQUEST_OK):

> This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK,
> TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK, and PUBLISH_NAMESPACE_OK to
> refer to a REQUEST_OK sent in response to the corresponding request
> type.

> Track Properties are populated in TRACK_STATUS_OK; they are empty in
> PUBLISH_OK, REQUEST_UPDATE_OK, SUBSCRIBE_NAMESPACE_OK and
> PUBLISH_NAMESPACE_OK. If an endpoint receives Track Properties in one
> of these messages it MUST close the session with a PROTOCOL_VIOLATION.
