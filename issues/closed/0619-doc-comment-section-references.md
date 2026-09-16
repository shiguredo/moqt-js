# コメントの節番号と引用のずれを修正する

- Created: 2026-09-15
- Completed: 2026-09-17
- Branch: feature/fix-comment-section-references
- Polished: 2026-09-15

## 目的

draft-ietf-moq-transport-21 への移行後に、コメントの節番号と引用が一次資料とずれている箇所が残っている。引用の誤りは後続の設計判断やレビューを誤らせるため、まとめて修正する。挙動の変更は行わない。

## 現状

対象は次の 8 件に限る。いずれもコメントのみの問題で、コードとテストの期待値は変えない。

- Track Namespace のフィールド数上限 32 の根拠として §9.15 (SUBSCRIBE_NAMESPACE) を引用している。`MAX_TRACK_NAMESPACE_FIELDS` の doc コメントと `decodeTrackNamespace` 内のコメントの 2 箇所 (`src/message/parameter/trackNamespace.ts`)。上限は §8.7 (Track Namespace Structure) に規定がある。§9.15 の MUST は SUBSCRIBE_NAMESPACE の Track Namespace Prefix 固有であり、Track Namespace 構造そのものを扱う `decodeTrackNamespace` の根拠には使わない。現行の引用文は §9.15 の逐語 ("Track Namespace Prefix") であるため、節番号だけを §8.7 に変えると逐語と一致しない。引用文ごと §8.7 の逐語 ("Track Namespace") に差し替える。同ファイルの `encodeTrackNamespace` は既に §8.7 を引用しており、修正対象はこの 2 箇所だけ
- FETCH のパラメータ構築で SUBSCRIBER_PRIORITY を §9.20.9、GROUP_ORDER を §9.20.19 と記載している。`buildFetchParameters` の 2 箇所 (`src/session/params.ts`)。正しくは §9.20.8 (SUBSCRIBER PRIORITY Parameter) と §9.20.9 (GROUP ORDER Parameter)。同ファイルの `buildFillParameters` / `buildSubscribeParameters` / `buildSubscribeTracksParameters` は既に正しい節番号であり、修正対象は `buildFetchParameters` だけ。この 2 箇所の引用文は節の逐語の途中で閉じているため、節番号の修正とあわせて逐語の末尾 ("(for a subscription or FETCH)" / ", or inside a FILL_PARAMETERS parameter (see Section 9.20.16)") まで含める
- PUBLISH_DONE の MUST を §9.8 として引用している。`bidiReadRequestStreamMessages` (`src/session/bidi.ts`)。この MUST は §9.9 (PUBLISH_DONE) にある。§9.8 は PUBLISH であり、この記述を含まない。引用文自体は §9.9 の逐語と一致しているため、節番号のみを直す
- SETUP の DELETE / USE_ALIAS 禁止を §9.20.3 として引用しているテストコメントがある。`Setup: SETUP で DELETE の Authorization Token を指定すると throw` と `Setup: SETUP で USE_ALIAS の Authorization Token を指定すると throw` の直前のコメント (`src/message/setup.test.ts`)。正しくは §9.1.4 (AUTHORIZATION TOKEN)。§9.20.3 (AUTHORIZATION TOKEN Parameter) はこの禁止を定めない。同じ禁止を `src/session/authTokenCache.test.ts` は §9.1.4 として引用している。引用文自体は §9.1.4 の逐語と一致しているため、節番号のみを直す
- TRACK_STATUS のコメントが §9.13 の例示と異なるパラメータ名を挙げている。モジュールコメントと `TrackStatus` インターフェースの doc コメント (`src/message/trackstatus.ts`)。§9.13 (TRACK_STATUS) が名指しするのは SUBSCRIBER_PRIORITY であり、OBJECT_DELIVERY_TIMEOUT と DEFAULT_PUBLISHER_PRIORITY は挙げていない。DEFAULT_PUBLISHER_PRIORITY は Message Parameter ではなく Track Property (§10.4、Property Type 0x0E) であり、Subscriber が送るパラメータとして列挙できない。§9.13 の逐語を引く形に書き直し、この 2 名の列挙は削除する。LARGEST_OBJECT の記述は §9.20.18 (LARGEST OBJECT Parameter) を根拠として明記する。応答メッセージ名は §9.3 (REQUEST_OK) の shorthand として TRACK_STATUS_OK とも書くため、REQUEST_OK のままでよい
- namespace ループのコメントが「§9.14 に先頭メッセージ MUST が無い」と述べており、Table 5 と §6.3 の First 指定と矛盾する。`namespaceValidateFirstMessage` の doc コメント、`NamespaceLoopHandlers.validateFirstMessage` のコメント、`createPublicationStreamHandlers` のコメントの 3 箇所 (`src/session/namespaceLoops.ts`)。PUBLISH_NAMESPACE は Table 5 で "Request, First" とされ、Table 5 の説明文が First の MUST を定め、§6.3 が双方向ストリームの先頭メッセージを MUST で規定する。§9.14 に無いのは応答側の先頭メッセージに関する MUST であり、応答側の先頭メッセージ MUST は §9.15 と §9.18 にある。応答側の先頭メッセージに関する MUST が無い、という趣旨に書き直す
- LOCATION_FILTER の Length の根拠として §8.3 の偶数 / 奇数規則を持ち込んでいる。`encodeLocationFilterParameter` の「Parameter Type: 0x21 (奇数なので Length プレフィックス付き)」(`src/message/parameter/locationFilter.ts`)。`locationFilter.ts` に §8.3 の明文参照は無く、同ファイルで §8.3 の偶数 / 奇数規則を Length の根拠に持ち込んでいるのはこの「奇数なので」の 1 箇所。この Length は §9.20.10 (LOCATION FILTER Parameter) が構造として定めるフィールドであり、§8.3 の偶数 / 奇数規則は Message Parameter には適用されない (`src/message/parameter/messageParameter.ts` に同じ趣旨の記述がある)。「奇数なので」を削除し、§9.20.10 の構造由来であることを書く。Length の有無そのものは変えない
- Object Datagram と Subgroup Header のコメントが draft-21 に存在しない型表を提示している。`DatagramType` の doc コメント (`src/dataStream/datagram.ts`) は Figure 24 に、`SubgroupHeaderType` の doc コメント (`src/dataStream/subgroup.ts`) は §11.3.1 に帰属させている。§11.2.1 (Object Datagram) と §11.3.1 (Subgroup Header) は Type Flags のビット定義で型を説明し、Figure 24 は OBJECT_DATAGRAM、Figure 25 は SUBGROUP_HEADER のワイヤ構造図で、型表は無い。あわせて `encodeObjectFields` / `decodeObjectFields` とモジュールコメントが Object fields を Figure 25 に帰属させているが、Object fields は Figure 26 (MOQT Subgroup Object Fields) である

修正で書く逐語と、修正の根拠として引く逐語 (`refs/moq/draft-ietf-moq-transport-21.txt`):

以下は各節の逐語である。コメントに書くものと、コメントには書かず現行コメントの引用の一致確認や削除する記述の根拠として使うものを含む。どちらかは「現状」の各項の指示に従い、見出しに「コメントには書かない」と付けた逐語はコメントへ書かない。

§8.7 (Track Namespace Structure):

> If an endpoint receives a Track Namespace consisting of greater than 32 Track Namespace Fields, it MUST close the session with a PROTOCOL_VIOLATION.

§9.20.8 (SUBSCRIBER PRIORITY Parameter):

> The SUBSCRIBER_PRIORITY parameter (Parameter Type 0x20) is a uint8. It MAY appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE (for a subscription or FETCH).

§9.20.9 (GROUP ORDER Parameter):

> The GROUP_ORDER parameter (Parameter Type 0x22) is a uint8. It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH, or inside a FILL_PARAMETERS parameter (see Section 9.20.16).

§9.9 (PUBLISH_DONE) — コメントには書かない (節番号のみを直す。現行の引用文は §9.9 の逐語と一致している):

> A sender MUST NOT destroy subscription state until it sends PUBLISH_DONE, though it can choose to stop sending objects (and thus send PUBLISH_DONE) for any reason.

§9.1.4 (AUTHORIZATION TOKEN) — コメントには書かない (節番号のみを直す。現行の引用文は §9.1.4 の逐語と一致している):

> If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a SETUP message, it MUST close the session with a PROTOCOL_VIOLATION.

§9.13 (TRACK_STATUS):

> The TRACK_STATUS message format is identical to the SUBSCRIBE message (Section 9.6), but subscriber parameters related to Track delivery (e.g. SUBSCRIBER_PRIORITY) are not included.

> If successful, the publisher responds with a TRACK_STATUS_OK with the same parameters and Track Properties it would have set in a SUBSCRIBE_OK.

§9.3 (REQUEST_OK) — コメントには書かない (REQUEST_OK の表記を維持する根拠):

> This document uses the shorthand PUBLISH_OK, REQUEST_UPDATE_OK, TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK, SUBSCRIBE_TRACKS_OK and PUBLISH_NAMESPACE_OK to refer to a REQUEST_OK sent in response to the corresponding request type.

§9.20.5 (OBJECT_DELIVERY_TIMEOUT Parameter) — コメントには書かない (OBJECT_DELIVERY_TIMEOUT の列挙を削除する根拠):

> The OBJECT_DELIVERY_TIMEOUT parameter (Parameter Type 0x02) is a varint. It MAY appear in a SUBSCRIBE, PUBLISH, or REQUEST_UPDATE message.

§9.20.18 (LARGEST OBJECT Parameter):

> It MAY appear in SUBSCRIBE_OK, PUBLISH, REQUEST_UPDATE_OK, TRACK_STATUS_OK, or PUBLISH_STATE_NOTIFY.

§6.3 (Session initialization):

> Bidirectional streams MUST NOT begin with any other message type unless negotiated. If they do, the peer MUST close the Session with a PROTOCOL_VIOLATION.

Table 5 (§9 Control Messages) の説明文:

> Messages marked "First" MUST be the first message on a new request stream.

§9.15 (SUBSCRIBE_NAMESPACE) と §9.18 (SUBSCRIBE_TRACKS):

> If the subscriber receives any message other than a REQUEST_OK or a REQUEST_ERROR as the first message on the response half of the stream, then it MUST close the session with a PROTOCOL_VIOLATION.

§8.3 (Key-Value-Pair Structure) — コメントには書かない (§8.3 の偶数 / 奇数規則を Message Parameter に持ち込まない根拠):

> Length: Only present when Type is odd. Specifies the length of the Value field in bytes. The maximum length of a value is 2^16-1 bytes.

§9.20.10 (LOCATION FILTER Parameter):

> A Location filter parameter has the following length-prefixed structure:

## 設計方針

- 対象は「現状」に列挙した 8 件に限る。リポジトリ全体の引用の一斉点検や、列挙していない箇所の書き換えは行わない。同種のずれとして次が残るが、本 issue では扱わない。`FetchOptions.subscriberPriority` と `FetchOptions.groupOrder` (`src/session.ts`、§9.20.9 / §9.20.19 の誤り)、`buildFetchParameters` の 2 テスト (`src/session/params.test.ts`、§9.20.9 / §9.20.19 の誤り)、SETUP の DELETE テスト (`src/message/authorizationToken.test.ts`、§9.20.3 の誤り)
- 節番号だけでなく、引用する逐語も `refs/moq/draft-ietf-moq-transport-21.txt` を実際に開いて照合した結果に合わせる。引用は「draft 番号 + セクション番号 + セクションタイトル」の形に統一する
- LOCATION_FILTER の Length は §9.20.10 (LOCATION FILTER Parameter) が構造として定めていることを根拠に書き、「奇数なので」という §8.3 由来の理由付けを削除する。Value が Length で始まること自体は §9.20.10 の構造由来として残し、Length の有無そのものは現状のまま変えない
- 型表は削除せず、draft-21 への帰属を外して「§11.2.1 / §11.3.1 の Type Flags ビット定義から導出した実装側の一覧」と明示する。図表の引用は §11.2.1 の Figure 24 (MOQT OBJECT_DATAGRAM)、§11.3.1 の Figure 25 (MOQT SUBGROUP_HEADER)、Object fields の Figure 26 (MOQT Subgroup Object Fields) に合わせる。表が示す型の集合は現状のまま変えない
- TRACK_STATUS はコメントのみを直し、`buildTrackStatusParameters` と `TrackStatusOptions` は変更しない
- publication ループに `validateFirstMessage` を注入しない現状のコード構造は変えない。§9.14 に応答側の先頭メッセージ MUST が無いため、コメントだけを実態に合わせる
- 挙動は変えない。テストの期待値もテスト名も変えない

## 完了条件

- 「現状」の 8 件すべてで、コメントが示す節番号・引用文・図表の出典・パラメータ名が `refs/moq/draft-ietf-moq-transport-21.txt` と一致する
- 「現状」の 8 件すべてで、指示どおりの書き直しが反映され、旧文言が `src/` に残っていない。`src/session/namespaceLoops.ts` の 3 箇所から「§9.14 に先頭メッセージ MUST が無い」という記述が消え、§9.14 に無いのは応答側の先頭メッセージ MUST である旨になっている。`src/message/parameter/locationFilter.ts` から「奇数なので」が消えている。`src/message/trackstatus.ts` から OBJECT_DELIVERY_TIMEOUT と DEFAULT_PUBLISHER_PRIORITY の列挙が消えている。`src/dataStream/datagram.ts` と `src/dataStream/subgroup.ts` の型表から draft-21 への帰属が外れている
- 挙動の変更がない。`src/` の `git diff` の追加・削除行がすべてコメント行であり、コード・テストの期待値・テスト名に差分が無いことを確認する
- `vp test run` が全テストパスする (期待値を変えないため既存テストで足りる)
- `tsc --noEmit` が通る
- `vp check <変更した TypeScript ファイル>` が通る
- リポジトリ全体の `vp check` は `issues/0617-bug-fetch-stream-request-update-detection.md` の既存の整形ずれ (引用ブロック内のピリオド後の空白 2 個) で失敗し、リポジトリ全体を対象にする pre-commit フックの `vp check` も止まる。これは本 issue の対象ではないため、実装着手前に develop 上で `vp fmt issues/0617-bug-fetch-stream-request-update-detection.md` を単独でコミットして解消しておく。本 issue のブランチと差分には含めない

## 参照

- draft-ietf-moq-transport-21 §6.3 (Session initialization)
- draft-ietf-moq-transport-21 §8.3 (Key-Value-Pair Structure)
- draft-ietf-moq-transport-21 §8.7 (Track Namespace Structure)
- draft-ietf-moq-transport-21 §9.1.4 (AUTHORIZATION TOKEN)
- draft-ietf-moq-transport-21 §9.3 (REQUEST_OK)
- draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE)
- draft-ietf-moq-transport-21 §9.13 (TRACK_STATUS)
- draft-ietf-moq-transport-21 §9.14 (PUBLISH_NAMESPACE)
- draft-ietf-moq-transport-21 §9.15 (SUBSCRIBE_NAMESPACE)
- draft-ietf-moq-transport-21 §9.18 (SUBSCRIBE_TRACKS)
- draft-ietf-moq-transport-21 §9.20.5 (OBJECT_DELIVERY_TIMEOUT Parameter)
- draft-ietf-moq-transport-21 §9.20.8 (SUBSCRIBER PRIORITY Parameter)
- draft-ietf-moq-transport-21 §9.20.9 (GROUP ORDER Parameter)
- draft-ietf-moq-transport-21 §9.20.10 (LOCATION FILTER Parameter)
- draft-ietf-moq-transport-21 §9.20.18 (LARGEST OBJECT Parameter)
- draft-ietf-moq-transport-21 §10.4 (DEFAULT PUBLISHER PRIORITY)
- draft-ietf-moq-transport-21 §11.2.1 (Object Datagram)
- draft-ietf-moq-transport-21 §11.3.1 (Subgroup Header)
- `src/message/parameter/messageParameter.ts` (§8.3 の偶数 / 奇数規則が Message Parameter に適用されないことの記述)
- `issues/0610-bug-encoder-generates-invalid-wire.md` / `issues/0604-refactor-subgroup-first-object.md` (同じ `src/dataStream/datagram.ts` / `src/dataStream/subgroup.ts` / `src/message/parameter/trackNamespace.ts` を触る。対象行は本 issue のコメント行と重ならないが、先に実装された場合は現行文言を読み直す)

## 解決方法

「現状」の 8 件すべてで、`refs/moq/draft-ietf-moq-transport-21.txt` を照合した結果に合わせてコメントを直した。挙動の変更はなく、
`src/` の差分はすべてコメント行である (コード・テストの期待値・テスト名に差分が無いことを `git diff` で確認)。

1. `src/message/parameter/trackNamespace.ts`: 32 フィールド上限の根拠を §8.7 (Track Namespace Structure) に直し、逐語も
   "If an endpoint receives a Track Namespace consisting of greater than 32 Track Namespace Fields, it MUST close the session
   with a PROTOCOL_VIOLATION." に差し替えた (`MAX_TRACK_NAMESPACE_FIELDS` と `decodeTrackNamespace` の 2 箇所)
2. `src/session/params.ts` の `buildFetchParameters`: SUBSCRIBER_PRIORITY を §9.20.8、GROUP_ORDER を §9.20.9 に直し、
   逐語を末尾 ("(for a subscription or FETCH)" / ", or inside a FILL_PARAMETERS parameter (see Section 9.20.16)") まで含めた
3. `src/session/bidi.ts` の `bidiReadRequestStreamMessages`: PUBLISH_DONE の MUST の節番号を §9.8 から §9.9 (PUBLISH_DONE) に直した
4. `src/message/setup.test.ts`: SETUP の DELETE 禁止の引用を §9.1.4 (AUTHORIZATION TOKEN) に直した。
   USE_ALIAS 側のテストには元々コメントが無く、`src/` に §9.20.3 の引用は残っていない
5. `src/message/trackstatus.ts`: モジュールコメントと `TrackStatus` の doc を §9.13 の逐語 (SUBSCRIBER_PRIORITY の例示、
   TRACK_STATUS_OK は REQUEST_OK の shorthand である旨) に書き直し、OBJECT_DELIVERY_TIMEOUT / DEFAULT_PUBLISHER_PRIORITY の
   列挙を削除した。応答に載りうる LARGEST_OBJECT は §9.20.18 を根拠として明記した
6. `src/session/namespaceLoops.ts`: 「§9.14 に先頭メッセージ MUST が無い」を「応答側の先頭メッセージ MUST が無い」に直し、
   要求側の先頭メッセージは Table 5 の "First" と §6.3 が MUST で定めることを併記した (3 箇所)
7. `src/message/parameter/locationFilter.ts`: 「奇数なので Length プレフィックス付き」を削除し、§9.20.10 (LOCATION FILTER
   Parameter) の "A Location filter parameter has the following length-prefixed structure:" を根拠として書いた
   (§8.3 の偶数 / 奇数規則は Message Parameter には適用されない)
8. `src/dataStream/datagram.ts` / `src/dataStream/subgroup.ts`: 型表を draft-21 へ帰属させる記述を外し、「§11.2.1 / §11.3.1 の
   Type Flags ビット定義から導出した実装側の一覧」と明示した。図表の引用は §11.2.1 の Figure 24 (MOQT OBJECT_DATAGRAM)、
   §11.3.1 の Figure 25 (MOQT SUBGROUP_HEADER)、Object fields は Figure 26 (MOQT Subgroup Object Fields) に合わせた

`issues/0617-bug-fetch-stream-request-update-detection.md` の整形ずれは develop 上で既に解消されており、リポジトリ全体の
`vp check` が pass することを確認した (前提作業のコミットは不要だった)。

検証は `pnpm exec tsc --noEmit` / `pnpm exec vp check` / `pnpm test --run` (2269 passed) の通過で確認した。
