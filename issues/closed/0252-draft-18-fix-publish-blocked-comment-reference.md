# PUBLISH_BLOCKED コメントが SUBSCRIBE_NAMESPACE を誤って参照している

- Priority: Low
- Created: 2026-06-03
- Model: DeepSeek V4 Pro
- Completed: 2026-06-03
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

draft-18 で PUBLISH_BLOCKED が SUBSCRIBE_NAMESPACE から SUBSCRIBE_TRACKS に移動したことをコメントに反映する。

## 優先度根拠

コメントの軽微な誤り。機能的影響はないが、コードの理解を妨げる可能性があるため修正が必要。

## 現状

以下の 2 箇所で PUBLISH_BLOCKED が SUBSCRIBE_NAMESPACE に関連付けられている：

| ファイル:行                    | 内容                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `src/message/types.ts:47`      | `PUBLISH_BLOCKED: 0x0f` のコメントに「SUBSCRIBE_NAMESPACE のフロー制御の一環」と記載          |
| `src/message/namespace.ts:337` | `PublishBlocked` インターフェースのコメントに「SUBSCRIBE_NAMESPACE のフロー制御の一環」と記載 |

draft-18 では SUBSCRIBE_NAMESPACE が SUBSCRIBE_NAMESPACE と SUBSCRIBE_TRACKS に分割され (Section 10.18, 10.19)、PUBLISH_BLOCKED の役割は SUBSCRIBE_TRACKS 側に移動した。

## 設計方針

コメント内の「SUBSCRIBE_NAMESPACE」を「SUBSCRIBE_TRACKS」に修正する。

## 解決方法

`src/message/types.ts:47` と `src/message/namespace.ts:337` の PUBLISH_BLOCKED 関連コメントが既に「SUBSCRIBE_TRACKS のフロー制御の一環」に修正されていることを確認した。

## 完了条件

- コメントが SUBSCRIBE_TRACKS を正しく参照していること

## 仕様引用

draft-ietf-moq-transport-18 Section 10.20 (PUBLISH_BLOCKED):

> PUBLISH_BLOCKED is sent on a response stream alongside PUBLISH messages.
> It is only sent in response to a SUBSCRIBE_TRACKS message.
