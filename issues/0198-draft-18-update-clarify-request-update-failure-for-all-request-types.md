# 全 request type に対する REQUEST_UPDATE 失敗時の挙動を明確化する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_UPDATE が失敗した場合の挙動が全 request type について明確化された。
moqt-js はクライアントであり Publisher/Subscriber としてのみ動作するため、
受信側のエラーハンドリングのコメントを更新する。

## RFC 参照

draft-ietf-moq-transport-18 §10.9.1 (Updating Subscriptions):

> When a REQUEST_UPDATE is unsuccessful, the publisher MUST also
> terminate the subscription by sending a PUBLISH_DONE with error code
> UPDATE_FAILED.  When a REQUEST_UPDATE fails for a FETCH, the
> publisher MUST reset the FETCH data stream.  When a REQUEST_UPDATE
> fails for a SUBSCRIBE_NAMESPACE or PUBLISH_NAMESPACE, the responder
> MUST close the bidi stream.

draft-ietf-moq-transport-18 A.1: "Clarify REQUEST_UPDATE failure behavior for all request types (#1539)"

## 変更内容

1. `src/session.ts` の REQUEST_UPDATE 送信関連のコメントに、失敗時のサーバー側の挙動を明記する
2. `src/subscriber.ts` の REQUEST_UPDATE 関連の JSDoc に、SUBSCRIBE 失敗時は PUBLISH_DONE(UPDATE_FAILED) がサーバーから返ることを追記する

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/session.ts` | 2290-2330 | `sendRequestUpdate` メソッドの JSDoc に失敗時のサーバー挙動を追記する |
| `src/subscriber.ts` | 18-39 | `RequestUpdateOptions` の JSDoc に失敗時の通知方法を追記する |
| `src/subscriber.ts` | 258-266 | `update()` の JSDoc を更新する |

## 期待される動作

1. Subscriber が REQUEST_UPDATE を送信し失敗した場合、サーバーから PUBLISH_DONE(UPDATE_FAILED) が返る
   - moqt-js 側の PUBLISH_DONE ハンドリングは既に UPDATE_FAILED を含むエラーコードを errorCallback で通知している (src/subscriber.ts:220)
2. FETCH の REQUEST_UPDATE 失敗時はサーバーが FETCH データストリームを reset する
3. SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE の REQUEST_UPDATE 失敗時はサーバーが bidi ストリームを close する

## テスト方針

- 既存テストの変更は不要 (受信側の挙動に既に準拠している)
- コメント更新のみのためテスト対象外

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
