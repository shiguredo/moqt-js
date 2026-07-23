# SUBSCRIBE_TRACKS のパラメータ対応を draft-19 に追従する

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-subscribe-tracks-parameters
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 で SUBSCRIBE_TRACKS のパラメータ規則が新設・変更された。変更履歴は Appendix A.1 `#1777` ("Move GROUP_ORDER from PUBLISH_OK to SUBSCRIBE_TRACKS")。

draft-19 Section 10.19.1 (Parameters on SUBSCRIBE_TRACKS):

> Any Parameter that can be specified on a Subscription (ie: in
> SUBSCRIBE) is valid in SUBSCRIBE_TRACKS, unless otherwise specified.
> These parameters are copied over as the default Subscription
> parameters when a PUBLISH is sent as a result of SUBSCRIBE_TRACKS.
> The Parameters are not explicitly communicated, with the exception of
> FORWARD and GROUP_ORDER as described below.

同節は FORWARD / GROUP_ORDER について、SUBSCRIBE_TRACKS 上の値（または省略）が結果 PUBLISH にどう載るかを定める。本リポジトリは subscriber として SUBSCRIBE_TRACKS を送り PUBLISH を受信するため、送信パラメータと受信 PUBLISH のスコープ受理が主眼であり、publisher 側のコピー送信実装は範囲外とする。

draft-19 Section 10.2.8 (GROUP ORDER Parameter):

> The GROUP_ORDER parameter (Parameter Type 0x22) is a uint8. It MAY
> appear in a SUBSCRIBE, SUBSCRIBE_TRACKS, or FETCH.

許可コンテキストから PUBLISH_OK が外れ、SUBSCRIBE_TRACKS に入っている。

**一次資料の矛盾と本 issue の解釈**: Section 10.2.8 の MAY 列挙に PUBLISH は無い。一方 Section 10.19.1 は結果 PUBLISH に GROUP_ORDER を載せることを明示する。Section 10.2.1 (Parameter Scope) では許可外コンテキストの受信は MUST で `PROTOCOL_VIOLATION` になる。本 issue では **Section 10.19.1 を優先**し、PUBLISH 上の GROUP_ORDER を許可する（`PUBLISH_ALLOWED_PARAMS` に追加）。closed `#0328` が PUBLISH から GROUP_ORDER を排除した判断は、draft-19 のこの規則により部分的に撤回する。

## 優先度根拠

moqt-js の `subscribeTracks()` はパラメータを一切指定できず、SUBSCRIBE_TRACKS で既定のサブスクリプションパラメータを制御できない。また `PUBLISH_OK_ALLOWED_PARAMS` に `GROUP_ORDER` が残っており仕様と乖離している。さらに Section 10.19.1 準拠のピアが PUBLISH に GROUP_ORDER を載せると、現行 `PUBLISH_ALLOWED_PARAMS` ではセッションを誤切断する。直ちに全相互運用を壊すわけではないが機能ギャップと誤切断リスクがあるため Medium。

## 現状

シンボル名を正とする。

- `Session.subscribeTracks(namespacePrefix, callbacks)`: `parameters: []` で空固定。`groupOrder` / `forward` を指定する第 3 引数が無い
- `buildSubscribeParameters`（`src/session/params.ts`）: `subscribe()` 専用。`filter` を含む `SubscribeOptions` 全体を扱う。`subscribeTracks()` からは未接続
- `NAMESPACE_ALLOWED_PARAMS`（`src/message/parameterScope.ts`）: `AUTHORIZATION_TOKEN` のみを含む定義があるが、**参照箇所はゼロ**。コメント上は SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE 共有
- `PUBLISH_OK_ALLOWED_PARAMS`: `GROUP_ORDER` を含む。draft-19 Section 10.2.8 では PUBLISH_OK に載らない
- `PUBLISH_ALLOWED_PARAMS`: `AUTHORIZATION_TOKEN` / `EXPIRES` / `LARGEST_OBJECT` / `FORWARD` のみ。`GROUP_ORDER` 無し
- `bidiReadPublishResponse`（`src/session/bidi.ts`）: client-as-publisher が受信した PUBLISH_OK を `PUBLISH_OK_ALLOWED_PARAMS` で検証し、`extractForwardState` で `PublisherImpl.setForwardState` する。これは **PUBLISH_OK 経路**であり、SUBSCRIBE_TRACKS 応答の PUBLISH とは別
- `handleIncomingBidirectionalStream`（`src/session.ts`）: SUBSCRIBE_TRACKS 応答として受信した PUBLISH を `PUBLISH_ALLOWED_PARAMS` で検証する。`extractForwardState` も GROUP_ORDER 抽出もしておらず、`SubscriberImpl` に forward / groupOrder の保持場も無い。現状 GROUP_ORDER 付き PUBLISH はスコープ検証で拒否される

## 設計方針

### 本 issue の範囲（`#1777` 中心）

1. **送信 API**: `subscribeTracks(namespacePrefix, callbacks, options?)` の第 3 引数を追加する。型は `Pick<SubscribeOptions, "groupOrder" | "forward">`（これ以外の `SubscribeOptions` フィールドは本 issue では公開しない）。`forward` は既存 `subscribe()` と同様、明示的に `false` のときだけワイヤに FORWARD=0 を載せ、`true` / 省略はデフォルト 1 のためパラメータ自体を送らない。なお現行の受信 PUBLISH への応答は `parameters: []` の PUBLISH_OK であり、Section 10.2.17 どおり FORWARD 省略時のデフォルトは 1 になる。そのため `subscribeTracks(..., { forward: false })` だけでは、結果 PUBLISH が FORWARD=0 でも直後の空 PUBLISH_OK が Forward State を 1 に戻し、停止意図が打ち消される。本 issue では ST 送信ワイヤに FORWARD=0 を載せるところまでを完了条件とし、PUBLISH_OK への FORWARD=0 追随は範囲外（必要なら別 issue）
2. **許可集合**: `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` を新設し、本 issue では次に限定する（いずれも各 Parameter 節または 10.19.1 で SUBSCRIBE_TRACKS が明示される）。moqt-js は SUBSCRIBE_TRACKS の受信エンドポイントを持たないため、定数は送信側の妥当性チェック用・単体テスト用であり、受信ループへの配線は不要
   - `AUTHORIZATION_TOKEN`（Section 10.2.2）— 受信検証・将来の送信用。本 issue の公開 options には auth を出さない（送受非対称は `subscribe()` 現状と同様）
   - `FORWARD`（Section 10.2.17）
   - `GROUP_ORDER`（Section 10.2.8）
   - `NAMESPACE_ALLOWED_PARAMS` を広げて SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE に誤許可を広げない。コメントから SUBSCRIBE_TRACKS を外す
3. **PUBLISH_OK**: `PUBLISH_OK_ALLOWED_PARAMS` から `GROUP_ORDER` を削除する（Section 10.2.8）
4. **PUBLISH 受信**: `PUBLISH_ALLOWED_PARAMS` に `GROUP_ORDER` を追加し、GROUP_ORDER 付き PUBLISH をスコープ検証で **受理**する（Section 10.19.1 優先）。値のアプリ公開や `SubscriberImpl` への状態反映は必須としない（受理＝切断しない）
5. 触るファイルの仕様参照コメントだけ draft-19 Section 10.19.1 / 10.2.8 / 10.2.17 / 10.2.1 に更新する。リポジトリ全体の draft-18 一掃は `#0343`

### 意図的に含めないもの

- Section 10.19.1 の包括規則で SUBSCRIBE 由来になりうる他パラメータ（`OBJECT_DELIVERY_TIMEOUT` / `SUBGROUP_DELIVERY_TIMEOUT` / `SUBSCRIBER_PRIORITY` / `NEW_GROUP_REQUEST` / `RENDEZVOUS_TIMEOUT` 等）。各 Parameter 節の MAY 列挙に SUBSCRIBE_TRACKS が無いものがあり、包括規則との解釈を本 issue で広げない。必要なら別 issue
- Location Filter（現行 `SUBSCRIPTION_FILTER` / `0x21`）: Section 10.2.9 の MAY は SUBSCRIBE / PUBLISH_OK / REQUEST_UPDATE のみ。識別子リネームは `#0340`（リネームのみ。SUBSCRIBE_TRACKS 対応は `#0340` の範囲外）。SUBSCRIBE_TRACKS への Location Filter 追加も本 issue の範囲外
- Range Filters（`0x25`–`0x29`）と `MAX_FILTER_RANGES`、およびその API: `#0341`
- SUBSCRIBE_TRACKS_OK の EXPIRES: `#0333`
- publisher 側で SUBSCRIBE_TRACKS を受信し PUBLISH へパラメータをコピーして送る実装
- 受信 PUBLISH に対する PUBLISH_OK への FORWARD=0 追随（上記のとおり、空 PUBLISH_OK のデフォルト 1 により `forward: false` は実質無効になり得る）

### テスト戦略（モック禁止）

- `src/message/parameterScope.test.ts`（新設可）: `PUBLISH_OK_ALLOWED_PARAMS` が GROUP_ORDER を拒否、`PUBLISH_ALLOWED_PARAMS` が GROUP_ORDER を通過、`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` が AUTH / FORWARD / GROUP_ORDER を通過・それ以外を拒否。`validateParameterScope` に実コールバックを渡す
- エンコード: `groupOrder` / `forward` 付き options から作った parameters が `encodeSubscribeTracksPayload` に載ることを検証。`namespace.prop.ts` 等の「parameters 空」前提は options 無しケースとして残し、options 有りケースを追加する
- session private の受信 E2E は必須としない。集合 + `validateParameterScope` 単体を主担保（closed `#0322` / `#0333` と同方針）

## 完了条件

- `subscribeTracks(namespacePrefix, callbacks, options?)` で `groupOrder` / `forward` を指定して送信できること（エンコード結果のテストを含む）
- 公開 options 型に `filter` / `joiningFetch` / タイムアウト系等が含まれないこと
- `PUBLISH_OK_ALLOWED_PARAMS` から `GROUP_ORDER` が消え、GROUP_ORDER 付き PUBLISH_OK 受信がスコープ検証で拒否されること
- `PUBLISH_ALLOWED_PARAMS` に `GROUP_ORDER` が入り、GROUP_ORDER 付き PUBLISH がスコープ検証で受理されること
- `SUBSCRIBE_TRACKS_ALLOWED_PARAMS` が `AUTHORIZATION_TOKEN` / `FORWARD` / `GROUP_ORDER` に限定され、`NAMESPACE_ALLOWED_PARAMS` と分離されていること
- Location Filter / Range Filter / 上記「意図的に含めない」パラメータの実装・API を本変更に含めていないこと
- `CHANGES.md` の `## develop` にエントリがあること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/message/parameterScope.ts`: `SUBSCRIBE_TRACKS_ALLOWED_PARAMS`（AUTH / FORWARD / GROUP_ORDER）を新設。`PUBLISH_OK_ALLOWED_PARAMS` から `GROUP_ORDER` を削除。`PUBLISH_ALLOWED_PARAMS` に `GROUP_ORDER` を追加。`NAMESPACE_ALLOWED_PARAMS` のコメントから SUBSCRIBE_TRACKS を外す。コメントに Section 10.19.1 / 10.2.8 / 10.2.17 / 10.2.1
2. `src/session.ts`: `subscribeTracks(namespacePrefix, callbacks, options?: Pick<SubscribeOptions, "groupOrder" | "forward">)` を追加。`parameters: []` を options 由来の配列に置換（`groupOrder` / `forward` だけをエンコード。`buildSubscribeParameters` をそのまま流用しない — `filter` 等が混入するため）
3. `src/session/params.ts`: `groupOrder` / `forward` だけを Parameter[] にする小さな builder を追加するか、既存の GROUP_ORDER / FORWARD エンコード断片を共有する
4. テスト: `parameterScope.test.ts` の通過 / 拒否、`encodeSubscribeTracksPayload` へのパラメータ載荷。モック禁止
5. 触った箇所の仕様参照を draft-19 に更新
6. `CHANGES.md` の `## develop` に `[CHANGE]` で、SUBSCRIBE_TRACKS への GROUP_ORDER / FORWARD 送信、PUBLISH_OK からの GROUP_ORDER 削除、PUBLISH への GROUP_ORDER 許可を追記する
