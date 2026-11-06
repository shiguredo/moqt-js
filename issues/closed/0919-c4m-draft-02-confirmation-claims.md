# C4M 02 の ckt と jkt に confirmation の解釈を揃える

- Created: 2026-11-03
- Completed: 2026-11-05
- Branch: feature/change-c4m-draft-02
- Polished: 2026-11-03

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

- `src/c4m/cat.ts` の `Confirmation` を `ckt`（confirmation key 5）と `jkt`（key 323）の型付き表現に変更し、`jwkThumbprint` と `c4mDraftJwkThumbprint` を削除した。`CONFIRMATION_COSE_KEY_THUMBPRINT = 5` を追加し、key 3 の定数は削除した。
- draft-ietf-moq-c4m-02 §4.1 は `ckt`（COSE Key Thumbprint、RFC 9679）を推奨し、互換用に `jkt`（JWK SHA-256 Thumbprint）を定義する。key 3 は IANA の CWT Confirmation Methods レジストリで `kid`（RFC 8747 §3.4）であり jkt ではないため、型付きフィールドへ昇格させず `raw` にそのまま保持する。
- `confirmationJkt` は key 323 の値だけを返し、key 3 へのフォールバックを削除した。`confirmationCkt` を追加した。key 3 が `confirmationJkt` の結果にならないことを単体テストと旧ベクタの両方で固定した。
- `decodeConfirmation` / `encodeConfirmation` を ckt / jkt に対応させ、Value が bstr でない場合は `unexpectedType`、同じ confirmation key の重複は `duplicateConfirmation` で拒否する。型付き key を `raw` に置いた場合も拒否する。未知 key は raw に保持し、意味を捏造しない。
- `CatTokenBuilder` に `ckt()` / `jkt()` を追加し、`c4mDraftJwkThumbprint()` を削除した。devtools は `cnf.ckt` / `cnf.jkt` / `cnf.raw` を表示し、発行時は `jkt` を設定する。
- **ckt の算出 API は追加していない。** `jwkThumbprintSha256` は JWK サムプリント（RFC 7638）専用であり、COSE Key Thumbprint（RFC 9679）へ流用してはならない旨を `cat.ts` と `jwk.ts` の JSDoc に明記した。
- proof が存在しない状態で DPoP の認証・検証が完了したとは扱わない旨を、`Confirmation` / `cat.ts` の JSDoc、README、`docs/LOW_LEVEL_API.md` に明記した。DPoP proof の送信 binding、actx / ath の未割当 label、relay の proof 検証・replay 保護は issue の対象外として実装していない。
- `authorizeCatClaims` は `cnf` を持つトークンを既定で拒否する。認可するのは、呼び出し側が `{ dpopProofVerified: true }` を渡し、かつ `cnf` が ckt / jkt を持つ場合だけである。`cnf` が ckt / jkt を持たない場合は proof の鍵との一致 (§4.3 の条件 4) を確認できないため、`true` でも拒否する。`dpopProofVerified: true` は同一のトークン・action / namespace / track について §4.3 の条件を満たす proof を検証した場合だけ渡し、他の action やトークンへ使い回さない (§4.4)。
- テストは ckt / jkt の独立 round-trip、両方 + 未知 key + key 3 を同時に持つ cnf の保持、key 3 が jkt にならない回帰、不正な Value 型の拒否、未知 key の raw 保持、付録 A.4 の `dpop_jwk_binding` を key 323 として解釈する検証、confirmation key の重複拒否を追加した。PBT の Confirmation arbitrary も新しい型へ追随させた。
- 検証: `vp check` / `vp exec tsc --noEmit` / `vp test run`（272 ファイル / 4,915 テスト）/ `vp run build` / `vp run build:devtools` が通る。

### 既知の制限

- COSE Key Thumbprint（RFC 9679）の算出は未実装である。`ckt` は受信値の保持と公開までを対象とする。
- 実リレー E2E は未実施である。
