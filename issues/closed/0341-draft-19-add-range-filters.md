# Range Filters と MAX_FILTER_RANGES Setup Option を追加する (draft-19 追従)

- Priority: Low
- Created: 2026-07-07
- Completed: 2026-07-24
- Model: Fable 5
- Branch: feature/add-draft-19-range-filters
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters) で範囲フィルタが新設された。変更履歴は Appendix A.1 `#1765` ("Add Range Filters that can filter Objects from Subscriptions and SUBSCRIBE_TRACKS")。本文では FETCH にも載る（A.1 要約より広い）。

draft-19 Section 5.1.3:

> Range Filters are parameters in SUBSCRIBE, FETCH, or SUBSCRIBE_TRACKS
> that tell a publisher to filter tracks (via TRACK PROPERTY FILTER)
> and objects according to subscriber-provided criteria.

新設 Message Parameters (Section 10.2.10–10.2.14 / IANA Table 13):

| Parameter              | Type   | 節      |
| ---------------------- | ------ | ------- |
| SUBGROUP_FILTER        | `0x25` | 10.2.10 |
| OBJECTID_FILTER        | `0x26` | 10.2.11 |
| PRIORITY_FILTER        | `0x27` | 10.2.12 |
| OBJECT_PROPERTY_FILTER | `0x28` | 10.2.13 |
| TRACK_PROPERTY_FILTER  | `0x29` | 10.2.14 |

ワイヤ（Section 5.1.3）:

- Value は Length (vi64、バイト数) 付き。Length > 0 のとき SetID (8 bit) +（Property Filter なら Property Type (vi64)）+ Range 列
- Range は inclusive。Start は直前 Range の End からの delta（先頭は 0 から）、End は当該 Start からの delta。**シーケンス末尾の End のみ省略可**（open-ended）。途中 Range の End 省略は不正 → `INVALID_FILTER`
- 例: ranges 3–5 と 10–15 → Start=3, End=2, Start=5, End=5
- delta 結果が `2^64-1` を超えたら MUST `REQUEST_ERROR` / `INVALID_FILTER`

同一 SetID 内は AND、異なる SetID 間は OR（Section 5.1.3）。Location Filters / Range Filters / Forward をさらに AND で結合するのは Section 5.1.4 (Combining Filters) であり、SetID 結合とは別である。

```
Pass = Forward AND Location Filters AND Range Filters
```

出現メッセージ（Section 5.1.3）:

- TRACK_PROPERTY_FILTER: SUBSCRIBE_TRACKS、またはその REQUEST_UPDATE (`REQUEST_UPDATE for it`) のみ。複数回 MAY
- その他 (`0x25`–`0x28`): FETCH / SUBSCRIBE / SUBSCRIBE_TRACKS / PUBLISH_OK / REQUEST_UPDATE (on a subscription, from the subscriber only)。複数回 MAY

REQUEST_UPDATE 制約（Section 5.1.3。一般の「パラメータ削除不可」§10.9 の特例）:

- Length = 0: 当該 Parameter Type のフィルタを削除
- Length ≠ 0: その Parameter Type のフィルタ全体（全 SetID / Property Type）を置換
- 省略: 値は不変。他メッセージで省略した場合の default は no filter

同一メッセージ内で Parameter Type + SetID +（Property Filter のみ）Property Type が重複したら MUST `INVALID_FILTER`。

あわせて以下が新設された。

MAX_FILTER_RANGES Setup Option (Section 10.3.1.6、Type `0x06`):

> The default value is 0, so if not specified, the peer MUST NOT
> send any such filter parameters. If this limit is exceeded, an
> endpoint MUST reject this with REQUEST_ERROR with error code
> INVALID_FILTER.

REQUEST_ERROR コード（Section 10.6 / IANA Section 15.11.2）。**混ぜないこと**:

- CONFLICTING_FILTERS (`0x35`): SUBSCRIBE_TRACKS 応答専用。「filter parameters conflict among too many subscribers to aggregate the subscription upstream or otherwise efficiently service it」
- INVALID_FILTER (`0x36`): フィルタ不正・上限超過など（下記発火条件）

INVALID_FILTER の MUST 条件（網羅）:

| 条件                                                             | 出典                         |
| ---------------------------------------------------------------- | ---------------------------- |
| delta が `2^64-1` 超過                                           | 5.1.3                        |
| Parameter Type + SetID + Property Type の重複                    | 5.1.3                        |
| MAX_FILTER_RANGES 超過（subscription / fetch 単位の Range 総数） | 5.1.3 / 10.3.1.6             |
| PRIORITY_FILTER の復号値 > 255                                   | 10.2.12                      |
| OBJECT / TRACK PROPERTY FILTER の Property Type が偶数でない     | 10.2.13 / 10.2.14            |
| 途中 Range の End 省略                                           | 5.1.3（最終 End のみ省略可） |

## 優先度根拠

MAX_FILTER_RANGES のデフォルトは 0 であり、moqt-js が広告しない限りピアは Range Filter を送ってこない (MUST NOT)。そのため未対応でも相互運用は壊れない。subscriber として不要オブジェクトを削減できるが additive な拡張であり Low。

（client-as-publisher でフィルタ付き SUBSCRIBE を受ける場合の MUST §5.1.4 は本 issue スコープ外。下記「スコープ外」。）

## 現状

- Range Filter (`0x25`–`0x29`) は未実装。`MessageParameterType` に未定義
- `MESSAGE_PARAMETER_VALUE_ENCODING` に未登録のため、これらを含むメッセージを受信すると `ProtocolViolationError`（未知型）になる
- `decodeParameters` は `AUTHORIZATION_TOKEN` 以外の同一 Type 重複を `ProtocolViolationError` にする。Range Filter は仕様上複数回 MAY のため、実装時は `0x25`–`0x29` を重複禁止から除外する
- 既存の受信ループは `ProtocolViolationError` をセッション `PROTOCOL_VIOLATION` 切断に繋ぐ。**フィルタ不正はセッション切断ではなく `REQUEST_ERROR` / `INVALID_FILTER`** であるため、デコード層とセッション層を分離する必要がある（後述）
- `SetupOptionType` に MAX_FILTER_RANGES (`0x06`) が未定義（`AUTHORITY: 0x05` の次が `MOQT_IMPLEMENTATION: 0x07`）。**Setup Option の `0x06` 欠番であり、Message Parameter の `SUBGROUP_DELIVERY_TIMEOUT: 0x06` とは別レジストリ**
- `createSetup`（`src/message/setup.ts`）は AUTHORIZATION_TOKEN / MAX_AUTH_TOKEN_CACHE_SIZE / MOQT_IMPLEMENTATION のみ。`connect()` / `initialize()` も現状 `authorizationToken` のみを渡す
- ピアの Setup 値は現状 debug 用に読むだけで保持しない（`getSetupMaxAuthTokenCacheSize` 先例）。MAX_FILTER_RANGES は送信ガードのため **フィールド保持が必須**
- `RequestErrorCode` は `REDIRECT: 0x34` まで。`CONFLICTING_FILTERS` (`0x35`) / `INVALID_FILTER` (`0x36`) が未定義
- 送信経路: `buildSubscribeParameters` あり。`fetch()` は `session.ts` 内で FILL_TIMEOUT を直 push。`subscribeTracks()` は `parameters: []` 固定（`#0336` が options 導入予定）。PUBLISH 応答の PUBLISH_OK も `parameters: []` 固定（`session.ts`）。REQUEST_UPDATE 受信は `bidi.ts` でほぼ常に REQUEST_OK

## 設計方針

### エラー層の分離（重要）

| 層                                | 役割                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| encode / decode（`parameter.ts`） | ワイヤの往復。不正値は専用結果（例: `InvalidFilterError` または検証関数の戻り値）で返す。**`ProtocolViolationError` にしない**（セッション切断に繋がるため） |
| `decodeParameters`                | `0x25`–`0x29` の複数出現を許容。未知型・AUTH 以外の他 Type 重複は従来どおり `ProtocolViolationError`                                                         |
| session / bidi                    | 検証失敗・MAX 超過時に `REQUEST_ERROR`（`INVALID_FILTER`）を送りリクエストを失敗させる。`MalformedTrackError` → `UNSUPPORTED_EXTENSION` と同型の振り分け     |

MAX 超過はピア／自側の Setup 状態に依存するため、decode 単体ではなく session 層で判定する。

### 本 issue の範囲（In）

1. Range Filter 5 種の encode / decode（length-prefixed、SetID、Property Type、delta Range、末尾 End 省略、Length=0 削除）
2. `MessageParameterType` / `MESSAGE_PARAMETER_VALUE_ENCODING`（5 種すべて `"length-prefixed"`）/ `parameterScope` 登録
3. `decodeParameters` の重複禁止から `0x25`–`0x29` を除外 + 上記検証 → `INVALID_FILTER` 送出経路
4. `SetupOptionType.MAX_FILTER_RANGES = 0x06`、getter（未指定時 **default 0**）、SETUP 受信で**ピア値を Session フィールドに保持**、送信前ガード。**本 issue では自側 MAX_FILTER_RANGES を広告しない**（`ConnectOptions` への広告配線は行わない）。広告しない限りピアは Range Filter を MUST NOT 送信するため、§5.1.4 publisher MUST との衝突を避ける。自側広告・受信時 Range 総数検証・publisher 適用は別 issue で同時に行う
5. 送信 API（必須）:
   - `SubscribeOptions` / `FetchOptions` / `subscribeTracks` options / `RequestUpdateOptions` に Range Filter 欄を追加
   - 型スケッチ: `rangeFilters?: RangeFilterParam[]`（例）。各要素は `{ type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty"; setId: number; propertyType?: bigint; ranges: Array<{ start: bigint; end?: bigint }> }` または同等
   - REQUEST_UPDATE で Length=0 削除: `rangeFilters` に「削除」を表すバリアント（例: `{ type: "subgroup"; remove: true }`）または別フィールドで明示。黙って省略＝不変（仕様どおり）
   - ピア MAX が 0（未広告含む）で呼び出し側が Range Filter を指定したら **API が throw**（黙って落とさない）。送信時の Range 総数超過も **送信前 throw のみ**（自分へ `REQUEST_ERROR` は送れない）
6. PUBLISH_OK 載荷（必須・非破壊）: 現行 `onPublish` → `SubscribeCallbacks` → `parameters: []` 固定を拡張する。`SubscribeCallbacks` に additive な optional（例: `publishOkOptions?: { rangeFilters?: RangeFilterParam[] }`、または同等の getter）を足し、PUBLISH_OK 組み立て時にそれを読む。`onPublish` の戻り値型は壊さない
7. `RequestErrorCode.CONFLICTING_FILTERS = 0x35` / `INVALID_FILTER = 0x36`。受信したフィルタが不正な場合の `INVALID_FILTER` 送出経路は、ワイヤ検証用に実装してよい（自側未広告でも防御的に）。`CONFLICTING_FILTERS` は定数 + 受信時 `normalizeRequestErrorCode` のみ
8. `CHANGES.md` に `[ADD]`

### `#0336` との options 合成

- `#0336` が先: `subscribeTracks` 第 3 引数に Range Filter 欄を追記（交差型または options 拡張）
- 本 issue が先: 第 3 引数を導入し Range Filter のみ。0336 が後から `groupOrder` / `forward` を足す
- どちらが先でも **1 つの options オブジェクト**にまとめる。別引数にはしない

### スコープ外（Out）

- 自側 `MAX_FILTER_RANGES` の SETUP 広告、およびそれに伴う受信 Range 総数の上限検証
- client-as-publisher での Range Filter 適用（マッチしない Object の送信抑止）。Section 5.1.4 の publisher MUST。上記広告と同時に別 issue で扱う
- Section 5.1.4 Combining の配送時評価（SetID AND/OR は純関数ヘルパの単位テストまで）
- 同一 Track Alias 上の複数 subscription に対する subscriber 側 Range Filter 再適用（`#0334` は Location 再適用のみ。再適用は 0334 完了後の別作業）
- Location Filter リネーム（`#0340`）
- `subscribeTracks` の `groupOrder` / `forward`（`#0336`）
- 未編集ファイルの draft-18 文字列一掃（`#0343`）

### パラメータスコープ表（Section 5.1.3）

| パラメータ                                                       | 許可                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| TRACK_PROPERTY_FILTER (`0x29`)                                   | SUBSCRIBE_TRACKS、その REQUEST_UPDATE                                                            |
| SUBGROUP / OBJECTID / PRIORITY / OBJECT_PROPERTY (`0x25`–`0x28`) | FETCH / SUBSCRIBE / SUBSCRIBE_TRACKS / PUBLISH_OK / subscription の REQUEST_UPDATE（subscriber） |

`NAMESPACE_ALLOWED_PARAMS` を安易に広げて SUBSCRIBE_NAMESPACE に誤許可しない。SUBSCRIBE_TRACKS 用集合は `#0336` の `SUBSCRIBE_TRACKS_ALLOWED_PARAMS`（または同等）に追加する。

### Setup（本 issue）

- 自側は `MAX_FILTER_RANGES` を**送らない**（default 0 のまま）
- ピアの広告値（無ければ 0）を Session に保持し、呼び出し側が Range Filter を指定したときだけガードする

## 完了条件

- Range Filter 5 種の encode / decode ラウンドトリップがあること（複数 Range、末尾 End 省略、delta 例 3–5 / 10–15、Length=0 削除、Property Filter の Property Type 付き）
- SetID 同一 = AND / 異 SetID = OR の純関数ヘルパ、または同等の単位テストがあること（配送抑止への接続は不要）
- `0x25`–`0x29` の複数出現が PROTOCOL_VIOLATION にならないこと
- 同一 (Type, SetID, Property Type) 重複・PRIORITY > 255・奇数 Property Type・途中 End 省略・delta overflow が、**セッション切断ではなく** `REQUEST_ERROR` / `INVALID_FILTER` になること（単体で検証関数、または受信経路のテスト）
- TRACK_PROPERTY_FILTER を誤コンテキストで受けたら既存どおりスコープ違反（PROTOCOL_VIOLATION）
- `SetupOptionType.MAX_FILTER_RANGES` / getter default 0 / ピア値 Session 保持。自側 SETUP に MAX_FILTER_RANGES を載せていないこと
- ピア MAX=0（未広告含む）または送信 Range 総数超過で呼び出し側が Range Filter を指定すると **API が throw** すること
- `subscribe()` / `fetch()` / `subscribeTracks()` / `update()` で Range Filter を載せられること
- PUBLISH_OK 応答で、`SubscribeCallbacks` の additive な optional 経由で Range Filter を載せられること（`onPublish` 戻り値型は非破壊）
- `RequestErrorCode.CONFLICTING_FILTERS` / `INVALID_FILTER` が定義され、`normalizeRequestErrorCode` で認識されること
- `CHANGES.md` の `## develop` に `[ADD]` があること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/message/types.ts`: `MessageParameterType` に `0x25`–`0x29`、`SetupOptionType.MAX_FILTER_RANGES = 0x06`
2. `src/message/parameter.ts`: 5 種を `"length-prefixed"` 登録。型 + encode / decode。Length=0・末尾 End 省略・delta。`InvalidFilterError`（または検証結果型）。`decodeParameters` の重複除外。**不正は `ProtocolViolationError` にしない**
3. `src/message/parameterScope.ts`: 上表どおり許可集合を更新。SUBSCRIBE_TRACKS 用は `#0336` の集合があればそこに追加
4. `src/message/setup.ts`: `getSetupMaxFilterRanges`（無ければ `0n`）。**`createSetup` から自側広告は出さない**
5. `src/error.ts` / `src/error.test.ts`: `CONFLICTING_FILTERS = 0x35`、`INVALID_FILTER = 0x36`
6. `src/session.ts` / `src/session/params.ts` / `src/session/bidi.ts`:
   - SETUP 受信でピア MAX をフィールド保持
   - `SubscribeOptions` / `FetchOptions` / tracks options / `RequestUpdateOptions` に Range Filter。送信前ガード（MAX=0 または超過 → **throw**）
   - `SubscribeCallbacks` に `publishOkOptions?`（または同等）を追加し、PUBLISH_OK の `parameters: []` 固定をやめる
   - 受信フィルタ検証失敗 → `REQUEST_ERROR(INVALID_FILTER)`（防御的。REQUEST_UPDATE 常時 OK 経路を分岐）
7. `src/message/index.ts` / 必要なら `src/index.ts`: 型・関数の公開
8. テスト: `parameter.test.ts` / `parameter.prop.ts`、`setup.test.ts`（getter default 0）、スコープ、送信ガード throw、INVALID_FILTER 送出、PUBLISH_OK optional
9. `CHANGES.md`: `[ADD] Range Filters と MAX_FILTER_RANGES Setup Option を追加する`
10. `vp check` / `tsc --noEmit` / `vp test run`
