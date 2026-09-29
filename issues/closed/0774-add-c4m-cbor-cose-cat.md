# C4M の CBOR / COSE / CAT コーデックを追加する

- Created: 2026-09-29
- Completed: 2026-09-29
- Branch: feature/add-c4m-cbor-cose-cat
- Polished: {YYYY-MM-DD}

## 目的

devtools が受け取る C4M (CAT) トークンの中身を確認・検証する手段が無く、Base64 文字列として素通ししている。relay や issuer が発行したトークンの構造 (COSE ヘッダ / クレーム / 署名) をブラウザ内で検証できるようにするため、依存ゼロの CBOR / COSE / CAT コーデックをライブラリに追加する。

## 現状

- `src/msf/c4m.ts` の `getC4mParameter` は MSF URI Fragment の `c4m` を Base64 文字列のまま返すだけで、Token Type もトークンの中身も解釈しない
- devtools は `devtools/src/utils/c4m.ts` の `extractC4mBase64` で Base64 を取り出すだけであり、COSE ヘッダやクレームを表示・検証できない
- draft-ietf-moq-c4m-01 Section 7.1.1 は Token Type 0x01 (CAT) の Token Payload を CBOR でエンコードした CWT として直列化した CAT と定めるが、その構造を解釈する実装がリポジトリに無い
- 実行時依存は持っておらず、トークンの確認のためだけに CBOR / COSE のライブラリを追加したくない

## 設計方針

- `src/c4m/` に CBOR (RFC 8949) / COSE (RFC 9052、CWT は RFC 8392) / CAT (CTA-5007-B / draft-ietf-moq-c4m-01) を依存ゼロで実装する
  - CBOR は RFC 8949 Section 4.2 の決定論的エンコードに従う。64 ビット整数は bigint、浮動小数点数は値を保つ最短幅 (半精度 / 単精度 / 倍精度) で扱い、デコードでは重複キー / ネスト深度 / UTF-8 を検証する
  - COSE は COSE_Sign1 (タグ 18) / COSE_Mac0 (タグ 17) / CWT (タグ 61) と、protected / unprotected ヘッダの `crit` 検証を扱う
  - 署名 / 検証は `CoseCrypto` インターフェースに分離し、暗号ライブラリは Web Crypto API だけを使う実装 (`WebCrypto`) を提供する。対応アルゴリズムは HMAC-SHA256 / 384 / 512、ES256 / ES384 / ES512、EdDSA
  - CAT は compact 形式 (base64url 3 分割) と COSE 形式のデコード、`CatTokenBuilder` による発行、`CatToken.verify` による検証、`exp` / `nbf` / `iss` / `aud` の時刻・期待値検証、`moqt` クレームによる認可判定を提供する
  - URL 埋め込みを想定した標準 Base64 (パディング有無の両方) もデコードで受理する
- `refs/moq/draft-ietf-moq-c4m-01.txt` の付録 A のテストベクタ (CBOR / トークン / DPoP バインディング / スコープ認可 / 検証) をテストで固定する
- 公開は `src/index.ts` の `C4M` 名前空間経由で行い、実行時依存は追加しない

## 完了条件

- draft-ietf-moq-c4m-01 付録 A の全トークンをデコードでき、署名を検証できる
- Web Crypto API で HMAC / ECDSA / Ed25519 の署名と検証が往復できる
- `C4M` 名前空間として公開される
- `npx vp check` / `npx vp test run` / `npx vp pack` が通る

## 解決方法

- `src/c4m/` に依存ゼロの CBOR (RFC 8949) / COSE (RFC 9052) / CAT (CTA-5007-B / draft-ietf-moq-c4m-01) を追加した
  - `cbor.ts` は RFC 8949 Section 4.2 の決定論的エンコード、bigint 整数、値を保つ最短幅の浮動小数点数、indefinite 長のデコード、重複キー / 深度 / UTF-8 の検証を行う
  - `cose.ts` は COSE_Sign1 / COSE_Mac0 / CWT の構造と protected / unprotected ヘッダ (`alg` / `kid` / `typ` / `crit`) を扱う
  - `crypto.ts` / `webcrypto.ts` は署名 / 検証を `CoseCrypto` に分離し、Web Crypto API だけを使う実装を提供する (HMAC-SHA256 / 384 / 512、ES256 / ES384 / ES512、EdDSA)
  - `moqt.ts` は `moqt` / `moqt-reval` / `catdpop` クレームとスコープ認可、`cat.ts` は compact 形式 / COSE 形式のデコード、発行ビルダー、署名検証、時刻検証を提供する
  - `refs/cbor/` に RFC 原文を追加した
- `src/index.ts` で `C4M` 名前空間として公開した
- `src/c4m/cbor.test.ts` / `cose.test.ts` / `cat.test.ts` / `moqt.test.ts` / `webcrypto.test.ts` で付録 A の全テストベクタ (CBOR / トークン / DPoP バインディング / スコープ認可 / 検証) と Web Crypto の署名 / 検証を固定し、`cbor.prop.ts` / `base64url.prop.ts` で往復の PBT を追加した
- `CHANGES.md` に `[ADD]` を追記した

## 参照

- draft-ietf-moq-c4m-01 Section 2 (Token format) / Section 2.1 (moqt claim) / Section 2.2 (moqt-reval) / Section 3.1.1 (catdpop) / Section 7.1 (Token Type) / 付録 A (テストベクタ)
- RFC 8949 (CBOR) / RFC 9052 (COSE) / RFC 8392 (CWT) / RFC 9053 (COSE Algorithms) / RFC 9596 (COSE typ)
- CTA-5007-B (Common Access Token)
- `refs/moq/draft-ietf-moq-c4m-01.txt`、`refs/cbor/`
