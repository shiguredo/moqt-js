# 未登録 Alias の参照を Session Termination の 0x17 UNKNOWN_AUTH_TOKEN_ALIAS に統一する

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/change-unknown-auth-token-alias-scope
- Polished: 2026-09-16

## 目的

draft-ietf-moq-transport-21 §8.9 は「未登録の Alias を参照するメッセージの受信者は UNKNOWN_AUTH_TOKEN_ALIAS でそのメッセージを拒否する MUST」を定める。しかし 0x17 UNKNOWN_AUTH_TOKEN_ALIAS は §16.11.1 (Session Termination Error Codes) にのみ登録され、§16.11.2 (REQUEST_ERROR Codes) には登録されていない。

現状は REQUEST_ERROR として 0x17 を送っており、これには 2 つの問題がある。

- §13 の「Receipt of an unknown error code in any error context (Session Termination, REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST be treated as equivalent to INTERNAL_ERROR for that context.」により、ピア側で INTERNAL_ERROR に読み替えられる。§8.9 が伝えようとした「未登録 Alias」という理由が失われ、アプリが認証トークンの問題を判別できない
- 同じ §13 が続けて「An endpoint MUST NOT close the session because it received an unknown error code in a REQUEST_ERROR or PUBLISH_DONE.」と定める。REQUEST_ERROR で送る限り、ピアはこの MUST NOT に従ってセッションを閉じてはならない。つまり「理由を伝える」ことも「セッションエラーとして扱ってもらう」ことも、どちらも仕様上できていない

本 issue は 0x17 の扱いを **Session Termination に統一する** ことに確定した内容を実装可能な形で固定する。

## 現状

- `src/error.ts` の `RequestErrorCode` に `UNKNOWN_AUTH_TOKEN_ALIAS: 0x17` を定義し、`SessionErrorCode` にも同じ 0x17 を定義している
- `src/error.ts` の `normalizeRequestErrorCode` は受理集合を `RequestErrorCode` の値から組み立てるため、REQUEST_ERROR 文脈の 0x17 を独自コードとして温存する
- 0x17 を REQUEST_ERROR として送る箇所は次の 2 箇所である
  - `src/session.ts` の `processIncomingPublishAuthorizationTokens` が `incomingSendRequestErrorAndClose` で送る (受信 PUBLISH 経路)
  - `src/session/bidi.ts` の `processIncomingRequestUpdateAuthorizationTokens` が `bidiSendRequestError` で送る (REQUEST_UPDATE 経路)。このヘルパーは `bidiHandlePublishRequestUpdate` と `bidiPreflightRequestUpdate` の 2 箇所から呼ばれ、送信側は同じ 1 箇所に集約されている
- REQUEST_UPDATE の受信経路は 3 つあり、いずれもこのヘルパーを通る
  - `bidiHandlePublishRequestUpdate` (受信 PUBLISH ストリーム上の REQUEST_UPDATE)。moqt-js は受信 PUBLISH の subscriber だが、REQUEST_UPDATE を送ったのは moqt-js であり、REQUEST_UPDATE の文脈では moqt-js が publisher である
  - `bidiPreflightRequestUpdate` の publish ロール分岐。`bidiReadRequestStreamMessages` が `role: "publish"` で呼ぶ
  - `bidiPreflightRequestUpdate` の subscribe ロール分岐。`bidiReadRequestStreamMessages` が `role: "subscribe"` で呼ぶ
- §9.5.1 の PUBLISH_DONE (UPDATE_FAILED) を併送するのは `bidiHandlePublishRequestUpdate` と `bidiPreflightRequestUpdate` の publish ロール分岐の `unknown-alias` 処理だけである。`bidiPreflightRequestUpdate` の subscribe ロール分岐は moqt-js が subscriber であり §9.5.1 の publisher MUST の対象外であるため、REQUEST_ERROR のみを送る
- `src/error.ts` の `RequestErrorCode` のコメントは「§12.3 (Request Error Codes) の登録表には 0x17 が収載されていない」「§13 (Grease) により、§12.3 の登録表に無いコードを受信したピアは INTERNAL_ERROR として扱う MUST があるため、本コードはピア側で UNKNOWN_AUTH_TOKEN_ALIAS として認識されない可能性がある (相互運用上の帰結)」「受理集合にも含まれるため、ピアから 0x17 を受信した場合は本コードとして解釈する」と、相互運用上の帰結を認識している

draft-ietf-moq-transport-21 §8.9:

> The receiver of a message referencing an Alias that is not currently registered MUST reject the message with UNKNOWN_AUTH_TOKEN_ALIAS.

draft-ietf-moq-transport-21 §13:

> Receipt of an unknown error code in any error context (Session Termination, REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST be treated as equivalent to INTERNAL_ERROR for that context. An endpoint MUST NOT close the session because it received an unknown error code in a REQUEST_ERROR or PUBLISH_DONE.

## 設計方針

### 0x17 は Session Termination に統一する

送信側は、未登録 Alias を参照するメッセージを受信したら REQUEST_ERROR ではなく Session Termination の `UNKNOWN_AUTH_TOKEN_ALIAS` (0x17) でセッションを閉じる。受信側は `normalizeRequestErrorCode` の受理集合から 0x17 を外し、REQUEST_ERROR 文脈の 0x17 は未登録コードとして §13 に従い INTERNAL_ERROR に正規化する。

### 確定の根拠

- §8.9 は「未登録 Alias を参照するメッセージを UNKNOWN_AUTH_TOKEN_ALIAS で拒否する MUST」を定める。この MUST はコード値のみを指定しており、どのエラー文脈で送るかは指定していない
- §6.6 は「An endpoint MAY choose to treat a subscription or request specific error as a session error under certain circumstances, closing the entire session in response to a condition with a single subscription or message.」と定め、リクエスト固有のエラーをセッションエラーとして扱うことを明示的に許容している。REQUEST_UPDATE / PUBLISH というリクエスト単位の検出をセッション終了で扱うことは、この MAY の範囲にある
- 0x17 は §16.11.1 (Session Termination Error Codes) に登録され、§12.2 が「No registered token found for the provided Alias (see Section 8.9)」と定義する。Session Termination として送れば、ピアは登録済みコードとしてそのまま受理する。§12.2 の前文も「When terminating the Session (Section 6.6), the application MAY use any error message and SHOULD use a relevant code」と定めるため、0x17 はセッション終了時に SHOULD に沿うコードでもある
- 0x17 は §16.11.2 (REQUEST_ERROR Codes) に登録されていない。REQUEST_ERROR として送ると §13 の MUST によりピアは INTERNAL_ERROR と等価に扱うため、§8.9 が伝えようとした「未登録 Alias」という理由が失われる。§8.9 の MUST の意図を実際に伝えられるのは Session Termination 側だけである
- したがって両案は「§8.9 の MUST を満たすか」では差が付かず、「§8.9 の MUST が伝えようとした理由をピアへ伝えられるか」で Session Termination が優る
- 同じ draft-21 を実装する moqt-rs も 0x17 を Session Termination としてのみ持ち、未登録 Alias の参照でセッションを閉じる。sora-moq も 0x17 を Session Termination のコードとして扱う方針である。詳細は「他実装との解釈合わせ」を参照

### セッション終了時に送らない応答

セッションを閉じる場合、次の 2 つの MUST が定める応答は送らない。これは §6.6 の MAY に基づく意図的な選択である。§6.6 は続けて「Implementations need to consider the impact on other outstanding subscriptions before making this choice.」と留保するが、0x17 はトークンキャッシュがセッション単位の状態であり、未登録 Alias の参照はセッションの前提が崩れていることを意味するため、他購読への影響を許容してセッション終了を選ぶ。

- §9.5「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message indicating if the update was successful, unless it is coalescing failed updates to produce just one REQUEST_ERROR for multiple REQUEST_UPDATE messages.」の REQUEST_OK / REQUEST_ERROR を送らない。セッションを閉じるため、この応答を送っても解釈されない。この MUST は REQUEST_UPDATE を受信する両ロールに等しくかかるため、publish ロールと subscribe ロールの両方が対象外となる
- §9.5.1「When a REQUEST_UPDATE is unsuccessful, the publisher MUST also terminate the subscription by sending a PUBLISH_DONE with error code UPDATE_FAILED.」の PUBLISH_DONE (UPDATE_FAILED) を送らない。セッションが閉じるため購読はセッションとともに終了し、購読単位の終了通知は不要である。この MUST は publisher が負うものであり、現行で該当するのは `bidiPreflightRequestUpdate` の publish ロール分岐だけである。`bidiHandlePublishRequestUpdate` は元から PUBLISH_DONE を送らず、`bidiPreflightRequestUpdate` の subscribe ロール分岐も対象外である

§6.6 の原文は次のとおりである。MAY はすべて大文字であり §1.3 の「when, and only when, they appear in all capitals」の条件を満たす規範語である。後半の「need to」は大文字ではないため BCP 14 の規範語ではないが、この選択を行う前に他購読への影響を検討することを求めた留保であり、判断の根拠として扱う。

> An endpoint MAY choose to treat a subscription or request specific error as a session error under certain circumstances, closing the entire session in response to a condition with a single subscription or message. Implementations need to consider the impact on other outstanding subscriptions before making this choice.

このため実装では次を守る。

- 0x17 の送信は `closeWithError(new SessionError(..., SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS))` に一本化し、REQUEST_ERROR を併送しない
- `bidiTerminatePublishSubscriptionWithUpdateFailed` による PUBLISH_DONE (UPDATE_FAILED) も送らない
- 決定理由をコードコメントに残す。とくに「セッション終了を選んだため §9.5 の応答 MUST と §9.5.1 の PUBLISH_DONE MUST の対象外とした」ことと、§6.6 の MAY と留保をどう判断したかを明記する

### §13 の MUST NOT との整合

§13 は未知のエラーコードの扱いを 2 文で定める。1 文目は「未知のエラーコードはその文脈における INTERNAL_ERROR と等価に扱う MUST」、2 文目は「エンドポイントは REQUEST_ERROR または PUBLISH_DONE で未知のエラーコードを受信したことを理由にセッションを閉じてはならない MUST NOT」である。

> Receipt of an unknown error code in any error context (Session Termination, REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST be treated as equivalent to INTERNAL_ERROR for that context. An endpoint MUST NOT close the session because it received an unknown error code in a REQUEST_ERROR or PUBLISH_DONE.

したがって REQUEST_ERROR 文脈の 0x17 は、ピアにとって「INTERNAL_ERROR と等価な未知コード」でしかなく、しかもピアはそれを理由にセッションを閉じることができない。現状の送信は、§8.9 の MUST が伝えようとした理由をピアに届けないまま、ピアが回復動作を取ることもできない状態にしている。本 issue はこの 2 文目に触れないよう、0x17 を Session Termination 文脈へ移す。

この変更により、REQUEST_ERROR 文脈の 0x17 は本実装でも未知コードとして扱う。`normalizeRequestErrorCode` は §13 の 1 文目に従い INTERNAL_ERROR へ正規化する。

### 他実装との解釈合わせ

同じ draft-21 を実装する moqt-rs は、未登録 Alias の参照を Session Termination として扱っている。moqt-rs の `src/error.rs` は 0x17 を `SESSION_UNKNOWN_AUTH_TOKEN_ALIAS` として Session Termination Codes の並びにのみ定義し、REQUEST_ERROR Codes の並びには 0x17 に相当する定数を持たない。`src/session/core.rs` の `apply_peer_message_auth_tokens` は USE_ALIAS の解決に失敗したとき `SESSION_UNKNOWN_AUTH_TOKEN_ALIAS` の `SessionError` を返し、`self.fail` でセッションを閉じる。この経路は SUBSCRIBE / PUBLISH / REQUEST_UPDATE の各受信ハンドラ (`src/session/subscription/recv.rs`) と FETCH の受信ハンドラ (`src/session/fetch.rs`) から同じ形で呼ばれ、REQUEST_UPDATE でも REQUEST_ERROR を返さずにセッションを閉じる。

sora-moq は 0x17 を Session Termination のコードとして定義し、未登録 Alias を Session Termination とする方針を issue に明記している。トークンキャッシュの実装は未着手であり、この一致は実装済みの挙動ではなく解釈と方針の一致である。

本 issue が確定する「0x17 は Session Termination」「REQUEST_ERROR 文脈の 0x17 は未知コードとして INTERNAL_ERROR に正規化」「セッション終了時は PUBLISH_DONE (UPDATE_FAILED) を送らない」は、これらの解釈と一致する。

### §9.1.4 の MUST NOT との非干渉

§9.1.4 は「SETUP の AUTHORIZATION TOKEN で MAX_AUTH_TOKEN_CACHE_SIZE を超える REGISTER を受信した場合、AUTH_TOKEN_CACHE_OVERFLOW でセッションを失敗させてはならず (MUST NOT)、USE_VALUE として扱う MUST」を定める。§8.9 も「上限を超える登録を試みられた場合は AUTH_TOKEN_CACHE_OVERFLOW でセッションを終了する MUST」と定め、両者は登録の成否の扱いを定めている。

これらの規則が対象とするのは REGISTER の失敗であり、本 issue が変更するのは未登録 Alias の **参照** の扱いである。REGISTER の上限超過は現状どおり SETUP 経路が USE_VALUE、メッセージパラメータ経路が AUTH_TOKEN_CACHE_OVERFLOW のまま変更しない。したがって §9.1.4 の MUST NOT に抵触しない。

## 変更対象

### `src/error.ts`

- `RequestErrorCode` から `UNKNOWN_AUTH_TOKEN_ALIAS: 0x17` とそのコメントを削除する
- `SessionErrorCode` の `UNKNOWN_AUTH_TOKEN_ALIAS: 0x17` は維持する
- `normalizeRequestErrorCode` は受理集合を `RequestErrorCode` の値から組み立てているため、0x17 を削除すると REQUEST_ERROR 文脈の 0x17 が自動的に INTERNAL_ERROR へ正規化される。実装の変更は不要だが、この帰結をコメントに残す

### `src/session/bidi.ts`

- `processIncomingRequestUpdateAuthorizationTokens` の `bidiSendRequestError(RequestErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS, ...)` を `session.closeWithError(new SessionError(..., SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS))` に置き換える。この 1 箇所の変更で REQUEST_UPDATE の 3 経路すべてが Session Termination になる
- 同関数の戻り値を `Promise<"ok" | "unknown-alias" | "closed">` から `Promise<"ok" | "closed">` に整理する。現行は「REQUEST_ERROR を送った (unknown-alias)」と「セッションを閉じた (closed)」を区別しているが、変更後はどちらもセッションを閉じるため区別が不要になる
- 同関数の JSDoc にある「未登録 Alias の参照は REQUEST_ERROR (UNKNOWN_AUTH_TOKEN_ALIAS) でメッセージを拒否する」と `@returns` の「unknown-alias (REQUEST_ERROR 送信済み)」を Session Termination に更新する
- `bidiPreflightRequestUpdate` の `authResult !== "ok"` 分岐から `bidiTerminatePublishSubscriptionWithUpdateFailed` の呼び出しを削除する
- 同分岐の「§9.5.1 の MUST に従い PUBLISH_DONE (UPDATE_FAILED) で購読を終了する」というコメントを、セッション終了のため PUBLISH_DONE を送らない理由のコメントに置き換える。この分岐は publish ロールと subscribe ロールの共通コードであるため、publish ロールでは §9.5.1 の MUST をセッション終了で対象外にしたこと、subscribe ロールでは元から対象外であることを書き分ける
- `bidiHandlePublishRequestUpdate` の AUTHORIZATION TOKEN 処理ブロックは、戻り値が `"ok"` 以外なら早期 return する現行構造のままでよい。変更後は `"ok"` 以外が `"closed"` だけになるため、`"closed"` のときはセッションが閉じているので読み取りを終える、という記述に置き換える。現行コメントの「本経路 (ケース 1) の moqt-js は受信 PUBLISH の subscriber であり、§3.1 / §9.5.1 の PUBLISH_DONE は publisher が送る。拒否は REQUEST_ERROR のみとし、購読の終了は publisher (ピア) に委ねる」は、受信ストリーム上のロールと REQUEST_UPDATE のロールが混ざった記述なので、REQUEST_UPDATE の文脈では moqt-js が publisher であることを踏まえて書き直す
- `bidiPreflightRequestUpdate` の subscribe ロール分岐は元から PUBLISH_DONE を送らないため、削除する呼び出しは無い。コメントのみ Session Termination に合わせる
- `bidiHandlePublishRequestUpdate` を書き直すときは、`src/session.ts` の受信 PUBLISH ループにある同関数の呼び出し元コメント (「受信 PUBLISH の publisher (ピア) による REQUEST_UPDATE を処理し」) も同じ混同を含む。同じ「受信ストリーム上のロールと REQUEST_UPDATE のロールの混ざり」なので、あわせて読み直す。なお本経路が PUBLISH_DONE を送らないのは現行からの挙動であり、セッション終了を選んだことによる変更ではない

### `src/session.ts`

- `processIncomingPublishAuthorizationTokens` の `incomingSendRequestErrorAndClose(RequestErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS, ...)` を `this.closeWithError(new SessionError(..., SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS))` に置き換える
- メソッドの docstring にある「未登録 Alias の参照は REQUEST_ERROR (UNKNOWN_AUTH_TOKEN_ALIAS) でメッセージを拒否する」を Session Termination に更新する
- 同メソッドの `@returns` は「処理を継続してよい場合は true、拒否・セッション終了で中断すべき場合は false」のまま維持できるが、「拒否」は未登録 Alias 以外の経路 (未登録トラック等) を指すようになるため、未登録 Alias はセッション終了であることをコメントに明記する

### `CHANGES.md`

- `## develop` の「受信 AUTHORIZATION TOKEN のデコードとトークンキャッシュを実装する」エントリの「未登録 Alias の参照は REQUEST_ERROR (UNKNOWN_AUTH_TOKEN_ALIAS) で扱う」は本 issue の変更で誤りになるため、Session Termination の UNKNOWN_AUTH_TOKEN_ALIAS でセッションを閉じる記述に書き換える
- `RequestErrorCode` の 0x17 は未リリースである (リリース済みの 2026.2.0 では 0x17 は `SessionErrorCode` にのみ存在する)。`shiguredo-changelog` の「変更履歴は派生元ブランチとの最終的な差分のみを記載すること」に従えば、リリース済み版との差分は追加だけであるため、エントリの種別は `[ADD]` のままでよい
- `shiguredo-changelog` の「未リリースの変更は `## develop` セクションに追記すること」に従い、中間状態のエントリを積まず、未リリースの既存エントリの記述と整合させる

### `src/session/authTokenCache.ts`

- `AuthTokenProcessResult` の型 `{ status: "ok" } | { status: "unknown-alias" }` は維持する。未登録 Alias の検出はキャッシュ層の責務であり、セッションを閉じるかどうかは呼び出し元が決めるため、`status` の意味だけを「メッセージを拒否すべき」から「セッションを閉じるべき」に更新する
- `AuthTokenProcessResult` の `unknown-alias` の説明「未登録 Alias を参照する USE_ALIAS があり、メッセージを拒否すべき」を、呼び出し元がセッションを閉じるべきことを表す記述に更新する
- `processMessageAuthorizationToken` (単数、内部関数) の docstring「未登録 Alias の参照はセッションを閉じず、当該メッセージを REQUEST_ERROR (UNKNOWN_AUTH_TOKEN_ALIAS) で拒否する」を Session Termination に更新する。セッションを閉じるのは呼び出し元であり、本関数は `unknown-alias` を返して判断を委ねる形を維持する
- `processMessageAuthorizationTokens` (複数、公開関数) の docstring は既に §8.9 の「An Authorization Token MAY be repeated within a message as long as the combination of Token Type and Token Value are unique after resolving any aliases.」を根拠に、全パラメータを順に処理することを述べている。変更後も `unknown-alias` を受け取った時点で打ち切らず、最初の非 `ok` を結果として返す現行挙動を変えない。コメントの理由付けは「USE_ALIAS の解決に失敗しても、同じメッセージ内でそれより後ろにある REGISTER を処理し続ける」に限定する。§8.9 の REGISTER 登録 MUST は「セッションエラーにならないメッセージ」を対象とするため、未登録 Alias を参照するメッセージは同 MUST の対象外であり、同 MUST が本関数の継続処理の根拠になるわけではない (benign な拒否経路の REGISTER 反映は別の責務である)

### `src/index.ts`

- 変更しない。`RequestErrorCode` を再公開しているため、`RequestErrorCode` からの 0x17 削除は公開 API のメンバー削除になるが、0x17 は未リリースのため `CHANGES.md` のエントリ種別は `[ADD]` のままとする

### テスト

現行で 0x17 の REQUEST_ERROR 受理を前提にしている既存テストは次の 3 件である (`RequestErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS` を検証するアサーションはリポジトリ全体でこの 3 箇所だけである)。すべて Session Termination 0x17 の期待に更新する。

- `src/session.test.ts` の「受信 PUBLISH: 未登録 Alias の USE_ALIAS は REQUEST_ERROR (UNKNOWN_AUTH_TOKEN_ALIAS) で拒否する」(6701 行目のアサーション)。REQUEST_ERROR のワイヤ検証 (`ctx.written` に 1 通だけ REQUEST_ERROR が入る検証) を、`ctx.errors` に `SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS` の `SessionError` が入り `ctx.session.state` が closed になる検証へ置き換える。`createPublishAuthTokenContext` は `createSessionImpl` に error コールバックを渡し、その記録先が `ctx.errors` であるため、`ctx.errors` を検証すること (同じ形の検証は AUTH_TOKEN_CACHE_OVERFLOW のテストが既に使っている)
- `src/session.test.ts` の「受信 PUBLISH: 同一メッセージ内の DELETE で退役した Alias への USE_ALIAS は REQUEST_ERROR で拒否する」(6776 行目のアサーション)。このテストも `createPublishAuthTokenContext(1024)` を使うため、同じく `ctx.errors` と `ctx.session.state` の Session Termination 検証へ置き換える。あわせて「§8.9: 未登録 Alias の参照ではセッションを閉じない」というコメントと `ctx.session.state === "connected"` の検証 (6778 行目付近) を更新する
- `src/session/bidiHandlePublishRequestUpdate.test.ts` の「bidiHandlePublishRequestUpdate: 未登録 Alias の USE_ALIAS は REQUEST_ERROR (UNKNOWN_AUTH_TOKEN_ALIAS) で拒否する」(544 行目のアサーション)。このテストは `bidiHandlePublishRequestUpdate` を直接呼ぶ経路であり、REQUEST_UPDATE の文脈では moqt-js が publisher である。REQUEST_ERROR のワイヤ検証を `closedWithError` の検証へ置き換え、`ctx.closedWithError` (getter) が `SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS` の `SessionError` になることを検証する。あわせて `ctx.written` に REQUEST_ERROR も PUBLISH_DONE も書かれないことを検証する (本経路は現行も PUBLISH_DONE を送らない)。テスト直前のヘッダコメント (516-519 行目) の「セッションは閉じない MUST を検証する (§9.5.1 により PUBLISH_DONE も送られる)」と、545 行目の「§8.9: 未登録 Alias の参照ではセッションを閉じない」は publish ロールの Session Termination に書き直す。546 行目の `assert.isUndefined(ctx.closedWithError)` は閉じることを検証する形に変える

あわせて次を追加・更新する。

- `src/error.test.ts` の `normalizeRequestErrorCode` のテスト群に、REQUEST_ERROR 文脈の 0x17 が INTERNAL_ERROR に正規化される検証を追加する (新規。現行の `src/error.test.ts` に 0x17 を扱うテストは存在しない)
- `src/session/authTokenCache.test.ts` の「未登録 Alias の USE_ALIAS は unknown-alias を返しセッションは閉じない」はキャッシュ層の戻り値だけを検証しており、送信側の変更と矛盾しない。テスト名と 407 行目のコメントを、キャッシュ層が「セッションを閉じるべき状態」を返すという記述に更新する
- `bidiPreflightRequestUpdate` の publish ロール分岐 (既存テストは `src/session/bidiPublishRequestUpdateConditions.test.ts` が `bidiReadRequestStreamMessages` を `role: "publish"` で駆動している) で未登録 Alias を参照したときに、REQUEST_ERROR と PUBLISH_DONE (UPDATE_FAILED) のどちらも送られず、`SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS` でセッションが閉じる検証を追加する。現行はこの経路の未登録 Alias を検証するテストが無く、`bidiTerminatePublishSubscriptionWithUpdateFailed` の呼び出しを削除したことを裏付けるテストが存在しない

## 完了条件

- `RequestErrorCode` に 0x17 が存在せず、`SessionErrorCode` に 0x17 が存在する
- REQUEST_ERROR 文脈の 0x17 を `normalizeRequestErrorCode` に渡すと `RequestErrorCode.INTERNAL_ERROR` が返る
- 未登録 Alias を参照する PUBLISH / REQUEST_UPDATE の受信で、REQUEST_ERROR が送られず、`SessionErrorCode.UNKNOWN_AUTH_TOKEN_ALIAS` の Session Termination でセッションが閉じる
- 0x17 を送る 3 経路 (受信 PUBLISH / `bidiHandlePublishRequestUpdate` の REQUEST_UPDATE / `bidiPreflightRequestUpdate` の REQUEST_UPDATE) のすべてが Session Termination になる。`bidiPreflightRequestUpdate` は publish ロールと subscribe ロールの両方で同じ分岐を通る
- 上記を検証するテストが存在し、REQUEST_ERROR を期待する既存テストが残っていない。3 経路のうち `bidiPreflightRequestUpdate` の経路は現行テストが無いため新規に追加する
- 決定理由 (§8.9 の MUST / §6.6 の MAY と留保 / §13 の MUST と MUST NOT / §12.2 の SHOULD / §9.5 の応答 MUST と §9.5.1 の PUBLISH_DONE MUST をセッション終了のために対象外としたこと / §9.1.4 の MUST NOT に抵触しないこと) がコードコメントに残る。§9.5.1 については、PUBLISH_DONE MUST がかかるのは publish ロール (moqt-js が publisher) であり、subscribe ロール (moqt-js が subscriber) は元から対象外であることを書き分ける
- 他実装 (moqt-rs / sora-moq) と同じく、0x17 が Session Termination のコードとしてのみ存在する
- `src/error.ts` / `src/session/bidi.ts` / `src/session.ts` / `src/session/authTokenCache.ts` の該当 docstring とコメントに、REQUEST_ERROR で拒否する旧挙動の記述が残っていない
- `CHANGES.md` の `## develop` の既存エントリの記述が Session Termination に更新される
- `vp check` / `tsc --noEmit` / `vp test run` が通る

issue のカテゴリは `change` のままとする。`Branch:` も `feature/change-` のままとする。これは挙動 (REQUEST_ERROR を送るか Session Termination を送るか) の変更であり、issue のカテゴリと `CHANGES.md` のエントリ種別 (`[ADD]`) は別の軸である。0x17 が未リリースであるため `CHANGES.md` のエントリ種別は `[ADD]` のままとなる。

## 参照

- draft-ietf-moq-transport-21 §1.3 (Terms and Definitions)
- draft-ietf-moq-transport-21 §6.6 (Termination)
- draft-ietf-moq-transport-21 §8.9 (Authorization Token Compression)
- draft-ietf-moq-transport-21 §9.1.4 (AUTHORIZATION TOKEN)
- draft-ietf-moq-transport-21 §9.4 (REQUEST_ERROR)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.5.1 (Updating Subscriptions)
- draft-ietf-moq-transport-21 §12.2 (Session Termination Codes)
- draft-ietf-moq-transport-21 §12.3 (Request Error Codes)
- draft-ietf-moq-transport-21 §13 (Grease)
- draft-ietf-moq-transport-21 §16.11.1 (Session Termination Error Codes)
- draft-ietf-moq-transport-21 §16.11.2 (REQUEST_ERROR Codes)

## 他実装の解釈

Issue を磨き上げる根拠として確認した他実装の解釈を記録する。実装着手時にこの節を参照し、判断が変わっていないか確認すること。

- moqt-rs: `SESSION_UNKNOWN_AUTH_TOKEN_ALIAS` (0x17) を Session Termination のコードとしてのみ定義し、REQUEST_ERROR 側に 0x17 を持たない。未登録 Alias の USE_ALIAS を検出するとセッションを閉じ、REQUEST_ERROR は返さない。SUBSCRIBE / PUBLISH / FETCH / REQUEST_UPDATE の各受信経路で同じ扱いをする
- sora-moq: 0x17 を Session Termination のコードとして定義し、未登録 Alias を Session Termination とする方針を issue に明記する。トークンキャッシュの実装は未着手

いずれも本 issue の「0x17 は Session Termination に統一する」と一致する。実装では、この解釈に合わせて `RequestErrorCode` から 0x17 を削除する。
