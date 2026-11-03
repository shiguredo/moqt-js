# C4M の一次テストベクタを 02 の COSE バイナリ形式へ更新する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/update-c4m-test-vectors
- Polished: {YYYY-MM-DD}

## 目的

C4M 02 Appendix A は旧版の compact 形式・誤った claim 表現を修正し、COSE_Mac0 / COSE_Sign1 の完全なバイナリと base64url を提示した。古い付録だけを検証しても新版との一致を確認できない。

## 現状

- `src/c4m/testVectors.ts` は C4M 01 Appendix A をそのまま定数化したと説明する
- `src/c4m/cat.test.ts` は `TOKEN_VECTORS` を compact として decode し、HMAC の旧 algorithm ID、key 3 の旧 jkt、配列の moqt claim を期待する
- CBOR の catv / catu / network / geography / ALPN ベクタも旧付録の値である
- 既存 0703 は実リレーによる CAT の受理確認であり、一次ベクタを使う codec / 暗号検証とは目的が異なる

## 設計方針

- C4M 02 Appendix A 全体を確認し、`payload_cbor_hex`、`cose_hex`、`cose_b64` を一次ベクタとして取り込む。改行の除去規則に従って正確なバイト列へ戻す
- COSE_Mac0 tag 17 / HMAC algorithm 5、COSE_Sign1 tag 18 / ES256 の構造と署名・MAC を実 Web Crypto で検証する
- schema / label / confirmation は 0917〜0919 に依存する。テストのために期待値だけを実装へ合わせて変更しない
- Appendix A.6 の Composite Claims は未割当 key 0 の placeholder と文書が明記する。割当済みの正常な CAT として扱わず、未対応機能を実装済みとする根拠にも使わない
- compact を汎用 helper として残す場合も、最新版 C4M の Token Type 1 の一次ワイヤ形式と区別する。外部トークンを運ぶ Base64 / URL helper に compact の分解を追加しない

## 完了条件

- 最新付録の CBOR、COSE 構造、MAC / 署名、scope、validation の各組を検証できる
- 期限切れ、未到来、issuer / audience 不一致、改ざん、誤鍵、形式と algorithm 不一致の期待値が新版に一致する
- モック暗号や自前で生成した round-trip だけで一次ベクタ検証を代用しない
- 0703 の実リレー検証と本 issue の検証範囲が区別される

## 参照

- `refs/moq/draft-ietf-moq-c4m-02.txt` Appendix A.1〜A.7
- `src/c4m/testVectors.ts`、`src/c4m/cat.test.ts`、`src/c4m/cose.test.ts`、`src/c4m/webcrypto.ts`
- `issues/0703-test-c4m-cat-interop.md`

## 解決方法

{未着手}
