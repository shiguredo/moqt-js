# moqt-devtools に C4M トークンの生成と検証ツールを追加する

- Created: 2026-09-29
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-c4m-token-tool
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools は MSF URI Fragment の `c4m` を取り込んで Token Type 0x01 (CAT) として送るが、トークンの中身 (COSE ヘッダ / クレーム / 署名) を確認する手段が無い。relay に拒否されたときに、期限切れ / `aud` 不一致 / `alg` 不一致 / 署名不一致のどれなのかを切り分けられない。また、relay やアプリの実装を試すときに CAT トークンを手元で発行する手段も無い。

そこで、`C4M` 名前空間のデコード / 検証 / 発行と Web Crypto API の鍵生成を使い、トークンの生成と検証をブラウザ内で試せる開発ツールを追加する。

## 現状

- `devtools/src/utils/c4m.ts` の `extractC4mBase64` と `devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` は Base64 を取り出して Token Type を 1 にするだけで、トークンの中身を解釈しない
- ライブラリの `C4M` 名前空間には CBOR / COSE / CAT があるが、JWK (RFC 7517) のデコードが無い。鍵を JWK で受け渡しするには JWK のパースと `CoseKey` への変換が必要
- devtools には `webtransport-devtools.html` / `webcodecs-devtools.html` という独立ツールページがあり、`devtools/vite.config.ts` の `build.rollupOptions.input` に登録してヘッダーからリンクする構成になっている
- 鍵の生成手段が無いため、トークンの発行を試すには外部で鍵を作る必要がある

## 設計方針

- `devtools/c4m-devtools.html` を追加し、`devtools/src/c4m-devtools/` に実装する。トークンの確認は接続セッションと独立した作業のため、独立ページにする
- 機能は次の 3 つ
  - デコード: compact 形式 / COSE 形式 / Base64 包みのトークンをデコードし、ヘッダ / クレーム / `moqt` スコープ / 現在時刻に対する `exp` / `nbf` を表示する
  - 検証: JWK (公開鍵) または対称鍵 (hex / base64 / テキスト) で署名を検証し、`moqt` スコープの認可判定 (アクション + namespace + track) を行う
  - 生成と鍵生成: Web Crypto API の `generateKey` で ES256 / ES384 / ES512 / EdDSA の鍵ペアと HMAC の対称鍵を生成し、クレームと `moqt` スコープを指定して `CatTokenBuilder` でトークンを発行する
- 鍵はメモリ上だけで扱い、URL / OPFS / localStorage に保存しない。生成した鍵はテスト専用であることを画面に明記する
- ライブラリに `src/c4m/jwk.ts` を追加する (JWK のデコード / エンコード、RFC 7638 のサムプリント、`CoseKey` との変換)。鍵の解釈を devtools 側に持たせない
- デプロイは既存の Cloudflare Pages の対象に含める。テスト用の鍵だけを扱う前提の注意書きを画面に出し、入力した鍵をログやストレージへ残さない
- DPoP proof の検証はライブラリに無いため対象外とし、`cnf` / `catdpop` は表示と発行だけを扱う

## 完了条件

- `devtools/c4m-devtools.html` で、生成した鍵ペアからトークンを発行し、そのトークンをデコードして公開鍵で検証できる
- HMAC 鍵での発行と検証もできる
- デコードしたトークンの `moqt` スコープで認可判定ができる
- `npx vp check` / `npx vp test run` / `npx vp pack` / `npx vp run e2e-test` が通る

## 解決方法

{未着手}

## 参照

- draft-ietf-moq-c4m-01 Section 2.1 (moqt claim) / Section 2.2 (moqt-reval) / Section 3.1.1 (catdpop) / Section 7.1 (Token Type)
- RFC 7517 (JWK) / RFC 7638 (JWK Thumbprint) / RFC 9053 (COSE Algorithms)
- `src/c4m/` の `CatToken` / `CatTokenBuilder` / `WebCrypto`
- `devtools/vite.config.ts` の `build.rollupOptions.input` / `devtools/src/App.tsx` のヘッダーリンク / `tests/e2e/devtools-authorization-token.spec.ts`
