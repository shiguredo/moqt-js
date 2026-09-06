# Publisher 送信側の status / payload 整合ガード欠落

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-send-guard
- Polished: YYYY-MM-DD

## 目的

非 NORMAL 時の非空 payload や `END_OF_TRACK` 後の送信を呼び出し側で検出できず、失敗の検出が遅延する。送信前に検証する必要がある。

## 現状

- `src/publisher.ts` の `sendObject` のガードは `closed` のみで、`SendObjectParams` の注釈が MUST と書く規則 (非 NORMAL 時の payload 空、`END_OF_TRACK` 後の送信禁止) を検証しない (`sendDatagram` の `SendDatagramParams` に status はなく対象外)。
- 受信側 (`src/dataStream.ts`) は非 NORMAL + 非空 payload を `ProtocolViolationError` で拒否し、送信側の `encodeObjectFields` も事前に throw するため線路上には出ない。本対応は fail-fast 化である。

## 設計方針

1. 送信前に status / payload 整合と `END_OF_TRACK` 後の送信を検証し、違反は `throw` する。
2. 境界値の単体テストを追加する。

## 完了条件

- 不正な status / payload 組み合わせが送信前に失敗すること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.2.1.1
