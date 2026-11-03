# C4M 02 の ckt と jkt に confirmation の解釈を揃える

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-c4m-confirmation-claims
- Polished: {YYYY-MM-DD}

## 目的

C4M 02 §4.1 は cnf の ckt (key 5) を推奨し、互換用 jkt も定義する。付録 A の jkt は 323 に修正された。現在は key 3 を旧 jkt と解釈する専用フィールドがあり、新仕様の意味と合わない。

## 現状

- `src/c4m/cat.ts` の `Confirmation` は `jwkThumbprint` と `c4mDraftJwkThumbprint` を持ち、後者に key 3 を使う
- `confirmationJkt` は key 323 が無ければ key 3 をサムプリントとして返す
- key 5 は raw として保持できるが ckt としての型付き API は無い
- `src/c4m/jwk.ts` は JWK サムプリントと COSE_Key との変換を持つが、C4M 02 の cnf モデルとは未接続である

## 設計方針

- ckt (key 5) と jkt (key 323) の型付き表現を用意し、encode / decode / builder の説明を更新する
- key 3 をサムプリントに読み替える旧互換を除き、未知・未対応の confirmation はその意味を捏造せず保持する
- ckt と JWK サムプリントは異なる計算である。COSE Key Thumbprint の算出を公開する場合は RFC 9679 の一次資料と固定ベクタで検証し、JWK thumbprint helper を流用しない
- 本 issue は既存の cnf モデルの更新である。DPoP proof の送信 binding、actx / ath の未割当 label、relay の proof 検証・replay 保護は実装しない

## 完了条件

- ckt / jkt を独立に round-trip し、key 3 が `confirmationJkt` の結果にならない
- 不正な Value 型、未知 key、複数 confirmation の扱いを検証する
- C4M 02 付録 A.4 の jkt を key 323 として解釈できる
- proof が存在しないのに DPoP の認証・検証が完了したと API 文書で説明しない

## 参照

- `refs/moq/draft-ietf-moq-c4m-02.txt` §4.1〜§4.3 / Appendix A.4
- [RFC 9679](https://www.rfc-editor.org/rfc/rfc9679)
- `src/c4m/cat.ts` の `Confirmation` / `decodeConfirmation` / `encodeConfirmation` / `confirmationJkt`、`src/c4m/jwk.ts`

## 解決方法

{未着手}
