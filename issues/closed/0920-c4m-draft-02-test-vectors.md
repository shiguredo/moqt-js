# C4M の一次テストベクタを 02 の COSE バイナリ形式へ更新する

- Created: 2026-11-03
- Completed: 2026-11-05
- Branch: feature/change-c4m-draft-02
- Polished: 2026-11-03

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
- 共通 COSE header decoder を標準の algorithmFromIdentifier に揃え、旧付録を救済する algorithmFromIdentifierWithC4mDraftAlias と -4 の HMAC alias を除去する。-4 は RFC 9053 の A192KW であり、HMAC として受理しない。旧 alias の定数・公開説明・受理テストも更新する
- schema / label / confirmation は 0917〜0919 に依存する。テストのために期待値だけを実装へ合わせて変更しない
- A.5 の moqt_admin_wildcard は旧 action 0〜8 と ClientSetup / ServerSetup の名前、action 0 の認可期待を残し、本文 §2.1 Table 1 と一致しない。原本のバイト列・付属情報は変更せず不整合を注記し、標準 action の意味検証では本文を優先する。0 を SETUP に読み替えず、SETUP=1 が許可されることと、このベクタが SUBSCRIBE_TRACKS=9 を含まないことを検証する
- Appendix A.6 の Composite Claims は未割当 key 0 の placeholder と文書が明記する。割当済みの正常な CAT として扱わず、未対応機能を実装済みとする根拠にも使わない
- 署名・MAC の検証には一次資料の元 payload バイト列を使う。特に A.6 の原本は map の順序が canonical な再エンコードで変わるため、decode / encode のバイト一致を正常な CAT の条件として強制しない
- compact を汎用 helper として残す場合も、最新版 C4M の Token Type 1 の一次ワイヤ形式と区別する。外部トークンを運ぶ Base64 / URL helper に compact の分解を追加しない

## 完了条件

- 最新付録の CBOR、COSE 構造、MAC / 署名、scope、validation の各組を検証できる
- 期限切れ、未到来、issuer / audience 不一致、改ざん、誤鍵、形式と algorithm 不一致の期待値が新版に一致する
- 新しい COSE に -4 を HMAC として受理せず、HMAC algorithm 5 と ES256 の検証を維持する
- A.5 admin の旧 action 0 の期待を標準認可へ持ち込まず、SETUP=1 / SUBSCRIBE_TRACKS=9 の結果と原本の不整合を説明できる
- モック暗号や自前で生成した round-trip だけで一次ベクタ検証を代用しない
- 0703 の実リレー検証と本 issue の検証範囲が区別される

## 参照

- `refs/moq/draft-ietf-moq-c4m-02.txt` Appendix A.1〜A.7
- `src/c4m/testVectors.ts`、`src/c4m/cat.test.ts`、`src/c4m/cose.test.ts`、`src/c4m/webcrypto.ts`
- `src/c4m/cose.ts` の header decoder / `algorithmFromIdentifierWithC4mDraftAlias`、`refs/cbor/rfc9053.txt` の COSE Algorithms 登録値
- `issues/0703-test-c4m-cat-interop.md`

## 解決方法

- `refs/moq/draft-ietf-moq-c4m-02.txt` Appendix A の全ベクタを `src/c4m/testVectors.ts` に取り込んだ。折り返しは文書の規則どおり改行と後続インデントを除去し、ページヘッダ / フッタを除いてバイト列へ戻した。
  - A.2 (CBOR Encoding of Claims) 8 件、A.3 (Token Structure) 3 件、A.4 (DPoP Binding) 3 件、A.5 (MOQT Authorization Scopes) 5 件、A.6 (Composite Claims) 4 件、A.7 (Token Validation) 8 件
  - A.3〜A.7 の `cose_hex` と `cose_b64` が同一バイト列であること、payload が COSE 構造内に埋め込まれていることをテストで固定した
- 署名・MAC の検証は `src/c4m/webcrypto.ts` の実 Web Crypto だけを使い、モック暗号を使っていない。COSE_Mac0 (tag 17 / HMAC algorithm 5) と COSE_Sign1 (tag 18 / ES256) の両方を検証した。
- **`-4` の HMAC alias を削除した。** `src/c4m/cose.ts` から `C4M_DRAFT_HMAC_SHA256_ALGORITHM_ID` と `algorithmFromIdentifierWithC4mDraftAlias` を削除し、共通ヘッダデコーダを `algorithmFromIdentifier` に統一した。`-4` は RFC 9053 §6.2.1 Table 13 の A192KW であり、HMAC-SHA256 として受理しない（`unsupportedAlgorithm`）。PBT の生成器からも `-4` の組を削除した。
- `VALIDATION_VECTORS` を c4m-01 A.6 の compact トークン（alg `-4`）から **c4m-02 A.7**（alg 5、`token` は base64url の完全な COSE_Mac0）へ差し替えた。`expected_error` と実装の対応（`TokenExpired` → `ClaimValidationError("expired")` など）はテストのコメントに対応表として明記した。
- A.5 の `moqt_admin_wildcard` は原本のバイト列・`action_names`・action 0 の認可期待を変更せずに保持した。原本と本文 §2.1 Table 1 が一致しない旨を注記し、0 を SETUP に読み替えず、SETUP=1 が許可されることと SUBSCRIBE_TRACKS=9 を含まず許可されないことを検証した。
- A.6 (Composite Claims) は未割当 key 0 を placeholder に使うベクタとしてのみ取り込み、正常な CAT としてデコードせず、`or` / `and` / `nor` として解釈しないことを確認した。map 順序が canonical な再エンコードで変わるため、decode / encode のバイト一致を正常性の条件にしていない。複合クレームの評価機能を実装した扱いにはしていない。
- compact は旧 c4m-01 付録 A の汎用 helper であり、c4m-02 の Token Type 1 の一次ワイヤ形式ではない旨を `cat.ts` / `base64url.ts` / README に明記した。devtools の発行既定を COSE にし、compact を legacy helper として表示する。
- 本 issue の検証は一次資料の固定バイト列に対する CBOR / COSE / MAC / 署名 / scope / validation であり、実リレーに接続する E2E は実施していない。その範囲は 0703 の実リレー検証と区別される。
- 検証: `vp check` / `vp exec tsc --noEmit` / `vp test run`（272 ファイル / 4,916 テスト）/ `vp run build` / `vp run build:devtools` が通る。

### 既知の制限

- 複合クレーム（Composite Claims）の評価エンジンは実装していない。
- 実リレー E2E は未実施である。
