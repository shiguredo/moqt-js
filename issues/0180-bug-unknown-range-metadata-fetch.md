# Fetch レスポンスの Unknown Range Metadata Type を処理できない

Created: 2026-05-13
Model: Opus 4.7

## 概要

`src/fetcher.ts:11` に TODO として残っている Unknown Range Metadata Type の処理が未実装である。

```typescript
// TODO: Unknown Range Metadata Type の実装
```

draft-ietf-moq-transport-17 §9.14 で定義されている「未シリアライズのオブジェクト範囲 (unknown range)」を Fetch レスポンスで受け取った場合に、適切に処理できない。

## 一次資料の引用

draft-ietf-moq-transport-17 §9.14:

> A publisher MAY send Objects in a range that it has not yet serialized as
> an "unknown range", which the subscriber can use to determine that the
> publisher is still generating Objects in that range.

## 現状の実装

Fetch データストリームのデコード (`processFetchObjects` → `decodeFetchObjectFields`) では、オブジェクトのデコードだけを行い、未知範囲を示すメタデータ型を考慮していない。Unknown Range を示す特別なレコードが届いた場合、通常のオブジェクトとして誤ってデコードされる可能性がある。

## 期待される動作

Unknown Range Metadata Type のレコードを受信した場合:

1. 当該範囲のオブジェクトが未シリアライズであることを認識する
2. エラーではなく、正常なレスポンスの一部として扱う
3. `FetchCallbacks` または `Fetcher` インターフェース経由でアプリケーションに通知する (オプション)

## 実装方針

1. `src/dataStream.ts` で Unknown Range Metadata Type の decode 関数を追加
2. `src/session/stream.ts` の `processFetchObjects` で Unknown Range レコードを処理する分岐を追加
3. `FetcherImpl` に unknown ranges の追跡と API を追加 (必要に応じて)
4. 少なくとも、Unknown Range をエラーにせず正常に処理する (skip する)

## 影響範囲

- `src/dataStream.ts`: Unknown Range Metadata Type の型定義とデコード
- `src/session/stream.ts`: `processFetchObjects` の分岐
- `src/fetcher.ts`: `FetcherImpl` / `Fetcher` インターフェース

## テスト戦略

- Unknown Range レコードを含む Fetch ストリームを正しく処理できること
- Unknown Range がエラーにならないこと

## ブランチ命名

`feature/fix-` を使う。

## 完了条件

- TODO コメントが削除されている
- Unknown Range Metadata Type をデコードできる
- `processFetchObjects` で Unknown Range を正常に処理できる
- `vp run test` 全パス
- `vp run build` 成功
