# SUBSCRIBE_NAMESPACE ストリームのクローズ semantics を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で SUBSCRIBE_NAMESPACE 応答ストリームのクローズ条件と
クローズ後の挙動が明確化された。
moqt-js の SUBSCRIBE_NAMESPACE 応答ストリーム処理は既に draft-17 時点で準拠済みであり、
draft 番号とコメントを更新する。

## RFC 参照

draft-ietf-moq-transport-18 §10.18 (SUBSCRIBE_NAMESPACE):

> When a subscriber receives a stream reset or FIN on a
> SUBSCRIBE_NAMESPACE response stream, it SHOULD treat this as though
> each active namespace received a NAMESPACE_DONE. Subscriptions
> established via PUBLISH on separate bidi streams are not affected
> by closure of the SUBSCRIBE_NAMESPACE stream.

draft-ietf-moq-transport-18 A.1: "Clarify SUBSCRIBE_NAMESPACE stream closure semantics (#1541)"

## 変更内容

1. `src/session.ts` の SUBSCRIBE_NAMESPACE 応答ストリームのクローズ処理 (FIN / stream reset 受信時) のコメントを更新する
2. draft 番号を 17 から 18 に更新する

## 該当ファイル

| ファイル         | 行番号    | 変更内容                                                                        |
| ---------------- | --------- | ------------------------------------------------------------------------------- |
| `src/session.ts` | 1473-1476 | draft 参照番号を 18 に更新する                                                  |
| `src/session.ts` | 1533      | §9.20 → §10.18 に節番号を更新する                                               |
| `src/session.ts` | 1537-1678 | ストリームクローズ時のコメントに NAMESPACE_DONE 扱いの説明を追記する            |
| `src/session.ts` | 1540-1542 | FIN 受信時のコメントに「active namespace を NAMESPACE_DONE 扱いする」を追記する |

## 期待される動作

1. SUBSCRIBE_NAMESPACE 応答ストリームの FIN または stream reset 受信時、既存の全 active namespace を NAMESPACE_DONE 扱いにする
2. このクローズは SUBSCRIBE_NAMESPACE ストリーム上の namespace 購読のみに影響し、別 bidi ストリーム上の PUBLISH 経由の購読には影響しない
3. 既存の NAMESPACE_DONE 処理 (対応 NAMESPACE より先に来たら PROTOCOL_VIOLATION) は維持される

## テスト方針

- 既存テストの変更は不要 (NAMESPACE_DONE 未到達時の PROTOCOL_VIOLATION 検出は既にテスト済み)
- ストリームクローズ時の挙動は E2E テストでカバーされる

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
