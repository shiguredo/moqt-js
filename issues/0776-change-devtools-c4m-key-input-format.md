# moqt-devtools の C4M ツールで鍵入力の解釈を画面に表示する

- Created: 2026-09-29
- Completed: {YYYY-MM-DD}
- Branch: feature/change-devtools-c4m-key-input-format
- Polished: {YYYY-MM-DD}

## 目的

C4M ツールの署名鍵 / 検証鍵の入力は、選択した形式 (`auto`) や JWK の解釈結果が画面に出ないため、入力がどう解釈されたのか分からない。意図しない解釈 (例: テキストのつもりの `password` が base64url の 6 バイトになる) に気づけない。

## 現状

- `devtools/src/c4m-devtools/utils/keys.ts` の `parseSecretInput` の `auto` は、16 進として読める場合は 16 進、次に base64url として読める場合は base64url、それ以外は UTF-8 のテキストとして解釈する
- `devtools/src/c4m-devtools/App.tsx` の署名鍵 (`c4m-signing-key`) は、値が `{` で始まる場合は JWK として解釈し、形式の選択 (`c4m-signing-secret-format`) を無視する
- 検証鍵 (`c4m-verify-key`) は形式の選択が無く、常に `auto` で解釈する
- どちらも解釈結果 (JWK の種類 / 秘密鍵の有無、secret の形式とバイト数) を表示しない

## 設計方針

- `keys.ts` に `inspectKeyInput` を追加し、入力の解釈結果 (empty / JWK / secret / error) を返す。署名 / 検証の鍵解決も同じ関数を使い、表示と実際の解釈を一致させる
- 入力欄の下に解釈結果を表示する。JWK は `EC P-256 (private key)` のように種類と秘密鍵の有無、secret は `hex, 32 bytes` のように形式とバイト数、エラーはその内容を出す
- 形式の選択の `auto` を `Detect` に変え、検証鍵にも同じ選択を付ける
- 署名に使う JWK に秘密鍵が無い場合は、署名時ではなく表示の時点で分かるようにする

## 完了条件

- 署名鍵 / 検証鍵の下に解釈結果が表示される
- `Detect` の解決順 (hex → base64url → text) と JWK の優先が画面から読み取れる
- `npx vp check` / `npx vp test run` / `npx vp run e2e-test` が通る

## 解決方法

{未着手}

## 参照

- `devtools/src/c4m-devtools/utils/keys.ts` の `parseSecretInput` / `parseJwkInput`
- `devtools/src/c4m-devtools/App.tsx` の `resolveSigningKey` / `resolveVerifyKey`
