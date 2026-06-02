# Message Parameter 重複チェックが AUTHORIZATION_TOKEN 複数指定をブロックする問題を修正する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/fix-auth-token-duplicate-check
- Polished: 2026-06-03

## 目的

draft-ietf-moq-transport-18 Section 10.2.2 で AUTHORIZATION_TOKEN は単一メッセージ内での複数回出現が許可されているが、現在のコードでは無条件に重複を拒否している。

Section 10.2:
> "Senders MUST NOT repeat the same Parameter Type in a message unless
>  the parameter definition explicitly allows multiple instances of
>  that type to be sent in a single message. Receivers SHOULD check
>  that there are no unexpected duplicate parameters and close the
>  session with PROTOCOL_VIOLATION if found."

Section 10.2.2:
> "The AUTHORIZATION TOKEN parameter MAY be repeated within a message
>  as long as the combination of Token Type and Token Value are unique
>  after resolving any aliases."

## 優先度根拠

複数の AUTHORIZATION_TOKEN を含むメッセージが PROTOCOL_VIOLATION で拒否され、正しいプロトコルフローが機能しない可能性があるため Medium とする。

## 現状

`src/message/parameter.ts` `decodeParameters` (line 785-789):
```ts
if (seenTypes.has(param.type)) {
  throw new ProtocolViolationError(
    `duplicate message parameter type: 0x${param.type.toString(16)}`,
  );
}
```

すべてのパラメータ型に対して無条件に重複チェックが適用されている。

## 設計方針

1. AUTHORIZATION_TOKEN (0x03) を重複許可の例外とする（仕様上、このパラメータのみが明示的に繰り返しを許可している）
2. 他のパラメータ型は引き続き重複を拒否する

## 完了条件

- AUTHORIZATION_TOKEN (0x03) が複数回出現しても重複エラーが発生しないこと
- 他のパラメータ型の重複は引き続き PROTOCOL_VIOLATION で拒否されること
- 関連するテストが追加されていること

## 解決方法

1. `decodeParameters` の重複チェックで AUTHORIZATION_TOKEN (0x03) をスキップする
2. PBT で AUTHORIZATION_TOKEN 複数指定のラウンドトリップテストを追加する
