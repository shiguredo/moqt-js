# Token Type の入力が自由入力で既知の型を選べない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-token-type-candidates
- Polished: 2026-09-24

## 目的

closed の `0652-bug-devtools-c4m-token-type.md` で Token Type 0x01 (CAT) を送るようになったが、devtools の Token Type は自由入力のテキストのままである。既知の型の候補が本文に無く、label の補足に「(0 = out-of-band / 1 = CAT)」と書いてあるだけである。

存在しない型や greasing 用の値を打ち間違えてもそのまま送信され、relay 側で拒否される。同じ Authorization Token 節の Alias Type は `<select>` で候補を選ばせており、UI の作りが揃っていない。`0652` の「残した課題」にも候補表示が無いことが挙げられている。

## 現状

- `devtools/src/components/ConnectionSettings.tsx` の Token Type は `<input type="text">` である (874 行目、`id="authorizationTokenType"` は 876 行目、`data-testid="authorization-token-type"` は 878 行目)。入力は `settings.authorizationTokenType.value` にそのまま入り (879-880 行目)、c4m から取り込んだ Base64 トークンの解除だけを行う (881-884 行目)。label の補足は「(0 = out-of-band / 1 = CAT)」である (870-873 行目、872 行目)
- Token Value も `<input type="text">` (896 行目、`data-testid="authorization-token-value"` は 899 行目) で、プレースホルダは「任意のトークン文字列 (UTF-8)」(911 行目)
- 同じ節の Alias Type は `<select>` で、`USE_VALUE (0x3)` / `REGISTER (0x1)` を選ばせる (837-851 行目、option は 849-850 行目)。Alias Type が `register` のときだけ Token Alias の入力を出す条件分岐もある (853-868 行目)
- 同画面には他に 14 個の `<select>` があり (合計 15 個)、列挙できる値は `<select>` で選ばせるのが慣例である (Codec は 489-501 行目、Audio Codec は 671-689 行目で `data-testid="audio-codec"` は 673 行目)
- `devtools/src/signals/connectionSettings.ts` の `buildAuthorizationToken` (104 行目) は Token Type を 10 進文字列として解釈し、空文字は 0n にし (117-118 行目)、`safeParseBigInt` (173 行目) が失敗すると `undefined` を返して SETUP の AUTHORIZATION_TOKEN を送出しない (119-121 行目)。負値・16 進表記・数字の間に空白を含む値は無言で送信されない (前後の空白は 117 行目の `trim` で落ちる)
- `initFromUrl` (421 行目) はクエリパラメータ `authorizationTokenType` の値を検証せずに signal へ入れる (520-522 行目)。URL 由来の任意の文字列が入力欄に出る
- 登録済みの型: draft-ietf-moq-transport-21 §8.9 は Token Type 0 を「表に無い型であり out-of-band で交渉する」と定め、§16.6 Table 12 の登録は 0x0 (Reserved、仕様は §8.9) と greasing 用の範囲 (`0x7f * N + 0x9D`、§13) だけである。0x01 = CAT は draft-ietf-moq-c4m-01 §7.1 Table 4 が登録し、§7.1.1 が Payload (CBOR エンコードされた CWT として直列化した CAT) を定める。`PRIVACY_PASS_TOKEN` は draft-ietf-moq-privacy-pass-auth-03 §6.1 が登録を要求しているが、コードポイントは TBD である
- `tests/e2e/devtools-authorization-token.spec.ts` は `data-testid="authorization-token-type"` に対して `fill` を使う (29 行目 `fill("0")`、55 行目 `fill("2")`)。`<select>` に変えると `fill` では操作できない

## 設計方針

- Token Type を `<select>` と自由入力の併用にする。候補は既知の型 (「out-of-band (0x0)」= `0`、「CAT (0x01)」= `1`) と「その他 (自由入力)」とし、「その他」を選んだときだけテキスト入力を出す。条件分岐の形は同画面の Token Alias (853-868 行目) に合わせる
- 入力値が候補に無い場合は「その他」を選択した状態でテキスト入力に値を出し、c4m の取り込み (`applyC4mFromUrl` が `"1"` を入れる 166 行目) と URL クエリ (`initFromUrl` 520-522 行目) のどちらの経路でも表示が実値と一致するようにする
- 候補は 1 箇所に定義する。案: `devtools/src/signals/connectionSettings.ts` に `AUTHORIZATION_TOKEN_TYPES = [{ value: "0", label: "out-of-band (0x0)" }, { value: "1", label: "CAT (0x01)" }] as const` を置き、値は 10 進文字列のまま保持する (送信側の `buildAuthorizationToken` は変更しない)
- 各候補の説明は節番号つきで書く。0 は transport-21 §8.9 (表に無い型 / out-of-band 交渉)、0x01 は c4m-01 §7.1 Table 4 と §7.1.1 (Payload は CBOR エンコードされた CWT)。greasing の範囲 (§16.6 Table 12 / §13) と未登録の `PRIVACY_PASS_TOKEN` (§6.1、コードポイント TBD) は候補にしない
- Token Type が空文字のときは 0n として送られる既存のフォールバック (117-118 行目) は変えない。候補に「未指定 (空)」を足すかは実装時に決める (第一案: 足さない。既定は `"0"` であり、空文字は手入力の産物である)
- c4m 取り込みの解除 (881-884 行目) と `clearImportedC4mToken` (313 行目) の挙動は変えない。候補の選択でも c4m の Base64 を解除する
- テスト: `data-testid="authorization-token-type"` を維持し、`tests/e2e/devtools-authorization-token.spec.ts` の `fill` を `selectOption` に直す (29 行目 / 55 行目)。任意の値を入力する経路 (「その他」を選んでテキスト入力) の e2e も足す。`devtools/src/signals/connectionSettings.test.ts` には候補定数の値 (0 と 1 が含まれ、値が重複しない) のテストを足す
- 対象は `devtools/src/components/ConnectionSettings.tsx` / `devtools/src/signals/connectionSettings.ts` (候補定数の追加のみ) / `devtools/src/signals/connectionSettings.test.ts` / `tests/e2e/devtools-authorization-token.spec.ts` / `CHANGES.md` とする (devtools の UI 変更も `## develop` に記録する慣例がある)
- 対象外: 既定値の固定 (0704)、c4m の relay 受理の検証 (0703)、Token Value の入力形式 (UTF-8 テキスト / Base64 の切り替え)

## 完了条件

- Token Type で既知の型 (`0` out-of-band / `1` CAT) を候補から選べ、任意の値も入力できる
- c4m の取り込みで `"1"` が入ったとき、URL クエリで `"2"` などの任意の値が入ったときに、表示が実値と一致する (既知の値は `<select>` が該当 option を選び、未知の値は「その他」とテキスト入力になる)
- 選択した値が `buildAuthorizationToken` の `tokenType` に反映される (送信の挙動は変わらない)
- `data-testid="authorization-token-type"` が維持され、`tests/e2e/devtools-authorization-token.spec.ts` が `selectOption` と任意入力の両方で通る
- 候補定数の値が `devtools/src/signals/connectionSettings.test.ts` で固定される
- `CHANGES.md` の `## develop` に devtools の Token Type 候補の追加が載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-transport-21 §8.9 (Token Type の意味。Type 0 は表に無い型で out-of-band 交渉) / §13 (Grease) / §16.6 Table 12 (登録済みの型)
- draft-ietf-moq-c4m-01 §7.1 Table 4 (0x01 = CAT) / §7.1.1 (CAT の Payload)
- draft-ietf-moq-privacy-pass-auth-03 §6.1 (MOQT Auth Token Type への登録要求。コードポイントは TBD)
- closed の `0652-bug-devtools-c4m-token-type.md` (「残した課題」に候補表示が無いことが挙げられている)
- `devtools/src/components/ConnectionSettings.tsx` の Alias Type の `<select>` と Token Alias の条件分岐 / `devtools/src/signals/connectionSettings.ts` の `buildAuthorizationToken`
- `tests/e2e/devtools-authorization-token.spec.ts` (Token Type の `fill` を使う既存の e2e)

## 解決方法

{未着手}
