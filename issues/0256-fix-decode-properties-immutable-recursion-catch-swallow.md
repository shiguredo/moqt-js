# decodeProperties の IMMUTABLE_PROPERTIES 再帰チェックが try/catch で無効化されている問題を修正する

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03
- Relations: #0251 (先行実装。再帰チェック追加時の catch {} が原因)

## 目的

`src/properties.ts` の `decodeProperties` 内で IMMUTABLE_PROPERTIES の再帰的包含を検出するコードが存在するが、`catch {}` で `MalformedTrackError` が握り潰され検出不能になっている。

`parseProperties` (object properties 用, line ~553) では同一チェックが try/catch の**外**で行われており正しく動作する。`decodeProperties` 側のみ try/catch で覆われている理由はなく、除去が妥当。

draft-ietf-moq-transport-18 §12.7 (Immutable Properties):

> A Track is considered malformed (see Section 2.4.2) if any of the following
> conditions are detected:
>
> - An Object contains an Immutable Properties property that contains another
>   Immutable Properties key.
> - A Key-Value-Pair cannot be parsed.

2 つ目の条件（KVP parse 不可）は `decodeImmutableProperties` 等の後段パースで検出される。ただし内側走査用 try/catch を削除した場合、内側 KVP 走査中の parse 失敗が上位に漏れて `ProtocolViolationError` でセッションを閉じるのは過剰反応である。`IncompleteDataError` のみを無視すればよい。

## 優先度根拠

仕様で malformed track と規定されている状態を検出できない。コードレビューで発見されたデッドコード化バグ。致命的。

## 現状

- `properties.ts:662-685`: `decodeProperties` の inner KVP 走査ループ
- `MalformedTrackError` throw (line 671) が `catch {}` (line 683) で握り潰される
- 結果として `extensions.push({ id, data: extData })` (line 687) が不正データを含めて実行される
- 再現用データ: `0x0B (IMMUTABLE_PROPERTIES) + length + inner: 0x0B (再帰 IMMUTABLE_PROPERTIES) + ...`

## 設計方針

try/catch を削除し、IMMUTABLE_PROPERTIES 再帰チェックを try/catch の外に移動する。内側 KVP 走査は `IncompleteDataError` のみを無視するよう限定する。

```typescript
if (id === MOQTPropertyId.IMMUTABLE_PROPERTIES && extData.length > 0) {
  let innerOffset = 0;
  let innerPreviousId = 0n;
  while (innerOffset < extData.length) {
    try {
      const [deltaId, deltaIdLen] = decodeVarint(extData.subarray(innerOffset));
      const innerId = innerPreviousId + deltaId;
      innerPreviousId = innerId;
      if (innerId === MOQTPropertyId.IMMUTABLE_PROPERTIES) {
        throw new MalformedTrackError(
          "IMMUTABLE_PROPERTIES cannot contain another IMMUTABLE_PROPERTIES",
        );
      }
      if (innerId % 2n === 0n) {
        const [, valueLen] = decodeVarint(extData.subarray(innerOffset + deltaIdLen));
        innerOffset += deltaIdLen + valueLen;
      } else {
        const [innerLength, innerLengthLen] = decodeVarint(
          extData.subarray(innerOffset + deltaIdLen),
        );
        innerOffset += deltaIdLen + innerLengthLen + Number(innerLength);
      }
    } catch (err) {
      if (err instanceof IncompleteDataError) {
        break; // 不完全な内側 KVP は後段の decodeImmutableProperties で検出される
      }
      throw err;
    }
  }
}
```

`MalformedTrackError` は `decodeProperties` の呼び出し元 (`session.ts:296`, `subscribe.ts:179`, `publish.ts:134,180`, `fetch.ts:249`) に伝搬し、`handleIncomingStream` の `MalformedTrackError` ハンドリングで適切に処理される（既存の実装で対応済み）。

## 完了条件

- `decodeProperties` で IMMUTABLE_PROPERTIES の再帰的包含を検出した場合に `MalformedTrackError` が正しく throw されること
- 内側 KVP データが不完全（途中で切れているバイト列）の場合は `IncompleteDataError` を無視し、後段検出に任せること
- `properties.test.ts` に以下のテストを追加すること:
  - `decodeProperties` 経由での IMMUTABLE_PROPERTIES 再帰検出 → `MalformedTrackError`
  - 不完全な内側 KVP データ → `decodeProperties` が正常に完了すること（握り潰し確認）

## 解決方法

1. `src/properties.ts` の `decodeProperties` から try/catch (line 683-685) を削除し、内側 KVP 走査の catch で `IncompleteDataError` のみ break する実装に変更する
2. 内側 `length` 変数を `innerLength` にリネームし、外側 `length` とのシャドウイングを解消する（#0270 も同時に対応）
3. `src/properties.test.ts` に再帰検出テストと不完全データ握り潰しテストを追加する
