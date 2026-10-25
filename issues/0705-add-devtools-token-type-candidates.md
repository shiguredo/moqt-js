# Token Type の入力が自由入力で既知の型を選べない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-token-type-candidates
- Polished: 2026-10-26

## 目的

closed の `0652-bug-devtools-c4m-token-type.md` で Token Type 0x01 (CAT) を送るようになったが、devtools の Token Type は自由入力のテキストのままである。UI に既知の型の候補が無く、label の補足に「(0 = out-of-band / 1 = CAT)」と書いてあるだけである。

存在しない型や greasing 用の値を打ち間違えてもそのまま送信され、relay がその型を解釈できなければ拒否され得る。同じ Authorization Token 節の Alias Type は `<select>` で候補を選ばせており、UI の作りが揃っていない。`0652` の「残した課題」にも候補表示が無いことが挙げられている。

## 現状

- `devtools/src/components/ConnectionSettings.tsx` の Token Type は `<input type="text">` である (`id="authorizationTokenType"`、`data-testid="authorization-token-type"`)。入力は `settings.authorizationTokenType.value` にそのまま入り、c4m から取り込んだ Base64 トークンの解除だけを行う (`settings.discardImportedC4mToken()`)。label の補足は「(0 = out-of-band / 1 = CAT)」である
- Token Value も `<input type="text">` (`data-testid="authorization-token-value"`) で、プレースホルダは「Any token string (UTF-8)」である
- 同じ節の Alias Type は `<select>` で、`USE_VALUE (0x3)` / `REGISTER (0x1)` を選ばせる (option の value は `useValue` / `register`)。Alias Type が `register` のときだけ Token Alias の入力を出す条件分岐もある
- 同画面には複数の `<select>` があり、列挙できる値は `<select>` で選ばせるのが慣例である (Audio Codec は `data-testid="audio-codec"`、Video Codec は `data-testid="video-codec"`)
- `devtools/src/signals/connectionSettings.ts` の `buildAuthorizationToken` は Token Type を 10 進文字列として解釈し、空文字は 0n にし、`safeParseBigInt` が失敗すると `undefined` を返して SETUP の AUTHORIZATION_TOKEN を送出しない。負値・16 進表記・数字の間に空白を含む値は無言で送信されない (前後の空白は `trim` で落ちる)
- `initFromUrl` はクエリパラメータ `authorizationTokenType` の値を検証せずに signal へ入れる (空でない場合だけ設定する)。URL 由来の任意の文字列が表示される
- 登録済みの型: draft-ietf-moq-transport-22 §8.9 は Token Type 0 を「表に無い型であり out-of-band で交渉する」と定め、§16.6 Table 13 の登録は 0x0 (Reserved、仕様は §8.9) と greasing 用の範囲 (`0x7f * N + 0x9D`、§13) だけである。0x01 = CAT は draft-ietf-moq-c4m-01 §7.1 Table 4 が登録し、§7.1.1 が Payload (CBOR エンコードされた CWT として直列化した CAT) を定める。`PRIVACY_PASS_TOKEN` は draft-ietf-moq-privacy-pass-auth-03 §6.1 が登録を要求しているが、コードポイントは TBD である
- `tests/e2e/devtools-authorization-token.spec.ts` は `data-testid="authorization-token-type"` に対して `fill` を使う (`fill("0")` と `fill("2")`)。`<select>` に変えると `fill` では操作できない

## 設計方針

- Token Type を `<select>` と自由入力の併用にする。候補は既知の型 (「out-of-band (0x0)」= `0`、「CAT (0x01)」= `1`) と「その他 (自由入力)」とし、「その他」を選んだときだけテキスト入力を出す。`<select>` には既存の `id="authorizationTokenType"` と `data-testid="authorization-token-type"` を付け、テキスト入力には `data-testid="authorization-token-type-custom"` を付ける。「その他」の option の value は `custom` とする。条件分岐の形は同画面の Token Alias (`authorizationTokenAliasType.value === "register"` のときだけ Token Alias の入力を出す) に合わせる
- `<select>` の値は `authorizationTokenType.value` が候補にあるときはその候補、候補に無いときは「その他」にする。既知の値が入っているときに「その他」を選んだ場合は `authorizationTokenType.value` を空文字にし、テキスト入力を空で出す。既に候補に無い値が入っている場合はその値を保持してテキスト入力に出す。テキスト入力への入力は `authorizationTokenType.value` にそのまま入れ、c4m の取り込みを解除する (`discardImportedC4mToken()`)
- 入力値が候補に無い場合は「その他」を選択した状態でテキスト入力に値を出し、c4m の取り込み (`applyC4mFromUrl` が `"1"` を入れる) と URL クエリ (`initFromUrl` が `authorizationTokenType` を入れる) のどちらの経路でも表示が実値と一致するようにする
- 候補は 1 箇所に定義する。`devtools/src/signals/connectionSettings.ts` に `AUTHORIZATION_TOKEN_TYPES = [{ value: "0", label: "out-of-band (0x0)" }, { value: "1", label: "CAT (0x01)" }] as const` を export して置き、値は 10 進文字列のまま保持する (送信側の `buildAuthorizationToken` は変更しない)
- 候補定数の JSDoc に各候補の根拠を節番号つきで書く。0 は draft-ietf-moq-transport-22 §8.9 (表に無い型 / out-of-band 交渉)、0x01 は c4m-01 §7.1 Table 4 と §7.1.1 (Payload は CBOR エンコードされた CWT)。greasing の範囲 (§16.6 Table 13 / §13) と未登録の `PRIVACY_PASS_TOKEN` (§6.1、コードポイント TBD) は候補にしない
- Token Type が空文字のときは 0n として送られる既存のフォールバックは変えない。候補に「未指定 (空)」は足さない (第一案を採用する)。空文字は「その他」を選んでテキスト入力を空にした場合と、手入力で空にした場合に生じ、送信は既存どおり 0n になる
- c4m 取り込みの解除 (`ConnectionSettings.tsx` の Token Type の編集時の `discardImportedC4mToken()` 呼び出し) と `clearImportedC4mToken` の挙動は変えない。`<select>` の選択 (候補 / 「その他」) でも c4m の Base64 を解除する
- テスト: `data-testid="authorization-token-type"` を維持し、`tests/e2e/devtools-authorization-token.spec.ts` の `fill("0")` を `selectOption("0")` に直す。`fill("2")` は `selectOption("custom")` のあと `data-testid="authorization-token-type-custom"` の入力に `"2"` を入れ、`<select>` が `"custom"`、テキスト入力が `"2"` であることを確認する形に直す。`devtools/src/signals/connectionSettings.test.ts` には候補定数の値 (0 と 1 が含まれ、値が重複しない) のテストを足す
- 対象は `devtools/src/components/ConnectionSettings.tsx` / `devtools/src/signals/connectionSettings.ts` (候補定数の追加のみ) / `devtools/src/signals/connectionSettings.test.ts` / `tests/e2e/devtools-authorization-token.spec.ts` とする。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」(CHANGES.md を更新しない) により変更しない。このルールの見直しは open の `0861-update-changelog-draft-rule.md` で扱う
- 対象外: 既定値の固定 (0704)、c4m の relay 受理の検証 (0703)、Token Value の入力形式 (UTF-8 テキスト / Base64 の切り替え)

## 完了条件

- Token Type で既知の型 (`0` out-of-band / `1` CAT) を候補から選べ、任意の値も入力できる
- c4m の取り込みで `"1"` が入ったとき、URL クエリで `"2"` などの任意の値が入ったときに、表示が実値と一致する (既知の値は `<select>` が該当 option を選び、未知の値は「その他」とテキスト入力になる)
- 選択した値が `buildAuthorizationToken` の `tokenType` に反映される (送信の挙動は変わらない)
- `data-testid="authorization-token-type"` が維持され、`tests/e2e/devtools-authorization-token.spec.ts` が `selectOption` と任意入力の両方で通る。任意入力は `data-testid="authorization-token-type-custom"` で操作できる
- 候補定数の値が `devtools/src/signals/connectionSettings.test.ts` で固定される
- `CHANGES.md` が変更されていない (CODEBASE.md の特別ルール)
- `vp check` / `vp test run` / `vp run e2e-test` が通る

## 参照

- draft-ietf-moq-transport-22 §8.9 (Token Type の意味。Type 0 は表に無い型で out-of-band 交渉) / §13 (Grease) / §16.6 Table 13 (登録済みの型)
- draft-ietf-moq-c4m-01 §7.1 Table 4 (0x01 = CAT) / §7.1.1 (CAT の Payload)
- draft-ietf-moq-privacy-pass-auth-03 §6.1 (MOQT Auth Token Type への登録要求。コードポイントは TBD)
- closed の `0652-bug-devtools-c4m-token-type.md` (「残した課題」に候補表示が無いことが挙げられている)
- `devtools/src/components/ConnectionSettings.tsx` の Alias Type の `<select>` と Token Alias の条件分岐 / `devtools/src/signals/connectionSettings.ts` の `buildAuthorizationToken`
- `tests/e2e/devtools-authorization-token.spec.ts` (Token Type の `fill` を使う既存の e2e)
- open の `0861-update-changelog-draft-rule.md` (CHANGES.md の扱い。本 issue は CODEBASE.md の特別ルールに従う)

## 解決方法

{未着手}
