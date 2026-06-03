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

1. `decodeParameters` の重複チェックで AUTHORIZATION_TOKEN (0x03) をスキップする。他のパラメータ型は引き続き重複を拒否する
2. 仕様 Section 10.2.2 の「as long as the combination of Token Type and Token Value are unique after resolving any aliases」の制約については、現状のコードが Token の中身を解析していないため本 issue のスコープ外とする（同一内容の AUTHORIZATION_TOKEN 重複は検知されないが、これは別 issue で対応）

## 完了条件

- AUTHORIZATION_TOKEN (0x03) が複数回出現しても重複エラーが発生しないこと
- 他のパラメータ型（例: 0x02, 0x04 等）の重複は引き続き `ProtocolViolationError` で拒否されること
- `parameter.test.ts` の既存テスト「重複パラメータで ProtocolViolationError」が修正後も通過すること（後退防止）

### 必要なテストケース

1. AUTHORIZATION_TOKEN が 2 回出現 → 正常デコード、両方の値が取得可能
2. AUTHORIZATION_TOKEN が 3 回出現 → 同上
3. AUTHORIZATION_TOKEN 以外のパラメータ（0x02 など）が重複 → `ProtocolViolationError`
4. AUTHORIZATION_TOKEN + 他パラメータの正常混在 → 正常デコード
5. `parameter.prop.ts` で AUTHORIZATION_TOKEN 複数指定のラウンドトリップ PBT を追加
