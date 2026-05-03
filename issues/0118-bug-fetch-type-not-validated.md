# FETCH の Fetch Type が未知値で PROTOCOL_VIOLATION 化されない

Created: 2026-05-02
Model: Opus 4.7

## 概要

`decodeFetchPayload` (`src/message/fetch.ts:131-173` 付近) は Fetch Type を `if (Number(fetchType) === FetchType.STANDALONE) { ... } else { /* joining 経路 */ }` の二分岐で処理しており、Standalone (0x1) 以外のすべての値を Joining 経路で処理してしまう。仕様で禁止されている 0x0 や 0x4 以上の値も Joining としてデコードされる。

## RFC 根拠

draft-ietf-moq-transport-17 Section 9.14 (line 3866-3878):

```
+======+========================+
| Code | Fetch Type             |
+======+========================+
| 0x1  | Standalone Fetch       |
| 0x2  | Relative Joining Fetch |
| 0x3  | Absolute Joining Fetch |
+------+------------------------+
```

> An endpoint that receives a Fetch Type other than 0x1, 0x2 or 0x3 MUST close the session with a PROTOCOL_VIOLATION.

## 該当箇所

- `src/message/fetch.ts:131-173` — `if (... === STANDALONE) {} else { joining }` の二分岐
- `FetchType` 定数定義 (`src/message/fetch.ts` 上部) — STANDALONE / RELATIVE_JOINING / ABSOLUTE_JOINING の 3 値が定義されているが switch 化されていない

## 期待される動作

- decode を switch 文化し、許容値以外は `ProtocolViolationError` を throw する。
- 制御メッセージループで catch して `closeWithError(SessionErrorCode.PROTOCOL_VIOLATION)` でセッションを閉じる。
- Joining Fetch の Relative (0x2) と Absolute (0x3) を識別子レベルで区別する (現状の `joining` 構造体は `joiningRequestId` と `joiningStart` のみで Relative / Absolute の区別がない可能性があるため、関連コードも見直す必要がある)。
- PBT テストに不正値 (0x0, 0x4, 0x5, ...) のラウンドトリップで throw されることを確認するケースを追加する。

## 優先度

重大。MUST 違反であり、不正な peer または将来の拡張値で誤った Joining Fetch ペイロードを生成し、後続のフィールド読み取りで例外発生 → セッションが意図しないエラーで切断される。

## クライアント不要判定

**判定: クライアント不要**

根拠:

RFC §9.14 (FETCH) より:

> A subscriber sends FETCH as the first message on a new bidi stream to a publisher to request a range of already published objects within a track. (draft-ietf-moq-transport-17, line 3850-3852)

> An endpoint that receives a Fetch Type other than 0x1, 0x2 or 0x3 MUST close the session with a PROTOCOL_VIOLATION. (draft-ietf-moq-transport-17, line 3881-3882)

このMUSTは「FETCHメッセージを受信するエンドポイント（＝サーバー/パブリッシャー）」に適用される。moqt-jsはWebTransport専用クライアントであり、FETCHメッセージを**送信する側（Subscriber）**であって**受信する側（Publisher）**ではない。

実装面でも:

- `decodeFetchPayload` は `src/message/fetch.ts` で定義されているが、制御メッセージループ（`src/session.ts`）からは呼び出されていない
- 実際の使用箇所はPBTテスト（`src/message/fetch.prop.ts`）のラウンドトリップ検証のみ
- `src/message/fetch.ts` のコメントにも「リレーサーバー実装用。moqt-js はクライアント専用のため、ランタイムでは使用しない。PBT でのラウンドトリップテストで使用。」と明記されている

したがって、このMUST違反の修正はクライアントのスコープ外であり、PBTでの検証強化のみを実施すればよい。

本 issue は `issues/pending/` へ移動することを提案する。
