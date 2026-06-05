# MSF を draft-ietf-moq-msf-01 に追従する

- Priority: High
- Created: 2026-06-05
- Completed: 2026-06-05
- Model: Opus 4.7
- Branch: feature/change-msf-follow-draft-01
- Polished: 2026-06-05

## 目的

`refs/moq/draft-ietf-moq-msf-01.txt` (2026 年 6 月発行) に対し、本リポジトリの `src/msf.ts` は依然として draft-ietf-moq-msf-00 (`* 参照: draft-ietf-moq-msf-00`) を参照している。draft-01 では Catalog の `version` 型・`deltaUpdate` 構造が破壊的に変わり、暗号化 / 認可 / Publish track / Media Timeline Template / MSF_COMPRESSION / MSF URI fragment 等が大量に追加された。本 issue で `src/msf.ts` 及びその利用箇所 (`createMediaPublisher.ts`, `createMediaSubscriber.ts`, `properties.ts`, `devtools/src/hooks/useSubscriber.ts`) を draft-01 仕様へ全面追従させる。

## 優先度根拠

MSF は本リポジトリの中核仕様で、draft-00 のままでは新しい relay や peer と相互運用できない。特に Catalog の `version` 型と `deltaUpdate` ワイヤフォーマットが draft-01 で変更されたため、放置すると delta update を 1 件受信した時点でデコードが破綻する。よって High。

## 現状

- `src/msf.ts:6` に `* 参照: draft-ietf-moq-msf-00`。フィールドコメントの section 番号 (5.1.x) も draft-00 ベース。
- `MSF_VERSION = 1` (`src/msf.ts:14`) を **number** リテラル型として export し、`Catalog.version: typeof MSF_VERSION` (`src/msf.ts:146`) で 1 にロック。
- `CatalogDelta` の内部 TS 型は既に `operations: CatalogDeltaOperation[]` (`src/msf.ts:177-186`、#0068 / #0072 で対応済み、CHANGES.md `## 2026.2.0` L438)。ただし JSON ワイヤフォーマットは draft-00 形式 (`{ "deltaUpdate": true, "addTracks": [...], "removeTracks": [...], "cloneTracks": [...] }`) のままで、`encodeCatalogDelta` / `decodeCatalogDelta` (`src/msf.ts:252-388`) で `Object.keys` 宣言順を operations 順序として保持。重複 `op` 検証 (`src/msf.ts:256-261`) も draft-00 制約由来。
- `PackagingType` (`src/msf.ts:20`) は `"loc" | "mediatimeline" | "eventtimeline"` のみ。
- `CatalogTrack` (`src/msf.ts:39-123`) に `initData?: string` (`src/msf.ts:68`) のみ実装。draft-01 で追加される `publishTracks`, `initDataList`, `initRef`, `buffers`, `template`, `parentNamespace`, `connectionUri`, `token`, `encryptionScheme`, `cipherSuite`, `keyId`, `trackBaseKey`, `authInfo`, `accessibility`, `avgBitrate`, `maxGopDuration`, `maxGroupDuration` は無い。
- `encodeMediaTimeline` / `decodeMediaTimeline` (`src/msf.ts:473-515`) は `options.gzip` 独自 API + gzip magic byte 自動検出を実装 (#0072 で追加、CHANGES.md `## 2026.2.0` L429)。MSF_COMPRESSION (draft-01 §12.1) のシグナリングは行っていない。
- `src/moqtUri.ts:56-79` の `parseFragment` は `type:value` への汎用分割のみで、MSF fragment 専用解析は無い。
- `src/properties.ts` には MSF_COMPRESSION 関連の定義が無い。
- `devtools/src/hooks/useSubscriber.ts:43-58` は `videoTrack.initData` を直接参照して Base64 デコードして `VideoDecoderConfig.description` に展開している。

## draft-00 → draft-01 主要差分

仕様の正本は `refs/moq/draft-ietf-moq-msf-01.txt`。本章は実装影響のあるポイントを MUST / SHOULD / MAY 引用 (英文) 付きで整理する。詳細実装は「設計方針」に集約し、本章では引用のみ。

### 5.1 Root Catalog Fields

- **§5.1.1 `version`** (refs L585-597): JSON Type **String**。
  > A subscriber MUST NOT attempt to parse a catalog version which it does not understand.
  >
  > For usage against IETF Internet-Draft releases, follow the convention of specifying the version as "draft-XX".
- **§5.1.2 `generatedAt`** (refs L599-606):
  > This field SHOULD NOT be included if the isLive field is false.
- **§5.1.3 `isComplete`** (refs L608-628):
  > This field MUST NOT be included if it is FALSE. This field MUST NOT be removed from a catalog once it has been added.
- **§5.1.5 `publishTracks` (新規)** (refs L636-645): subscriber が publish するための track 配列。各エントリは通常 track と同じ構造で `connectionUri` (§5.2.36) / `token` (§5.2.37) を伴う。
- **§5.1.6 `deltaUpdate` の構造変更 (破壊的)** (refs L647-690):
  - 旧 (draft-00 wire): `{ "deltaUpdate": true, "addTracks": [...], "removeTracks": [...], "cloneTracks": [...] }`
  - 新 (draft-01 wire): `{ "deltaUpdate": [ {"op":"add","tracks":[...]}, {"op":"remove","tracks":[...]}, {"op":"clone","tracks":[...]} ] }`
  - 同じ `op` 値を複数回出現可能 (配列順 = 宣言順)。
  - operation 別制約:
    - `remove`: `MUST include a Track Name`, `MAY include a Track Namespace`, `MUST NOT hold any other fields`。
    - `clone`: `MUST include a Parent Name`, `MAY include a Parent namespace`。子 Track Name は new MUST。親属性を継承、redefine で上書き。
  - §5.3 (refs L1552-1577): delta update は `deltaUpdate` フィールドを **最低 1 operation 付きで MUST 含む**、`MUST NOT contain an instance of a Tracks Section 5.1.4 field or an MSF version Section 5.1.1 field`。`The tuple of Track Namespace and Track Name defines a fixed set of Track attributes which MUST NOT be modified after being declared`。
- **§5.1.7 `initDataList` (新規)** (refs L692-719): 初期化データを root に分離した配列。各エントリ `{ id, type, data }`、`type` は `"inline"` (Base64) のみ。トラック側は `initRef` (§5.2.13) で `id` を参照。
  > The Initialization Data List, if present, MUST be located after the tracks array in the root of the JSON catalog.

### 5.2 Track Object Fields

draft-01 で Track Object Fields は §5.1 から **§5.2 に分離**。draft-00 の §5.1.x が大半 §5.2.x にシフト (例: 5.1.11 Track Name → 5.2.3、5.1.20 initData → 5.2.13 initRef + 5.1.7 initDataList、5.1.36 parentName → 5.2.33)。実装時は draft-01 TOC (refs L98-149) を参照して逐次再マップ。

新規追加 / 仕様変更:

- **§5.2.3 Track name** (refs L832-847): `track names MUST be unique per namespace`。
- **§5.2.4 `packaging` Table 4** (refs L856-872): `moqlog`, `moqmetrics` 追加。
- **§5.2.5 `eventType`** (refs L874-886):
  > This field is required if the Section 5.2.4 value is "eventtimeline". This field MUST NOT be used if the packaging value is not "eventtimeline".
- **§5.2.6 `role` Table 5** (refs L908-942): `mediatimeline`, `eventtimeline`, `log`, `metrics`, `signlanguage`, `audiodescription` 追加。
- **§5.2.8 `targetLatency`** (refs L968-985):
  > This property MUST NOT be present if the buffers Section 5.2.9 property is present within a track definition.
- **§5.2.9 `buffers` (新規)** (refs L987-1024): `{ target?, min?, max? }`。
  > This property MUST NOT be present if the target latency Section 5.2.8 property is present within a track definition.
  > Keys are optional. Unknown keys in the target buffer object MUST be ignored.
  > If isLive is FALSE, this target buffer property MUST be ignored. All tracks belonging to the same render group MUST have identical target buffers. All tracks belonging to the same alternate group MUST have identical target buffers.
- **§5.2.13 `initRef`** (draft-00 `initData` を置換): `initDataList` のエントリ id への参照。
- **§5.2.15 `template`** (新規) (refs L1079-1093):
  > A media timeline template for tracks with fixed-duration segments... See Section 7.4 for the complete format specification.
  > Tracks that include a template field SHOULD NOT also have a separate media timeline track.
- **§5.2.23 `avgBitrate`** / **§5.2.24 `maxGopDuration`** / **§5.2.25 `maxGroupDuration`** 新規追加。
- **§5.2.33 `parentName`** (draft-00 同名、節番号のみ変更) と **§5.2.34 `parentNamespace` (新規)** (refs L1253-1268):
  > This field MUST only be included inside a clone operation in a delta update Section 5.1.6.
  > If this field is missing from a clone operation, then the namespace of the catalog is assumed.
- **§5.2.36 `connectionUri` (新規)** (refs L1278-1302):
  > When specified, the subscriber MUST establish a new MOQT connection to this URI for publishing the track data. If this field is absent, the subscriber SHOULD reuse the existing MOQT connection.
  > The URI MUST be a valid MOQT endpoint URI as defined by [MoQTransport] (Sect 3.1.1).
- **§5.2.37 `token` (新規)** (refs L1304-1311): publish track 用の認証トークン。
- **§5.2.38-41 暗号化フィールド (新規)** (refs L1313-1419):
  - `encryptionScheme`: absent = unencrypted, RECOMMENDED = `"moq-secure-objects"`。
  - `cipherSuite`: `MUST be present when encryptionScheme is specified`。`moq-secure-objects` で Table 7 に 3 値 (`aes-128-gcm-sha256` MUST 実装, `aes-128-ctr-hmac-sha256-80` SHOULD 実装, `aes-256-gcm-sha512`)。
  - `keyId`, `trackBaseKey` (Base64): SecureObjects 由来。
- **§5.2.42 `authInfo` (新規)** (refs L1421-1465): `{ "<scheme>": <scheme-config> }`。Registered scheme は `privacy-pass`, `cat` (Table 8)。Custom scheme MUST use Reverse DNS。
- **§5.2.44 `accessibility` (新規)** (refs L1489-1530): `Array<{ scheme, value }>`。Registered scheme は `urn:scte:dash:cc:cea-608:2015`, `urn:scte:dash:cc:cea-708:2015` (Table 9)。

### 5 Catalog Track 全体ルール

§5 (refs L522-542):

> All catalog updates, both independent and delta, MUST be mapped to MOQT sub-group 0. The first Object (with Object ID 0) in any Group in a catalog track MUST hold an independent copy of the catalog. All subsequent Objects within that Group (i.e Objects IDs >= 1) MUST hold a delta update. As soon as an independent update is produced, it MUST be placed at the start of a new Group.
>
> Subscribers accessing the catalog MUST use SUBSCRIBE with a Joining FETCH (offset = 0) in order to obtain the latest complete catalog along with all subsequent catalog objects, including delta updates, that follow.
>
> A producer MAY add additional fields to the ones described in this draft. Custom field names MUST NOT collide with field names described in this draft. A parser MUST ignore fields it does not understand.

### 5.4 Variable Substitution (新規)

§5.4 (refs L1584-1633):

- 変数名は `[A-Za-z0-9_-]+`、**case-sensitive**。
- 値は `[A-Za-z0-9_@-]+` のみ (injection 防止のため `,;\"&` 等は MUST NOT)。
- catalog field values 全体で `%` リテラル MUST NOT (変数参照以外で `%` を出現させない)。
- 変数は **URL fragment 由来**でのみ resolution する。`Query parameters ... MUST NOT be used for variable substitution`。

### 5.5 / §12 MSF_COMPRESSION

§12.1 (refs L3732-3778):

- Track Property (§12.1.1) と Object Property (§12.1.2) を提供。**同一 track での併用 MUST NOT**。
- Compression algorithm 値 (Table 11 / Table 15、refs L3765-3773, L3925-3931): `0 = None`, `1 = GZIP` で確定。
- `All MSF implementations MUST support both uncompressed payloads (value 0 or property absent) and GZIP compressed payloads (value 1)`。
- §14.3 (refs L3887-3897): MSF_COMPRESSION の **Property ID は TBD** (Track Properties registry / Object Properties registry の双方に登録予定)。

### 6 Group / Object numbering

§6.1 / §6.2: Group ID は単調増加 (subsequent は SHOULD increase by 1)。再起動時は previous Group ID より大きい値が **MUST**。本 issue では現状の `createInitialGroupId(Date.now())` / `nextGroupId(+1n)` を維持し、`Date.now()` 解像度 race と Prior Group ID Gap Extension header (SHOULD) は範囲外。

### 7 Media Timeline / 8 Event Timeline

- §7.1.1 explicit entry format: 現状の `MediaTimelineEntry` (`[mediaPts, [groupId, objectId], wallclock]`) と一致。
- §7.2 (refs L2869-2875): `packaging MUST = "mediatimeline"`、`depends` MUST present、`mimeType MUST = "application/json"`。
- §7.3 / §8.3 (refs L2879-2887, L3034-3042): 各 Group の Object 0 は **independent MUST** (累積した全エントリ)、Object 1+ は **incremental MAY** (任意)。
- §7.4 / §7.4.1 (refs L2889-2945): Template Format は 6 要素 JSON Array `[startMediaTime, deltaMediaTime, startLocation, deltaLocation, startWallclock, deltaWallclock]`。`startLocation` / `deltaLocation` は 2 要素 number 配列。`All six values are mandatory and MUST appear in the specified order`。
- §7.4.2 (refs L2956-2961): `Publishers MUST NOT change the template values for a track after the first Object has been published` (publisher 側 MUST、型では enforce 不可)。
- §8.1 (refs L2990-3008): `t` / `l` / `m` のうち **ちょうど 1 つ** MUST。`data` MUST。実装済み (`isEventTimelineEntry` `src/msf.ts:635-678`)。
- §8.2 (refs L3010-3030): packaging MUST = `"eventtimeline"`, `depends` MUST, `mimeType MUST = "application/json"`, `eventType` MUST。

### 11 Workflow / MSF URI fragment (新規)

§11.1 (refs L3287-3411):

- MSF URI: `moqt://authority/path?query#msf:track-identifier&key=value`。
- ABNF: `msf-fragment-value = track-identifier [ "&" parameter-list ]`。track-identifier 内に `&` / `?` MUST NOT (出現時 `%3F` percent-encode)。

§11.1.1 reserved fragment parameters (refs L3421-3500, Table 8): `wallclock-range`, `mediatime-range`, `location-range`, `c4m`, `connection` の 5 種のみ。`connection=q` で raw QUIC、`connection=wt` で WebTransport を **MUST 強制**。

> If multiple ranges are specified within the same URL for the same parameter, the client MUST process the union of those ranges.

§11.1.2 MSF Namespace-Name String Encoding (refs L3504-3539):

- Namespace tuple の各要素を **単一ハイフン (`-`)** で連結。
- Track Name を **二重ハイフン (`--`)** で連結。
- Unreserved (`a-z A-Z 0-9 _`) は literal、その他は **`.HH` (period + lowercase 2 hex digits)** で percent-encode。
- 例: `customer-livestream-123--catalog` ⇒ namespace tuple `('customer', 'livestream', '123')` + track name `'catalog'`。
- 大文字 hex (`.2D`) と RFC 3986 unreserved の `-` / `.` / `~` literal はすべて受信拒否。

§11.2 (refs L3589-3592): `An MSF publisher MUST publish a catalog track object before publishing any media track objects.`

§11.3 / §11.4: 終了シーケンス / Authorization (本 issue では型・doc レベルに留め、制御メッセージへの token 自動付与は「範囲外」)。

### 14 IANA Considerations

- §14.1 `msf` を `MOQT URI Fragment Types` registry に登録。
- §14.2 `MSF Event Timeline Types` registry の初期値: `urn:scte:scte35:2013:bin`, `urn:scte:scte35:2013:xml`, `urn:msf:timedtext:webvtt`, `urn:msf:timedtext:imsc1`。
- §14.3 MSF_COMPRESSION **Property ID は TBD** (algorithm value は §14.4 で確定: `0 = None`, `1 = GZIP`)。

## 設計方針

### 1. section コメントと version 表記の刷新

- `src/msf.ts` 冒頭を `* 参照: draft-ietf-moq-msf-01` に変更し、`grep -nE 'Section |§' src/msf.ts` の全ヒットを draft-01 の節番号 (TOC: refs L98-149) に再マップ。
- 型: `type MsfVersion = "draft-01" | "1"`、`const MSF_VERSION: MsfVersion = "draft-01"` を export。
- `Catalog.version: MsfVersion`。`A subscriber MUST NOT attempt to parse a catalog version which it does not understand` (§5.1.1) に従い、`string` 一般には広げない。
- decode の受理: `const MSF_KNOWN_VERSIONS = new Set<MsfVersion>(["draft-01", "1"])` を新規 export。`"draft-01"` は Internet-Draft 段階の正規表記、`"1"` は draft-01 §5.6.x の non-normative 例 (refs L1648) で使われている将来リリース版を見越した記述で、双方とも round-trip 可能とする。`MSF_KNOWN_VERSIONS` に含まれない値は `Error("invalid catalog: unsupported MSF version '<value>', expected one of [draft-01, 1]")` を throw。encode 時は常に `"draft-01"` を出力。

### 2. `CatalogDelta` のワイヤフォーマット変更

- 内部 TS 型 `CatalogDelta.operations: CatalogDeltaOperation[]` は維持。`CatalogDeltaOperation.type` も rename しない。encode/decode のレイヤーで `{type: "add"} ⇔ {"op": "add"}` をマッピング。
- `decodeCatalogMessage` の delta 判定境界を `Array.isArray(obj["deltaUpdate"])` に変更 (§5.1.6 JSON Type: Array)。`obj["deltaUpdate"] === true` (draft-00 boolean) を含む JSON は `Error("invalid catalog message: deltaUpdate must be an array per draft-01 §5.1.6, got <actual-type>")` で reject。root に `addTracks` / `removeTracks` / `cloneTracks` のキーが存在する場合も同様。
- 未知 `op` 値 (例: `"patch"`, 大文字 `"ADD"`) や `tracks` フィールド欠落の operation を `Error("invalid catalog delta operation: unknown op '<value>'")` / `Error("invalid catalog delta operation: missing tracks array")` で reject。
- `Object.keys` 宣言順依存ロジック (`src/msf.ts:367-376`) と `duplicate operation type` チェック (`src/msf.ts:256-261`) を完全削除。draft-01 では同一 `op` の複数出現が許可される。
- MSF はアプリケーション層なので reject は plain `Error` を throw (MOQT セッション層は閉じない、`ProtocolViolationError` は使わない)。呼び出し側 (`createMediaSubscriber.handleCatalogObject`) は `try/catch` で `onError` 経由で UI 通知し、previous catalog を維持する。

### 3. `applyCatalogDelta` の clone / remove 親探索

signature を `applyCatalogDelta(current: Catalog, delta: CatalogDelta, options?: { catalogNamespace?: string }): Catalog` に変更。

親探索ロジック:

1. 探索キーは `(name, namespace_normalized)` のタプル。`namespace_normalized = track.namespace ?? options.catalogNamespace`。
2. clone 側: `(cloneTrack.parentName, cloneTrack.parentNamespace ?? options.catalogNamespace)` を取り出す。
3. parent 側: tracks 配列の各 track について `(t.name, t.namespace ?? options.catalogNamespace)` を計算し、タプル一致で親を特定する。
4. `options.catalogNamespace` 自体が省略された場合は、両方の namespace が共に未指定の場合のみ一致とする (§5.2.2 「If it is not declared within a track, then each track MUST inherit the namespace of the catalog track」を満たす)。

remove operation の対象探索も同じ正規化を適用する。

既存テスト (msf.test.ts / msf.prop.ts) は `options` 省略で動作中であり、parent / child 双方が namespace 未指定のケースは「両方 undefined → 一致」で従来挙動を維持する。新規追加テストで `options.catalogNamespace` を渡したケース (parent 暗黙継承 + clone parentNamespace 省略 + options.catalogNamespace 指定 で resolve) を検証する。

### 4. 型定義の更新と `ValidationContext`

- `MSF_VERSION` / `MSF_KNOWN_VERSIONS` を string 化。
- `Catalog` に `publishTracks?: PublishTrack[]`, `initDataList?: InitDataEntry[]` を追加。
- `CatalogTrack` から `initData` を削除し、`initRef`, `buffers`, `template`, `avgBitrate`, `maxGopDuration`, `maxGroupDuration`, `parentNamespace`, `encryptionScheme`, `cipherSuite`, `keyId`, `trackBaseKey`, `authInfo`, `accessibility` を optional 追加。
- `PublishTrack = CatalogTrack & { connectionUri?: string; token?: string }`。
- 補助型: `Buffers`, `InitDataEntry`, `AuthInfo`, `AccessibilityDescriptor`, `MediaTimelineTemplate`, `CipherSuite` (string literal union with fallback)。
- `TrackRole` は `"video" | "audio" | "audiodescription" | "caption" | "subtitle" | "signlanguage" | "mediatimeline" | "eventtimeline" | "log" | "metrics" | (string & {})` の literal union (定数 export は不要、型補完で typo 検出)。
- `PackagingType` に `"moqlog"`, `"moqmetrics"` を追加。
- 検証は context-aware: `type ValidationContext = { source: "root" | "publishTracks" | "add" | "remove" | "clone"; catalogNamespace?: string }` を `validateCatalogTrack(track: unknown, ctx: ValidationContext): CatalogTrack` の第二引数に追加。

### 5. `validateCatalog` / `validateCatalogTrack` の責務

旧 `isCatalog` / `isCatalogTrack` / `isRemoveTrack` を `validateCatalog` / `validateCatalogTrack` に格上げし、違反時は track 名や該当フィールド名と実値を含む `Error` を throw。エラー文言は CLAUDE.md「先頭小文字、末尾ピリオドなし、期待値と実際値を含む、簡潔」に従い、プレースホルダー (`<value>`, `<actual-type>`, `<field-name>`) 込みで具体的に記述する。

`validateCatalog(catalog: unknown): Catalog`:

- `version` が `MSF_KNOWN_VERSIONS` に含まれること。
- `isComplete: false` を含む catalog を reject (§5.1.3 MUST NOT include if FALSE)。
- `tracks` 配列内で `(name, namespace_normalized)` タプル uniqueness を検証 (§5.2.3 "track names MUST be unique per namespace")。`publishTracks` 配列内も同じく個別に uniqueness 検証。`tracks` と `publishTracks` の合算 uniqueness は §5.2.3 文面が「unique per namespace」と「track 種別ごと」を明示しておらず、また §5.1.5 で publish track は逆方向データフロー用と定義されているため、本実装では合算しない (subscribe 用 track と publish 用 track の同名共存を許容)。
- 各 track を `validateCatalogTrack(track, { source: "root" or "publishTracks", catalogNamespace: ... })` で検証。
- `initDataList` 内の id が unique であること。
- 未知フィールド (root level) は **ignore** (§5 parser MUST ignore unknown)。「ignore」の実装意味: validation エラーを出さずに `Catalog` 型 cast 時に構造的に残るが、TS 型として named field のみ露出する (`resolveCatalogVariables` も named field のみ走査し、未知フィールド内の変数参照は置換されない)。

`validateCatalogTrack(track, ctx)`:

- `name` / `packaging` / `isLive` の通常 track 必須を検証。publishTracks 内エントリも同じく `isLive` MUST (§5.6.16 例の `isLive` 欠落は draft erratum と判断、Table 3 を厳格採用)。
- `ctx.source === "clone"` のみで `parentName` MUST、`parentNamespace` MAY、子 `name` MUST 存在を検証。それ以外で `parentName` / `parentNamespace` が出現したら reject。
- `ctx.source === "remove"` のみで「`name` MUST + `namespace` MAY + 他フィールド MUST NOT」を検証。違反時 `Error("invalid remove track: unexpected field '<field-name>', remove tracks accept only name and namespace")`。
- `ctx.source === "publishTracks"` のみで `connectionUri` / `token` を許可。それ以外で出現したら reject。
- `targetLatency` と `buffers` の双方向 MUST NOT 併存 (§5.2.8 / §5.2.9)。「present」判定は `obj["buffers"] !== undefined`。違反時 `Error("invalid track '<name>': targetLatency and buffers must not coexist per §5.2.8/§5.2.9")`。
- `packaging === "eventtimeline"` ⇔ `eventType present` 双方向 MUST (§5.2.5)。
- `packaging === "mediatimeline"` の場合 `depends` MUST present、`mimeType === "application/json"` MUST (§7.2)。
- `packaging === "eventtimeline"` の場合 `depends` MUST present、`mimeType === "application/json"` MUST、`eventType` MUST present (§8.2)。
- `cipherSuite` が `encryptionScheme present` 時 MUST present (§5.2.39)。
- `mimeType` (camelCase) のみ受理 (`mimetype` を含めば `Error("invalid track '<name>': use mimeType per draft-01 Table 3, got mimetype")`)。draft-01 §5.6.x 例は non-normative (refs L1648) のため、normative Table 3 の Field Name `mimeType` を採用。
- `template` は 6 要素タプル、各要素の型、配列形状 (内部 2 要素 number 配列) を検証。
- 未知フィールド (track level) は **ignore** (§5 parser MUST ignore unknown)。

検証は MUST 違反のみ throw。decode は throw をそのまま伝播し、partial decode は禁止。

### 6. Initialization Data List の分離 (破壊的)

- `CatalogTrack.initData?: string` を削除。
- `Catalog.initDataList?: InitDataEntry[]` を root に追加。
- `CatalogTrack.initRef?: string` を新規追加。
- `encodeCatalog` の JSON フィールド出力順を `version → generatedAt → isComplete → tracks → publishTracks → initDataList → deltaUpdate` とし、§5.1.7 `MUST be located after the tracks array` を遵守。ECMAScript 仕様 (`JSON.stringify` の挿入順保持) に依拠。実装は `Object.assign` を避け fixed-order object literal で出力する。
- 解決 helper `resolveInitData(catalog: Catalog, track: CatalogTrack): string | undefined` を `msf.ts` から export し、`devtools/src/hooks/useSubscriber.ts` から使う。

### 7. Media Timeline Template

- 型: `type MediaTimelineTemplate = readonly [number, number, readonly [bigint, bigint], readonly [bigint, bigint], number, number];`
- `startLocation` / `deltaLocation` は 64-bit groupId 対応のため **bigint タプル**で保持。decode 時の precision loss 検出:
  1. `Number.isInteger(input)` を満たさない値は `Error("invalid template location: '<value>' is not an integer")` で reject。
  2. `BigInt(input)` 後に `Number(big) !== input` であれば precision loss として `Error("invalid template location: precision loss converting '<value>' to bigint")` で reject。
- decode 後の `Catalog` は `Object.freeze` で再帰的に凍結 (§5.3 attribute immutability にも合致)。§7.4.2 publisher 側 immutable MUST は型では enforce 不可、doc コメントで明記。`applyCatalogDelta` は freeze 済 `Catalog` を入力に取り、内部で配列を spread して新オブジェクトを構築するため既存テストの破壊代入は発生しない (現状実装も `[...current.tracks]` でコピー済み)。

### 8. MSF_COMPRESSION (`src/properties.ts`)

- §14.3 で Property ID が TBD のため、**本 issue では `TrackPropertyId.MSF_COMPRESSION` および Object Property の id 定数を一切定義しない**。`varint` ベースの id 仮値は delta encoding と衝突する可能性が高く、誤った wire 互換性を産むため。
- 唯一 export するのは algorithm value 定数 `export const MsfCompressionAlgorithm = { NONE: 0n, GZIP: 1n } as const`。
- `properties.ts` 冒頭に doc コメント「MSF_COMPRESSION Track/Object Property ID は IANA 未割当 (draft-ietf-moq-msf-01 §14.3)。確定後の追加は別 issue で行う」を残す。
- 関連実装 (Property ID 追加、encode/decode helper、併用検証、subscriber 側自動展開) は「範囲外」セクション参照。

### 9. `encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline` の API 変更 (破壊的)

- `options.gzip` パラメータと gzip magic byte 自動検出 (`isGzipCompressed`) を完全に撤廃。シグネチャを `encode...(entries): Promise<Uint8Array>` / `decode...(data: Uint8Array): Promise<...>` に統一。
- 圧縮機能自体は §12 の MUST に従い維持 (Property ID 確定後に MSF_COMPRESSION 経由で再開放)。本 issue では内部 helper `compressWithGzip` / `decompressWithGzip` は private のまま残し、将来 MSF_COMPRESSION 実装で再利用する旨を doc に残す。`grep -rn "encodeMediaTimeline\|encodeEventTimeline" /Users/voluntas/shiguredo/moqt-js/src /Users/voluntas/shiguredo/moqt-js/devtools/src /Users/voluntas/shiguredo/moqt-js/tests` で確認したところ、msf.ts / msf.test.ts / msf.prop.ts 以外には利用箇所が無い。

### 10. Variable Substitution helper (§5.4)

signature: `resolveCatalogVariables(catalog: Catalog, variables: Readonly<Record<string, string>>): Catalog`

- 変数名: `/^[A-Za-z0-9_-]+$/` (case-sensitive)。
- 値: `/^[A-Za-z0-9_@-]*$/`。違反時 `Error("invalid variable value for '<name>': '<value>' contains disallowed characters per §5.4.1")`。
- 走査対象: `Catalog` 型の **named field** に属する全 string 値 (`tracks[]` / `publishTracks[]` / `initDataList[]` の string 値、`accessibility[].scheme/value`, `authInfo` のキー / string 値、`depends[]` の各要素)。`version` は `MsfVersion` literal 型のため変数置換対象外。number / boolean / `template` 配列内の値 / `buffers` の number 値も対象外。**未知フィールド (例: §5.6.14 で Track Object 内に出現する `c4m`) は `validateCatalogTrack` で ignore されているため Variable Substitution の対象外**。未知フィールドの変数置換対応は範囲外。
- 置換ロジック: 値全体に対し `/%[A-Za-z0-9_-]+%/g` で全 match を置換した後、残った `%` があれば `Error("invalid catalog: literal % at '<field-path>'='<value>' is not allowed per §5.4.1")` を throw。
- 入力 `variables` は URI fragment 由来のみを呼び出し側責務で渡す (query parameter は MUST NOT)。

### 11. MSF URI fragment 解析

- `src/moqtUri.ts` の `parseFragment` は維持。
- 新 helper `parseMsfFragmentValue(value: string): { trackNamespace: string[]; trackName: string; parameters: ReadonlyArray<readonly [string, string]> }` を `src/msf.ts` に追加。`MoqtFragment.value` を入力に取り、`&` で key=value pair 列に分割、`--` で namespace / track name 分離、`-` で namespace tuple 分解、`.HH` lowercase percent-decode を行う。
- literal 文字集合は `[A-Za-z0-9_]` のみ (§11.1.2)。`~` / 大文字 hex (`.2D`) / `&` / `?` を track-identifier に含む入力は `Error` で reject。
- `parameters` は **配列**で順序保持。同一 key (例: 複数の `wallclock-range`) の複数出現を許可 (§11.1.1 union MUST 要件)。
- 本 issue で実装する reserved key helper は `getConnectionParameter(params): "q" | "wt" | undefined` の 1 種のみ (transport 選択判定用、parser として最小)。残り 4 種 (`wallclock-range`, `mediatime-range`, `location-range`, `c4m`) の専用 helper と `connection=q|wt` 適用は範囲外。

### 12. `createMediaPublisher.ts` / `createMediaSubscriber.ts` の追従

- publisher: `createCatalog` / `encodeCatalog` の新型に追従。catalog publish は §5 / §11.2 に従い **subgroup 0、Object ID 0 (independent)、新 Group 開始** を MUST 守る (現状の `sendObject({ groupId: 0, objectId: 0, ... })` の `subgroup: 0n` 明示を確認)。
- subscriber: catalog 受信は SUBSCRIBE + Joining FETCH (offset = 0) を MUST。現状の `createMediaSubscriber.subscribeCatalog` (`createMediaSubscriber.ts:368-382`) で既に `joiningFetch: { type: "absolute", start: 0n, ... }` を使用しているため変更不要だが、§5 MUST 根拠を doc コメントで明記。`handleCatalogObject` の `MSF_VERSION` 比較は文字列。delta update の subscriber サポートは将来課題 (現状実装と同様、本 issue は型 / decode のみ追従)。

### 13. `devtools/src/hooks/useSubscriber.ts` の追従

- `buildVideoDecoderConfig(videoTrack)` を `buildVideoDecoderConfig(videoTrack, catalog)` に変更し、`L549` の呼び出しで `instance.catalog.value` (signal、既に `L429` で保存済み) を渡す。props drilling は不要。
- `L56-57` の `videoTrack.initData` 直接参照を `resolveInitData(catalog, videoTrack)` 経由に置換 (新規 helper を `msf.ts` から import)。
- コメント (`L43-45`) の RFC 引用を draft-01 §5.1.7 / §5.2.13 に更新。

## 範囲外 (別 issue で扱う)

本 issue では以下を実装しない。各項目は仕様根拠と TODO の置き場所を `src/msf.ts` または `properties.ts` のコメントで残し、必要に応じて新規 issue (`issues/SEQUENCE` を消費) を作成する。

- §6.1 Prior Group ID Gap Extension header の MOQT 側 signaling (SHOULD)。`Date.now()` ms 解像度の race / NTP 巻き戻し対策の永続カウンタも同様。
- §9 / §10 Log / Metrics track の payload 生成 (本 issue は catalog 上の declare 型までを対応)。
- §11.4.3 Authorization Token の SUBSCRIBE / SUBSCRIBE_NAMESPACE / FETCH / REQUEST_UPDATE / PUBLISH / PUBLISH_NAMESPACE への MUST 自動付与 (MOQT トランスポート層の追加実装が必要)。
- §11.1.1 `connection=q|wt` による transport 選択の強制適用、および reserved key helper (`wallclock-range` / `mediatime-range` / `location-range` / `c4m`) の解釈実装。
- MSF_COMPRESSION Property ID 確定後の `TrackPropertyId.MSF_COMPRESSION` 追加、`encodeMsfCompression` / `getMsfCompression` helper、Track / Object Property 併用 MUST NOT 検証、`createMediaSubscriber` での `DecompressionStream("gzip")` 自動展開経路。
- 未知 catalog field (例: §5.6.14 で Track Object 内に出現する `c4m`) を Variable Substitution の対象に含める対応 (現状は ignore + 置換対象外)。

## 関連 issue

- **#0072** (closed): Media / Event Timeline の gzip 対応。本 issue で `options.gzip` を撤廃するが、GZIP 圧縮機能そのものは §12 MUST に従い MSF_COMPRESSION 経由で継続提供される。
- **#0068** / **#0070** / **#0071** (closed): CatalogDelta の内部表現を operations 配列にした実装。本 issue は wire format のみ対応。
- **#0302** (open, Medium): `SessionImpl` モジュール分割。`session.ts` は触らないため直接競合しないが、実装順序は本 issue 完了後に #0302 を着手するのが望ましい。

## 完了条件

### コードベース

- `src/msf.ts` 冒頭が `参照: draft-ietf-moq-msf-01` を記述している。
- すべての section 番号コメントが draft-01 の節番号に更新されている (`grep -nE 'Section |§' src/msf.ts` で全件確認)。
- `type MsfVersion = "draft-01" | "1"`、`const MSF_VERSION: MsfVersion = "draft-01"`、`Catalog.version: MsfVersion`、`const MSF_KNOWN_VERSIONS = new Set<MsfVersion>(["draft-01", "1"])` が export されている。
- `CatalogDelta` の wire format encode/decode が `deltaUpdate: Array<{op, tracks}>` 構造に対応し、`decodeCatalogMessage` の delta 判定が `Array.isArray(obj["deltaUpdate"])` に変更されている。
- draft-00 形式の `addTracks` / `removeTracks` / `cloneTracks` キーを含む JSON、`deltaUpdate === true`、未知 `op` 値、`tracks` 欠落 operation は `Error` で reject。
- `decodeCatalogDelta` の `Object.keys` 宣言順依存ロジックと `encodeCatalogDelta` の `duplicate operation type` チェックを撤去 (同一 `op` の複数出現が許可される)。
- `applyCatalogDelta(current, delta, options?: { catalogNamespace?: string })` が `(name, namespace ?? options.catalogNamespace)` のタプル正規化で remove / clone 対象を探索する。`options` 省略時の既存テスト挙動は破壊しない。
- `CatalogTrack` から `initData` を削除、`Catalog.initDataList?: InitDataEntry[]` と `CatalogTrack.initRef?: string` を追加。`encodeCatalog` が JSON フィールド順序 `version → generatedAt → isComplete → tracks → publishTracks → initDataList → deltaUpdate` で出力する。
- 新規 Catalog field (`publishTracks`, `initDataList`, `buffers`, `template`, `encryptionScheme`, `cipherSuite`, `keyId`, `trackBaseKey`, `authInfo`, `accessibility`, `avgBitrate`, `maxGopDuration`, `maxGroupDuration`, `parentNamespace`, `connectionUri`, `token`, `initRef`) が型として定義され、round-trip が PBT で保証されている。
- `PackagingType` に `"moqlog"`, `"moqmetrics"` が含まれる。`TrackRole` が reserved 値 literal union として定義されている。
- `validateCatalog(catalog)` / `validateCatalogTrack(track, ctx: ValidationContext)` が新規導入され、設計方針 5 の MUST/MUST NOT を全て検証する。検証は MUST 違反のみ throw、未知フィールドは ignore (§5 parser MUST ignore unknown 準拠)。
- `tracks` 配列内 / `publishTracks` 配列内でそれぞれ個別に `(name, namespace_normalized)` タプル uniqueness を検証する (§5.2.3)。合算 uniqueness は行わない (subscribe 用と publish 用の同名共存を許容、設計方針 5 参照)。
- `resolveCatalogVariables(catalog, variables)` が `%name%` 置換、変数名 / 値の文字種制約、`%` リテラル禁止を検証する。
- `parseMsfFragmentValue(value)` が `{trackNamespace, trackName, parameters}` を返し、`parameters` は配列で順序保持 (複数 reserved key 出現を許可)。`-` / `--` / `.HH` lowercase percent-decode に従い、不正入力 (`~` literal, 大文字 hex, `&` / `?` in track-identifier) を reject。
- `src/properties.ts` に `MsfCompressionAlgorithm = { NONE: 0n, GZIP: 1n }` が export されている。MSF_COMPRESSION の Property ID 定数は **追加しない** (IANA 未割当のため、別 issue で対応)。
- `encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline` から `options.gzip` パラメータ・gzip magic byte 自動検出を撤廃。
- `resolveInitData(catalog, track): string | undefined` が `msf.ts` から export されている。
- `createMediaPublisher.ts` / `createMediaSubscriber.ts` が新型に追従。
- `devtools/src/hooks/useSubscriber.ts` の `buildVideoDecoderConfig` が `(videoTrack, catalog)` シグネチャに変更され、`instance.catalog.value` を呼び出し時に渡し、`videoTrack.initData` 直接参照を `resolveInitData` 経由に置換。

### テスト

- `src/msf.test.ts` / `src/msf.prop.ts` の `draft-ietf-moq-msf-00` 文字列を全て `draft-ietf-moq-msf-01` に置換し、Section 5.3.x → §5.6.x の対応 (5.3.1 → 5.6.1, 5.3.2 → 5.6.2, 5.3.3 → 5.6.3, 5.3.4 → 5.6.4, 5.3.5 → 5.6.5, 5.3.7 → 5.6.7) を実施。
- 既存の `assert.throws(..., /invalid catalog format/)` 系正規表現マッチを **新エラー文言** (例: `/invalid catalog: unsupported MSF version/`) に書き換え。
- 既存テスト「同一タイプの操作が重複する場合はエンコード時にエラー」(`msf.test.ts:154-164`) を削除し、同じ `op` を複数回出現できることを保証するテストに置換。
- `msf.prop.ts` の `packagingArb` / `roleArb` が draft-01 §5.2.4 Table 4 / §5.2.6 Table 5 の全 reserved 値を網羅する。
- 新規テスト最小セット:
  - `version` が `"draft-01"` で round-trip、`"1"` も decode 受理、`"draft-00"` / number `1` / 未知文字列を reject。
  - delta update wire round-trip: `JSON.parse(encodeCatalogDelta(...))` で各 operation に `op` キーがあり `type` キーが無いことを assert。
  - delta update の `version` / `tracks` 含有、`deltaUpdate === true`、未知 `op`、`tracks` 欠落 operation を reject。
  - `remove` operation の追加フィールド reject、`clone` operation の `parentName` 欠落 reject、`parentNamespace` 省略時の `options.catalogNamespace` 経由継承。
  - `tracks` 配列内の name uniqueness 違反 reject、`publishTracks` 配列内の name uniqueness 違反 reject、`tracks` と `publishTracks` で同名 (subscribe 用と publish 用) の共存は許容することを assert。
  - `targetLatency` + `buffers` 併存 reject、`packaging=eventtimeline` で `eventType` 欠落 reject、非 eventtimeline で `eventType` 含有 reject。
  - `packaging=mediatimeline` で `depends` / `mimeType` 欠落 reject、`packaging=eventtimeline` で同 4 MUST 欠落 reject。
  - `cipherSuite` が `encryptionScheme present` 時に欠落 reject。
  - `mimeType` のみ受理、`mimetype` (lowercase) を reject。
  - `isComplete: false` を含む catalog を reject、`encodeCatalog` が `isComplete === true` 時のみ出力。
  - `initDataList` が `tracks` より後に JSON 出力されることを `encoded` 文字列の `indexOf` で assert。
  - `template` round-trip PBT (Location の bigint 変換 round-trip、`Number.MAX_SAFE_INTEGER + 1` 相当の precision loss を reject)。
  - `resolveCatalogVariables` の文字種制約違反を reject、`%` リテラル単独を reject、正常置換の round-trip。
  - `parseMsfFragmentValue` で `customer-livestream-123--catalog` → `(['customer','livestream','123'], 'catalog')` 分解、複数 `wallclock-range` の順序保持、`~` literal / 大文字 hex / `&` を含む input を reject。

### コマンド

- `vp run test` が pass する。
- `vp run build` が pass する。
- `vp run build:devtools` が pass する。

### CHANGES.md

`## develop` セクションの当該種別 (CHANGE → ADD → UPDATE → FIX) の **末尾** に以下のエントリを追加する。既存エントリ慣例 (タイトル行 + サブ箇条書きで詳細列挙、末尾に担当者) に揃える。

```
- [CHANGE] MSF を draft-ietf-moq-msf-01 に追従する (#0316)
  - draft-ietf-moq-msf-01 §5.1.1 に基づき Catalog version を string 型 (MsfVersion = "draft-01" | "1") に変更する
  - draft-ietf-moq-msf-01 §5.1.6 に基づき deltaUpdate ワイヤフォーマットを operation 配列形式に変更する
  - draft-ietf-moq-msf-01 §5.1.7 / §5.2.13 に基づき CatalogTrack.initData を Catalog.initDataList + CatalogTrack.initRef へ分離する
  - encodeMediaTimeline / encodeEventTimeline の options.gzip パラメータを撤廃する (圧縮機能自体は MSF_COMPRESSION (§12.1) 経由で別 issue 対応)
  - draft-01 Table 3 に基づき mimeType のみ受理し mimetype (lowercase) は拒否する
  - validateCatalog / validateCatalogTrack を新規導入し各種 MUST / MUST NOT を検証する
  - @voluntas
- [ADD] MSF Catalog の draft-01 新規フィールドを追加する (#0316)
  - draft-ietf-moq-msf-01 §5.1.5 / §5.1.7 / §5.2.x に基づき publishTracks, initDataList, buffers, template, parentNamespace, connectionUri, token, encryptionScheme, cipherSuite, keyId, trackBaseKey, authInfo, accessibility, avgBitrate, maxGopDuration, maxGroupDuration を追加する
  - @voluntas
- [ADD] MSF Variable Substitution (§5.4) の解析 helper resolveCatalogVariables を追加する (#0316)
  - @voluntas
- [ADD] MSF URI Fragment Type "msf" (§11.1) の解析 helper parseMsfFragmentValue を追加する (#0316)
  - @voluntas
- [ADD] MSF Compression Algorithm 値定数 MsfCompressionAlgorithm (NONE=0n, GZIP=1n) を properties.ts に追加する (#0316)
  - MSF_COMPRESSION Property ID は draft-ietf-moq-msf-01 §14.3 で IANA 未割当のため別 issue で対応する準備段階の定数
  - @voluntas
```

## 解決方法

### 実装内容

`src/msf.ts` を draft-ietf-moq-msf-01 仕様に追従させる形で全面書き換え (949 行 → 2454 行)。draft-00 との後方互換は維持せず破壊的変更を実施した。

- **型定義**:
  - `MSF_VERSION` を `1` (number) から `"draft-01"` (string) に変更し、`MsfVersion` / `MSF_KNOWN_VERSIONS` を export
  - `Catalog` に `publishTracks` / `initDataList` を追加し、`isComplete` を `true` 限定型に
  - `CatalogTrack` から `initData` を削除し、`initRef` + `Catalog.initDataList` への参照に分離
  - 新規 optional フィールドを追加: `buffers`, `template`, `parentNamespace`, `connectionUri`, `token`, `encryptionScheme`, `cipherSuite`, `keyId`, `trackBaseKey`, `authInfo`, `accessibility`, `avgBitrate`, `maxGopDuration`, `maxGroupDuration`
  - `PackagingType` に `"moqlog"` / `"moqmetrics"` を追加 (Table 4)
  - 補助型: `Buffers`, `InitDataEntry`, `AccessibilityDescriptor`, `AuthInfo`, `MediaTimelineTemplate`, `PublishTrack`, `ValidationContext`
- **encode/decode**:
  - `encodeCatalog`: fixed-order object literal で §5.1.7 「initDataList MUST be located after the tracks array」を遵守。template 内 bigint Location は `assertJsonSafeBigInt` で precision loss / 負数を encode 時に reject
  - `encodeCatalogDelta`: `{deltaUpdate: Array<{op, tracks}>}` の draft-01 wire format を出力。同一 `op` の複数出現を許可。add / clone は `serializeTrackForJson` 経由で template bigint を number 化
  - `decodeCatalogMessage`: `deltaUpdate` フィールドが Array なら CatalogDelta、それ以外は full catalog として `validateCatalog` を呼ぶ。draft-00 boolean 形式 (`deltaUpdate: true`) と root level `addTracks/removeTracks/cloneTracks` を明示 reject
  - `decodeCatalogDelta`: `version` / `tracks` フィールド同梱を §5.3 MUST NOT として reject。`generatedAt` の非 number は validateCatalog と同じく reject (非対称解消)
- **validator (新規)**:
  - `validateCatalog(value)`: §5 全体の MUST/MUST NOT を検証。`tracks` / `publishTracks` 配列内の (name, namespace) uniqueness を Map<namespace, Set<name>> ベースで衝突なく検査。`initDataList` の id uniqueness、`isComplete=false` reject、未知 root フィールド ignore (§5 「parser MUST ignore unknown」)
  - `validateCatalogTrack(value, ctx: ValidationContext)`: ctx.source ("root" | "publishTracks" | "add" | "remove" | "clone") で振る舞いを切り替え。clone 経路は `validateCloneCatalogTrack` に分岐し parentName MUST 化、connectionUri/token/mimetype を MUST NOT reject
  - 検証内容を 10 個の picker 関数 (`pickIdentityFields` 等) と `validatePackagingSpecificRules` に分割。packaging 別の MUST (mediatimeline/eventtimeline の depends/mimeType/eventType) と MUST NOT (eventType ⇔ eventtimeline) を検証
  - `buildValidatedCatalogTrack` 内で `targetLatency` ⇔ `buffers` 排他、`encryptionScheme` 指定時の `cipherSuite` MUST、`trackDuration` の `isLive=true` 時 MUST NOT、`mimeType` のみ受理 (mimetype は混在も含めて reject) を検証
- **applyCatalogDelta**:
  - `options?: { catalogNamespace?: string }` を追加し、(name, namespace ?? catalogNamespace) のタプル正規化で remove / clone 対象を探索
  - `current.isComplete === true` 確定後の add/clone operation は §5.1.3 違反として reject (remove のみ許容)
  - clone 結果に対し parent との name 同一 reject (§5.1.6 「Track Name which MUST be new」)、`targetLatency` ⇔ `buffers` 併存 reject (§5.2.8/§5.2.9)、`validatePackagingSpecificRules` 再実行で MUST/MUST NOT 違反 reject
  - 全 operation 適用後の tracks 配列で `assertTrackNameUnique` を再実行
  - `current.version` を維持 (上書きしない)
- **timeline API**:
  - `encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline` から `options.gzip` パラメータと `isGzipCompressed` (gzip magic byte 自動検出) を完全撤廃 (§12.1 MSF_COMPRESSION 経由に統一予定)
  - `toMsfLocationBigInt` / `assertJsonSafeBigInt` 共通 helper で precision loss / 非整数 / 負数を encode/decode 両側で reject
- **helper (新規)**:
  - `resolveCatalogVariables(catalog, variables)`: §5.4 Variable Substitution。`%name%` 置換、変数名 `[A-Za-z0-9_-]+` / 値 `[A-Za-z0-9_@-]*` の文字種制約、`%` リテラル単独 reject
  - `parseMsfFragmentValue(value)`: §11.1 MSF URI fragment 解析。`--` で namespace tuple / track name 分離、`-` で namespace 要素分解、`.HH` lowercase percent-decode を `TextDecoder("utf-8")` 経由で UTF-8 復元、unreserved 文字集合 `[A-Za-z0-9_]` 違反を reject。`getConnectionParameter` で `connection=q|wt` を抽出
  - `resolveInitData(catalog, track)`: §5.1.7 + §5.2.13 経由で initData を解決
- **properties.ts**: §12.1 / §14.4 Table 15 の `MsfCompressionAlgorithm = { NONE: 0n, GZIP: 1n }` のみ追加。MSF_COMPRESSION の Property ID は §14.3 で IANA 未割当 (TBD) のため定数追加しない
- **publisher / subscriber 追従**:
  - `createMediaPublisher.publishCatalog` に §5 sub-group 0 / Object ID 0 / §11.2 「MUST publish a catalog track object before publishing any media」の MUST 根拠を doc コメントで明記
  - `createMediaSubscriber.subscribeCatalog` に §5 「SUBSCRIBE with Joining FETCH (offset=0)」MUST 根拠を doc 明記
- **devtools 追従**:
  - `buildVideoDecoderConfig(videoTrack, catalog)` シグネチャに変更し、`videoTrack.initData` 直接参照を `resolveInitData(catalog, videoTrack)` 経由に置換
  - `processCatalogObject` に CatalogDelta を skip する delta ガード追加 (full catalog のみ処理)

### テスト

`src/msf.test.ts` を 805 行に拡張し、`src/msf.prop.ts` を 1100 行に拡張 (合計 696 テスト、すべて pass)。

- 単体テスト: 完了条件「テスト最小セット」を全件カバー (version 受理範囲、deltaUpdate wire round-trip、各 MUST/MUST NOT 違反 reject、initDataList JSON 出力順序、template precision loss、resolveCatalogVariables / parseMsfFragmentValue 等)
- PBT: `catalogTrackArb` を draft-01 新規フィールド (template, encryption, authInfo, accessibility) で網羅、`catalogArb` に publishTracks / initDataList を組み込み、CatalogDelta wire round-trip / applyCatalogDelta / resolveCatalogVariables / parseMsfFragmentValue の性質テストを追加
- Date.now() 依存の arbitrary を固定値 `2_000_000_000_000` に置換 (flaky 解消)
- 仕様書例 §5.6.1 / §5.6.2 / §5.6.3 / §5.6.4 / §5.6.5 / §5.6.7 の round-trip を網羅

### 検証

`vp run test`、`vp run build`、`vp run build:devtools`、`vp run lint`、`vp run typecheck` がすべて pass する。

### コードレビューループ (`/review-diff-code`)

5 周回し、各周で並列 6 観点 (バグ / 設計 / 規約 / テスト / 仕様 / 削除候補) のレビュー指摘を全件反映:

- 1 周目: 致命的 5 件 (encodeCatalogDelta の template bigint serialize 失敗、decodeMsfSegment の UTF-8 マルチバイト破壊、applyCatalogDelta が version 上書き、assertTrackNameUnique のキー衝突、validateCloneCatalogTrack で connectionUri/token silent 許可) + 重要 16 件
- 2 周目: 重要 2 件 (encodeCatalog 経路で template bigint precision loss 未検出、applyCatalogDelta clone 結果の packaging 別 MUST 未再検証)
- 3 周目: 重要 2 件 (clone で eventType 継承 + packaging override の MUST NOT 違反、isComplete=true 確定後の add/clone reject 欠落)
- 4 周目: 重要 1 件 (devtools subscriber で CatalogMessage を Catalog として扱う TypeError リスク)
- 5 周目: 致命的+重要 0 件で完了

## PR 粒度

本 issue は draft-01 追従の整合性を保つため 1 PR で実施するが、レビュー負荷軽減のため commit を「型変更」「encode/decode」「validator」「helper 追加 (resolveCatalogVariables / parseMsfFragmentValue)」「devtools 追従」「CHANGES.md」程度に分割する。
