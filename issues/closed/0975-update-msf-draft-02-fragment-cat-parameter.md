# 予約 fragment パラメータを cat にする

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §11.1.1 Table 12 は、予約 fragment パラメータのうち C4M のトークンを運ぶキーを `cat` と定める。draft-01 は `c4m` だった。現行実装は `c4m` の完全一致で探すため、draft-02 の URL `#msf:namespace--name&cat=...` ではトークンを取り出せず、認可が必要な relay に接続できない。

draft-01 との互換性は維持しない。`c4m` は受理しない。

## 現状

- `src/msf/c4m.ts` の `getC4mParameter` は `key === "c4m"` の完全一致で最初の値を返す。関数名も `c4m` に合わせている
- `src/msf/c4mAuthorization.ts` の `resolveMsfAuthorizationToken` は `getC4mParameter` の結果だけを使い、`c4m` の値が Base64 として復号できない場合にエラーにする
- `src/msf/authInfo.ts` の `C4M_VARIABLE_REFERENCE` は `%c4m%` を返す。`catalogAuthInfoForSetupToken` は `{"cat": "%c4m%"}` を組み立てる
- `src/msf.ts` は `getC4mParameter` と `createC4mAuthorizationToken`、`resolveMsfAuthorizationToken` を再輸出する
- `src/connect.ts` と `src/createMediaPublisher.ts`、`src/createMediaSubscriber.ts` が `resolveMsfAuthorizationToken` を使う
- `devtools` の接続設定が `c4m` を前提にした入力を扱う
- `src/msf/c4m.ts` は `wallclock-range`、`mediatime-range`、`location-range` の helper も持つ。draft-02 でこれらの形式は変わっていない

## 設計方針

- `getC4mParameter` を `getCatParameter` に改名し、`key === "cat"` で探す。`c4m` を探すコードは残さない
- `createC4mAuthorizationToken` と `resolveMsfAuthorizationToken` の名前は、C4M のトークンを扱う関数であることを示すため維持する。引数名と JSDoc の `c4m` 表記を `cat` に直す
- `C4M_VARIABLE_REFERENCE` を `%cat%` にする。`catalogAuthInfoForSetupToken` が返す `authInfo` は `{"cat": "%cat%"}` になる
- `variables.ts` の変数名の扱いが 0974 で変わるため、`%cat%` が変数参照として解決できることを確認する
- `src/msf.ts` の再輸出名を追随させる。旧名の別名 export は残さない
- devtools の入力欄のラベルとプレースホルダを `cat` に直し、E2E テストの URL を `cat=` に更新する

## 完了条件

- `#msf:ns--name&cat=AAAA` からトークンを取り出せる。単体テストで固定する
- `#msf:ns--name&c4m=AAAA` ではトークンを取り出さない (未認可として扱う)。単体テストで固定する
- `catalogAuthInfoForSetupToken` が `{"cat": "%cat%"}` を返す。単体テストで固定する
- `%cat%` を `resolveCatalogVariables` で解決できる。単体テストで固定する
- devtools の E2E が `cat=` の URL で通る
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/c4m.ts` の `getC4mParameter` を `getCatParameter` に改名し、キー `cat` だけを探すようにした
- `src/msf/c4mAuthorization.ts` の探索とエラー文言を cat に追随させ、参照節を draft-02 §11.1.1 / §11.5.3 に直した
- `src/msf/authInfo.ts` の変数参照を `%cat%` にした。`src/msf.ts` の再輸出も `getCatParameter` に変えた
- devtools の URL 解析 (`extractC4mBase64` / `removeC4mParameter` / `maskC4mValue`) と伏せ字を `cat=` にし、E2E と単体テストの URL を更新した
- draft-01 の `c4m=` は未知の parameter として無視する
