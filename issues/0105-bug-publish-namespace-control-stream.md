# PUBLISH_NAMESPACE が制御ストリームで送受信されている

Created: 2026-04-29
Model: Opus 4.7

## 概要

`src/session.ts` の `publishNamespace()` が PUBLISH_NAMESPACE を `sendControlMessage()` 経由で制御用単方向ストリームに送出している。draft-ietf-moq-transport-17 では PUBLISH_NAMESPACE は新しい双方向 (request) ストリームの先頭メッセージとして送るよう要求されているため、仕様違反であり相互運用性が壊れる。

## 根拠

draft-ietf-moq-transport-17 Section 9.17 (`refs/moq/draft-ietf-moq-transport-17.txt:4188-4193`):

> The publisher sends the PUBLISH_NAMESPACE message as the first message on a new bidi stream to advertise that it has tracks available within a Track Namespace.

draft-ietf-moq-transport-17 Section 3.3 (`refs/moq/draft-ietf-moq-transport-17.txt:1303-1309`):

> In addition to the control streams, this specification uses bidirectional streams to carry requests. A request stream begins with one of these six message types: TRACK_STATUS, SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE, and SUBSCRIBE_NAMESPACE. Bidirectional streams MUST NOT begin with any other message type unless negotiated. If they do, the peer MUST close the Session with a PROTOCOL_VIOLATION.

## 該当コード

- 送信: `src/session.ts:1737-1741` で `sendControlMessage(MessageType.PUBLISH_NAMESPACE, payload, ...)` を呼んでいる。`sendControlMessage` は制御用単方向ストリームに書き込む。
- 受信: `src/session.ts:2996` 付近で `handleControlMessage` の case として PUBLISH_NAMESPACE を処理している。
- 応答: REQUEST_OK / REQUEST_ERROR は `handleRequestOk` / `handleControlStreamRequestError` で制御ストリームの文脈で処理される。

## 影響

仕様準拠の peer (relay 含む) と接続して `publishNamespace()` を呼ぶと:

- 制御ストリームに PUBLISH_NAMESPACE が現れる時点で peer は Section 9 のいずれの control message でもないと判定し、PROTOCOL_VIOLATION で session を閉じる可能性がある。
- 仮に peer が制御ストリーム上で PUBLISH_NAMESPACE を許容したとしても、Subscriber 側からの SUBSCRIBE_NAMESPACE → NAMESPACE/NAMESPACE_DONE のやり取りが request stream で行われるため、フロー全体が成立しない。

## 関連する未対応項目

CHANGES.md `## develop` に「未対応: SUBSCRIBE_NAMESPACE の専用ストリーム対応」「未対応: SUBSCRIBE_NAMESPACE の NAMESPACE/NAMESPACE_DONE 受信処理」が残っているのと同種の draft-17 移行漏れ。SUBSCRIBE_NAMESPACE 側は issue #0103 系の対応で送信側の bidi stream 化が進んでいるため、PUBLISH_NAMESPACE 側も同様の対応が必要。

## 修正方針

- `publishNamespace()` を `subscribeNamespace()` (`src/session.ts:1503-` 付近) と同じ構造に揃え、新しい双方向ストリームを開いて PUBLISH_NAMESPACE をフレーミング送信する (`ControlStreamWriter.encode()` を流用)。
- 応答ストリーム (read 側) で REQUEST_OK / REQUEST_ERROR を読み取るループを起動する。
- `handleControlMessage` から PUBLISH_NAMESPACE / 関連 REQUEST_OK / REQUEST_ERROR ハンドラを取り除き、未知のメッセージとして扱う (PROTOCOL_VIOLATION で session close)。
- NAMESPACE_DONE / NAMESPACE_CANCEL は draft-17 で廃止されているため新たに対応すべきものはないが、関連状態管理 (`pendingNamespacePublish` など) を bidi stream のライフサイクルに合わせて再設計する。

## テスト追加方針

- `src/message/namespace.prop.ts` に PUBLISH_NAMESPACE のフレーミング (`Type + 16-bit Length + Payload`) を `ControlStreamReader` で復元できる round-trip property test を追加する。
- 必要に応じて bidi stream を mock する単体テストではなく、ストリームに書き込まれたバイト列を ControlStreamReader でパースする形のテストにとどめる (session.ts は WebTransport 依存のため)。

## 補足

レビュー指摘 #34 を受けて起票。PUBLISH_NAMESPACE_DONE / PUBLISH_NAMESPACE_CANCEL は draft-17 で廃止済みのため、対応スコープは PUBLISH_NAMESPACE 単体と関連 REQUEST_OK / REQUEST_ERROR のみ。
