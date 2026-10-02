# Subscription と Fetch の定義・用語・節番号に追随する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-subscription-fetch-definitions
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 で Subscription と Fetch に関連する定義が追加・整理され、§3.1 の節構成が変わった。moqt-js のコメント・引用・節番号を v22 に合わせる。挙動変更は想定しない。

v21 からの差分 (いずれも `refs/moq/draft-ietf-moq-transport-22.txt` で確認済み):

- §1.3 (Terms and Definitions) に Subscription の定義が入った: "Subscription: An ongoing relationship in which a publisher delivers newly published objects from a track to a subscriber. See (Section 3.1)." v21 §1.3 には無かった
- §3.1 (Subscriptions) に subscription-delivered の定義が入った: "An object published or received in a subgroup or datagram is _subscription-delivered_." v21 では語句自体は §3.3.1 / §3.4 に出現していたが、定義文は無かった
- §3.1 の節構成が変わった。v21 の §3.1.1 (Subscription State Management) / §3.1.2 (Track Alias) / §3.1.3 (Largest Object) は、v22 では §3.1.2 / §3.1.3 / §3.1.4 に対応し、§3.1.1 には新設の Pausing Subscriptions が入る。unknown Track Alias の取り扱いも v22 では §3.1.3.1 (Unknown Track Alias) として独立し、文言が変更された
- §3.2 (Fetch) の冒頭に Fetch の定義が入った: "A FETCH requests pre-existing Objects from a Track between a Start Location and an End Location, inclusive. This range is specified by a Location Filter (see Section 3.3.1) when present, or defaults to {0, 0} and Largest Object (Section 3.1.4) respectively." v21 の §3.2 は §3.2.1 Fetch State Management のみで導入定義が無かった
- §3.3.1 (Location Filters) の publisher MUST から "subscription-delivered" が外れた: v21 は "A publisher MUST NOT send subscription-delivered objects from outside the requested range."、v22 は "A publisher MUST NOT send objects from outside the requested range." となっている
- §3.4 (Fill Semantics) の節番号は v21 から不変で、fill-delivered と subscription-delivered の双方を定義する文 ("An object delivered on the fill fetch stream is _fill-delivered_." / "When the fill range overlaps the subscription's Location filter, an object can be both fill-delivered and subscription-delivered.") も v21 と同一である。節内のパラメータ参照 (§9.20.16 → §9.20.15 など) は各パラメータ担当 issue (0796 等) の対象

## 現状

`refs/moq` は v22 に更新済み (コミット `61c242c`) だが、`src/` のコメントは v21 の版表記・節番号・逐語引用のままである。実ファイルと照合した結果は次のとおり。

### subscription-delivered / fill-delivered の用語

語句は既にコードコメントで使用されており、参照先が v21 のままである。

- `src/dataStream/common.ts` の `MoqtObject.fillDelivered` の JSDoc: "購読の object コールバック文脈では、true は fill-delivered (fill fetch ストリーム経由)、未設定は subscription-delivered (subgroup / datagram 経由)"。仕様参照は無く、v22 §3.1 / §3.4 の定義を根拠として書ける
- `src/subscriber.ts` の `handleFillObject` の JSDoc: "fill-delivered のオブジェクトは fill 範囲に従属するため..." で fillDelivered と subscription-delivered の区別を説明し、`draft-ietf-moq-transport-21 §3.3.1 / §3.4 (Fill Semantics)` を参照している
- `src/publisher.ts` の `subscriptionLocationFilter` のコメント、`onSendObjectSkipped` の JSDoc、`isOutsideLocationFilter` の JSDoc (計 3 箇所) が v21 §3.3.1 の逐語 "A publisher MUST NOT send subscription-delivered objects from outside the requested range." を引用している
- `src/publisher.test.ts` のコメントにも同じ逐語の引用がある
- `src/session.test.ts` に fill-delivered / subscription-delivered の逐語引用がある (§3.4 由来。詳細はテストコメントの "An object delivered on the fill fetch stream is _fill-delivered_." / "can be both fill-delivered and subscription-delivered.")
- `src/session/statistics.ts` の `objectsReceivedViaFetch` の JSDoc と `src/session/incoming.ts` の `incomingProcessFetchObjects` の JSDoc が v21 §3.4 を参照するのみ (fill-delivered と通常 FETCH の経路区別)

### §3.1 内の再番号付け (v21 §3.1.x → v22 §3.1.x+1)

v21 の節番号のまま参照している箇所は v22 では指し先が変わるため、番号の更新が必要である。

- v21 §3.1.1 (Subscription State Management) → v22 §3.1.2: `src/session/publish.ts` の `publishSendObjectInternal` (2 箇所) と `publishResetPublisherStream`、`src/session/bidi.ts` の `handlePublishPeerCancel` ほか 2 箇所、`src/session/publish.test.ts` (2 箇所)、`src/session/publish.prop.ts`、`src/session/bidiSubscribeFinReset.test.ts` (2 箇所)。`handlePublishPeerCancel` は逐語 "The Publisher can remove subscription state as soon as it has received STOP_SENDING. It MUST reset any open streams associated with the SUBSCRIBE." を引用しており、v22 §3.1.2 にも同じ文がある
- v21 §3.1.2 (Track Alias) → v22 §3.1.3: `src/session.test.ts` (4 箇所)、`src/session/incomingPublish.ts` の Track Alias 重複判定、`src/session/bidi.ts` の DUPLICATE_TRACK_ALIAS 判定、`src/session/bidiResponseCrossCancel.test.ts` (2 箇所)
- v21 §3.1.3 (Largest Object) → v22 §3.1.4: `src/` に参照は無し (Largest Object の引用は v21 §9.20.18 経由であり 0804 の対象)
- v22 新設の §3.1.3.1 (Unknown Track Alias): `src/pendingSubgroupBuffer.ts` のヘッダーと `src/session.ts` の `pendingSubgroupBuffer` のコメントが、v21 §11.3.1 (Subgroup Header) の逐語 "If an endpoint receives a subgroup with an unknown Track Alias, it MAY abandon the stream, or choose to buffer it for a brief period to handle reordering with the control message that establishes the Track Alias..." を引用している。v22 ではこの文言は §3.1.3.1 に移動し、"When an endpoint receives a datagram or a new stream with a Track Alias that is not yet associated with an Established subscription, it MAY drop the data or buffer it briefly to handle reordering with the control message that establishes the Track Alias..." に書き換わっている

### §3.2 冒頭の定義 (Fetch の既定範囲)

- `src/session/publicTypes.ts` の `FetchOptions.filter` の JSDoc に "指定しない場合、フィルタなしとして {0, 0} から Largest Object までの全オブジェクトを要求する (§9.20.10。Fetch では End Group / End Object を省略した場合の終端が Largest Object になる)" とあり、既定範囲の記述は v21 §3.3.1 由来で v22 では §3.2 冒頭の定義に対応する。ワイヤ形式の記述 (§9.20.10) は 0796 の対象
- `src/session/params.ts` の `resolveFetchStartLocation` の JSDoc は "draft-ietf-moq-transport-21 §3.3.1 (Location Filters)" を引用し、逐語 "Fetch requests without a filter include all Locations from {0, 0} up to Largest Object" を掲げている。この逐語は v22 では §3.2 冒頭に移動している。確定可否のロジック自体は 0796 の対象

### その他

- `src/subscriber.ts` のモジュールヘッダーと `handleObject` の JSDoc は v21 §3.1 (Subscriptions) を参照している (番号は v22 でも §3.1 で不変だが、版表記は v22 へ)
- v21 §3.2.1 (Fetch State Management) を参照する `src/fetcher.ts` の `cancel` ほかは v22 §3.2.4 に対応するが、これは 0798 の対象であり本 issue では扱わない
- `src/dataStream/fetch.ts` / `src/session/stream.ts` の v21 §11.4.1.1 / §11.4.1.2 の参照 (Table 8 / 9) は 0799 / 0798 の対象
- devtools / docs に subscription-delivered / fill-delivered の記述はない

## 設計方針

- 用語の根拠を v22 に置く。subscription-delivered の定義文 (v22 §3.1) を根拠として、`src/dataStream/common.ts` の `MoqtObject.fillDelivered`、`src/subscriber.ts` の `handleFillObject`、`src/session.test.ts` の該当コメントの参照を v22 §3.1 / §3.4 に更新する。fill-delivered の定義文は §3.4 (節番号不変) にあり、これを維持する。`src/session/statistics.ts` / `src/session/incoming.ts` の v21 §3.4 参照は版表記のみ v22 に更新する
- `src/publisher.ts` / `src/publisher.test.ts` の逐語を v22 §3.3.1 の "A publisher MUST NOT send objects from outside the requested range." に差し替え、参照を v22 §3.3.1 に更新する ("subscription-delivered は v22 §3.1 で定義される" 旨を併記する)
- §3.1 内の再番号付けを反映する。v21 §3.1.1 (Subscription State Management) → v22 §3.1.2、v21 §3.1.2 (Track Alias) → v22 §3.1.3。前述の `src/session/publish.ts` / `src/session/bidi.ts` / `src/session.test.ts` / `src/session/incomingPublish.ts` / `src/session/publish.test.ts` / `src/session/publish.prop.ts` / `src/session/bidiSubscribeFinReset.test.ts` / `src/session/bidiResponseCrossCancel.test.ts` の該当箇所を更新する
- `src/pendingSubgroupBuffer.ts` / `src/session.ts` の unknown Track Alias の引用を、v22 §3.1.3.1 の文言 ("...it MAY drop the data or buffer it briefly to handle reordering with the control message that establishes the Track Alias. For streams, the endpoint MAY withhold stream flow control beyond the stream header until the Track Alias has been established. To prevent deadlocks, endpoints MUST allocate connection flow control to control streams before allocating it to any data streams...") に差し替える
- §3.2 冒頭の定義に合わせる。`FetchOptions.filter` の既定範囲の記述と、`resolveFetchStartLocation` の JSDoc の引用を v22 §3.2 に更新する (ワイヤ形式と解決ロジックは 0796 の対象)
- `src/subscriber.ts` の v21 §3.1 参照の版表記を v22 に更新する
- 型や API の変更は行わない (定義の整理に追随するコメント・引用の更新のみ)。シンボル名 (`fillDelivered` / `Fetcher` / `Subscriber`) と統計の区分名は v22 の用語と整合するため維持する
- 境界: 0796 (LOCATION FILTER のワイヤ形式・`LocationFilter` 表現・§9.20.10 → §9.20.9)、0798 (§3.2.1-§3.2.4 の Fetch State Management / ギャップ / §11.4.1.2 / §12.5)、0799 (Delivery Mode / §2.1.1 / §3.2.1 Fetch Object Delivery / §11.4.1.1)、0800 (FORWARD と paused の用語 / §3.1.1 Pausing Subscriptions / §9.20.18 / §11.3.2)、0802 (REQUEST_ERROR → FETCH_ERROR / SUBSCRIBE_ERROR などの呼称)、0804 (Largest Object が到着中であり得る前提 / §3.1.4)、0805 (FETCH_OK End Location の inclusive / §9.12) は本 issue では扱わない

## 完了条件

- 前述の対象箇所 (subscription-delivered / fill-delivered の引用、§3.1.x の再番号付け、unknown Track Alias の引用、§3.2 冒頭の既定範囲、`src/subscriber.ts` の §3.1 参照) で、draft-ietf-moq-transport-21 の版表記・節番号・逐語が残っておらず、v22 と一致している
- v21 §3.1.1 / §3.1.2 を参照するコメントが無く、v22 §3.1.2 (Subscription State Management) / §3.1.3 (Track Alias) の参照になっている
- 挙動変更が無いことを既存テストで確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-22.txt` §1.3 (Terms and Definitions) / §3.1 (Subscriptions) / §3.1.2 (Subscription State Management) / §3.1.3 (Track Alias) / §3.1.3.1 (Unknown Track Alias) / §3.2 (Fetch) / §3.3.1 (Location Filters) / §3.4 (Fill Semantics)
- `src/dataStream/common.ts` の `MoqtObject.fillDelivered` / `src/subscriber.ts` の `handleFillObject` / `handleObject` / `src/publisher.ts` の `subscriptionLocationFilter` / `isOutsideLocationFilter` / `src/session/statistics.ts` の `objectsReceivedViaFetch` / `src/session/incoming.ts` の `incomingProcessFetchObjects`
- `src/session/publish.ts` の `publishSendObjectInternal` / `publishResetPublisherStream` / `src/session/bidi.ts` の `handlePublishPeerCancel` / `src/session/incomingPublish.ts` の Track Alias 重複判定 / `src/session.ts` の `pendingSubgroupBuffer` / `src/pendingSubgroupBuffer.ts` のヘッダー
- `src/session/publicTypes.ts` の `FetchOptions.filter` / `src/session/params.ts` の `resolveFetchStartLocation`
- `src/publisher.test.ts` / `src/session.test.ts` / `src/session/publish.test.ts` / `src/session/publish.prop.ts` / `src/session/bidiSubscribeFinReset.test.ts` / `src/session/bidiResponseCrossCancel.test.ts`

## 解決方法

### 1. subscription-delivered / fill-delivered の根拠

- `src/dataStream/common.ts` の `MoqtObject.fillDelivered` の JSDoc に、v22 §3.1 の「An object published or received in a subgroup or datagram is *subscription-delivered*.」と §3.4 の「An object delivered on the fill fetch stream is *fill-delivered*.」を根拠として書いた
- `src/subscriber.ts` の `handleFillObject` / `handleObject`、`src/session/statistics.ts`、`src/session/incoming.ts` の §3.4 参照を v22 に更新した (§3.4 の節番号は不変)
- `src/publisher.ts` / `src/publisher.test.ts` が引用していた v21 §3.3.1 の逐語「A publisher MUST NOT send subscription-delivered objects from outside the requested range.」を、v22 §3.3.1 の「A publisher MUST NOT send objects from outside the requested range.」に差し替えた (v22 では subscription-delivered が外れ、定義は §3.1 にあるため併記した)

### 2. §3.1 の再番号付け

- v21 §3.1.1 (Subscription State Management) → v22 §3.1.2、v21 §3.1.2 (Track Alias) → v22 §3.1.3 の参照を更新した (§3.1.2 系は 0800 の作業で先に直っており、残っていた `src/session/incomingPublish.ts` / `src/session/bidi.ts` / `src/session/bidiResponseCrossCancel.test.ts` / `src/session.test.ts` を本 issue で直した)
- `src/pendingSubgroupBuffer.ts` と `src/session.ts` / `src/session/dataStreamIncoming.ts` が引用していた v21 §11.3.1 の unknown Track Alias の文を、v22 §3.1.3.1 の文言 (「When an endpoint receives a datagram or a new stream with a Track Alias that is not yet associated with an Established subscription, it MAY drop the data or buffer it briefly ...」) に差し替えた。同ファイル内に残っていた "brief period" も "buffer it briefly" に揃えた

### 3. §3.2 冒頭の Fetch の既定範囲

- `src/session/publicTypes.ts` の `FetchOptions.filter` の JSDoc に、v22 §3.2 の「A FETCH requests pre-existing Objects from a Track between a Start Location and an End Location, inclusive. This range is specified by a Location Filter (see Section 3.3.1) when present, or defaults to {0, 0} and Largest Object (Section 3.1.4) respectively.」を根拠として書いた
- `src/session/params.ts` の `resolveFetchStartLocation` は develop 側で既に v22 §3.3.1 / §3.2 を参照していたため変更していない

### 4. 挙動

差分はコメントのみで、型・API・実行されるコードは変更していない (`vp test run` で従来の挙動が保たれることを確認)。

### 5. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3569 tests) が通る。`/review-diff-code` を 3 周回し、指摘 (逐語の強調記法、FILL PARAMETERS の節番号、省略の示し方、折り返し) はすべて反映した。CHANGES.md の `## develop` の `### misc` に [UPDATE] エントリを追加した。

なお §3.4 を引く参照は本 issue の対象ファイル以外 (`src/session/params.ts` / `src/session/dataStreamIncoming.ts` / `src/session/bidiResponseScopeViolation.test.ts` など) にも v21 の版表記が残っている。§3.4 の節番号は v22 でも同じであり、一括の版表記更新は別途行う。
