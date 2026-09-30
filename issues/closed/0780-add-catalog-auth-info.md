# CAT で接続した配信が catalog の track に authInfo を書かず、視聴側がトークンを付けない

- Created: 2026-09-30
- Completed: 2026-09-30
- Branch: feature/add-catalog-auth-info
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-msf-01 §5.2.42 は、track の認可が必要なことを catalog の track の `authInfo` で示すと定める ("The presence of this field signals to subscribers that they must obtain and present valid authorization tokens when subscribing to this track")。§11.4.1 も、視聴側は catalog の `authInfo` を見て認可の要否を知るとする。

moqt-js の配信は、C4M のトークン (CAT) で接続しても catalog の track に `authInfo` を書かない。そのため MSF に従う視聴側は track の認可が不要だと判断し、SUBSCRIBE にトークンを付けない。リクエストごとにトークンで認可する relay では、視聴側の SUBSCRIBE がすべて断られる。

## 現状

- `src/createMediaPublisher.ts` の `createCatalogTracks` は、音声と映像の track に `authInfo` を載せない
- `devtools/src/hooks/usePublisher.ts` の `buildPublisherCatalog` は、音声、映像、event timeline の track に `authInfo` を載せない
- 視聴側の `src/createMediaSubscriber.ts` の `resolveAuthorizationToken` は、track の `authInfo` があるときだけトークンを解決して SUBSCRIBE に付ける (§5.2.42 / §11.4.3)
- `src/msf/variables.ts` の `resolveCatalogVariables` は、`authInfo` の文字列の値の `%name%` を fragment の変数で置換する (§5.4 / §5.2.43)
- CAT の Token Type は `src/c4m/cat.ts` の `MOQT_AUTH_TOKEN_TYPE_CAT` (0x01) にある

## 設計方針

- SETUP の Authorization Token が CAT (Token Type 0x01) のとき、配信は catalog の track に `"authInfo": {"cat": "%c4m%"}` を書く
  - `cat` は §5.2.42 Table 7 の CAT のスキーム名である
  - 値の `%c4m%` は、§11.1.1 の予約パラメータ `c4m` を指す変数参照である (§5.4 / §5.2.43)。視聴側は fragment の `c4m` で置換できる
  - トークンそのものは catalog に書かない。catalog はすべての視聴者に届き、配信者のトークンは PUBLISH の権限を含む
  - Alias Type が USE_VALUE と REGISTER のときだけ Token Type を持つ。DELETE / USE_ALIAS は Token Type を持たないため書かない
- 判定は Sans I/O の純関数 `catalogAuthInfoForSetupToken` として `src/msf/` に置き、公開 API にする (DevTools からも使う)
- `createMediaPublisher` は `MediaPublisherOptions.authorizationToken` で判定し、音声と映像の track に載せる
- DevTools の配信は、接続の設定から組み立てる SETUP のトークン (`buildAuthorizationToken`) で判定し、音声、映像、event timeline の track に載せる
- 視聴側のトークンの付け方は変えない。`authInfo` のある track で `getAuthorizationToken` を渡していない `createMediaSubscriber` は、これまでどおり subscribe を失敗させる (§11.4.4)

## 完了条件

- `catalogAuthInfoForSetupToken` が、CAT の USE_VALUE / REGISTER のときだけ `{"cat": "%c4m%"}` を返すことをテストで確かめる
- `createMediaPublisher` が CAT で接続したときだけ、音声と映像の track に `authInfo` を載せることを、送った catalog の読み戻しで確かめる
- DevTools の `buildPublisherCatalog` が、指定したときだけ音声、映像、event timeline の track に `authInfo` を載せることをテストで確かめる
- 書いた `authInfo` が `decodeCatalogMessage` で読め、`resolveCatalogVariables` が `c4m` の値 (パディング無しの base64url) で置換できることをテストで確かめる
- `docs/HIGH_LEVEL_API.md`、`docs/MSF.md`、`CHANGES.md` に書く
- `pnpm test` / `pnpm typecheck` / `pnpm lint` が通る

## 関連 issue

- 0642: PUBLISH に AUTHORIZATION TOKEN を載せられない

## 解決方法

- `src/msf/authInfo.ts` (新規) に `catalogAuthInfoForSetupToken` を追加し、`src/msf.ts` と `src/index.ts` から公開した。SETUP の Authorization Token が CAT (`MOQT_AUTH_TOKEN_TYPE_CAT`) の USE_VALUE / REGISTER のときだけ `{"cat": "%c4m%"}` を返す
- `src/createMediaPublisher.ts` の `createCatalogTracks` が、`authorizationToken` から決めた `authInfo` を音声と映像の track に載せる
- `devtools/src/hooks/usePublisher.ts`
  - `PublisherCatalogOptions` / `PublisherCatalogSettings` に `authInfo` を足し、`buildPublisherCatalog` が指定されたときだけ音声、映像、event timeline の track に載せる
  - `buildPublisherCatalogOptionsFromSettings` が、接続の設定から組み立てる SETUP のトークン (`buildAuthorizationToken`) で `authInfo` を決める
- テスト
  - `src/msf.test.ts`: `catalogAuthInfoForSetupToken` の Alias Type と Token Type ごとの結果、書いた `authInfo` の読み戻しと `resolveCatalogVariables` による `c4m` (パディング無しの base64url) の置換
  - `src/createMediaPublisher.test.ts`: CAT のときだけ音声と映像の track に載せる (送った catalog の読み戻し)、CAT 以外とトークン無しでは載せない
  - `devtools/src/hooks/usePublisher.test.ts`: 指定した `authInfo` を 3 つの track に載せる、設定のトークンが CAT のときだけ載せる
  - event timeline の track にだけ載せないように壊すと、テストが落ちることを確かめた
- 文書: `docs/HIGH_LEVEL_API.md`、`docs/MSF.md`、`CHANGES.md`
- `pnpm test` (3466 テスト)、`pnpm typecheck`、`pnpm lint`、prek が通った
- catalog track 自身は catalog の中に Track Object を持たないため、`authInfo` では示せない。catalog の SUBSCRIBE / FETCH に付けるトークンは、catalog を指す URI の `c4m` (draft-ietf-moq-msf-01 §11.1 の "URL pointing at a catalog and supplying a token for the client") で決まり、本 issue の対象外とした
