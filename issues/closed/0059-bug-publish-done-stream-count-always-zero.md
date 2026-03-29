# PUBLISH_DONE の Stream Count が常に 0 になっている

Created: 2026-03-29
Model: Opus 4.6

## 概要

PUBLISH_DONE メッセージの Stream Count フィールドが `encodeVarint(0)` でハードコードされており、実際に開いたデータストリーム数を反映していない。

## RFC 根拠

draft-ietf-moq-transport-17 Section 9.13 PUBLISH_DONE:

```
PUBLISH_DONE Message {
  Type (vi64) = 0xB,
  Length (16),
  Status Code (vi64),
  Stream Count (vi64),
  Error Reason (Reason Phrase)
}
```

> Stream Count: An integer indicating the number of data streams the publisher opened for this subscription, including streams that contained no Objects (e.g., an empty Subgroup). This helps the subscriber know if it has received all of the data published in this subscription by comparing the number of streams received. The subscriber can immediately remove all subscription state once the same number of streams have been processed. If the publisher did not open any streams for this subscription, the publisher MUST set Stream Count to 0. If the publisher is unable to set Stream Count to the exact number of streams opened for the subscription, it MUST set Stream Count to 2^62 - 1. Subscribers SHOULD use a timeout or other mechanism to remove subscription state in case the publisher set an incorrect value, reset a stream before the SUBGROUP_HEADER, or set the maximum value. If a subscriber receives more streams for a subscription than specified in Stream Count, it MAY close the session with a PROTOCOL_VIOLATION.

現在の実装では常に 0 を送信しているため、データストリームを開いた場合に受信側が「全ストリーム到着済み」と誤判定する。

## 該当箇所

- `src/session.ts` 行 2070: `encodeVarint(0)` がハードコード

## 修正方針

Publisher がサブスクリプションごとに開いたデータストリーム数をカウントし、PUBLISH_DONE 送信時にその値を使用する。正確なカウントが困難な場合は RFC に従い `2^62 - 1` を設定する。
