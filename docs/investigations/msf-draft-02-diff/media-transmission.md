# MSF draft-01 → draft-02 差分調査 (Media packaging / Media transmission 担当)

> **決定事項 (本レポートの後に確定)**: draft-01 との互換性は維持しない。
> したがって、本レポートの「互換性影響」欄にある「両方を受ける」「移行期は旧綴りも受理する」
> 「後方互換になる」といった選択肢は採らない。実装時は [README.md](README.md) 冒頭の決定事項を優先する。

## 0. 調査範囲・方法・制約

- 担当範囲は draft-02 §3 (Scope)、§4 (4.1 / 4.1.1 / 4.2 / 4.3 / 4.4)、§6 (6.1 / 6.2 / 6.3)、および media packaging の文脈で必要になる §5.2.5 / §5.2.16 / §5.2.46 の使い方である。フィールド定義そのものの詳細 (型・必須条件・delta update との関係) は catalog 担当の範囲であり、本レポートでは重複を避けて「§4 / §6 から要求される使い方」に限定した。
- 正本は `refs/moq/draft-ietf-moq-msf-02.txt` (5600 行)、比較用は `refs/moq/draft-ietf-moq-msf-01.txt` (4144 行)。行番号はすべてこの 2 ファイルの行番号である。
- 変更点サマリは Appendix A.1 (5337-5507)、特に A.1.2 (5381-5394) を先に読んだ。
- 参考として `refs/moq/draft-ietf-moq-loc-05.txt` の §2.2 / §3 / §4.1 / §4.2 を読み、`refs/moq/draft-ietf-moq-transport-23.txt` の §10.7 / §10.8 / §10.9 / §9.19.9 を確認した。
- 実装は `src/dataStream.ts`、`src/dataStream/{subgroup,datagram,fetch,moqtObject}.ts`、`src/createMediaPublisher.ts`、`src/createMediaSubscriber.ts`、`src/publisher.ts`、`src/session/publish.ts`、`src/session/stream.ts`、`src/mediaSubscriber/{catalogSubscription,trackSubscriptions}.ts`、`src/codec/{types,config,configSupport}.ts`、`src/createMedia/{settings,connect}.ts`、`src/mediaClock.ts`、`src/audioTimestampClock.ts`、`src/groupSwitchGate.ts`、`src/videoDecodeOrder.ts`、`src/videoTrackOutput.ts`、`src/pendingSubgroupBuffer.ts`、`src/filter.ts`、`src/loc.ts`、`src/msf/{types,version,tracks,timeline,catalogTrackValidation,catalogValidation,catalogCodec}.ts`、`src/playout/timeline.ts` を読んだ。
- 「未確認」と書いた箇所は、仕様または実装のどちらかで根拠を確定できなかった箇所である。推測は書いていない。
- draft-01 の節対応: draft-01 §3 (288-361)、§4 (362-489)。draft-01 の §4.3 は Content protection and encryption であり、draft-02 では §4.4 に移動した。draft-01 §6 (2770-2804) に §6.3 は無い。

## 1. 結論サマリ

1. 実装は draft-01 の「each MOQT Object MUST be mapped to a new MOQT Stream」(draft-01 §6) を実装しておらず、Group 単位で 1 本の Subgroup stream を使う「group モード」相当の挙動を既に採っていた。したがってこの要件の撤廃 (MED-04) は実装を壊さず、むしろ適合性が上がる。ただし実装はその「group モード」を catalog でシグナリングしていない (MED-02)。
2. draft-02 の新規 MUST のうち未対応は、§4.1.1 の streamMapping の受信 (両モード対応) (MED-03)、§4.4 の暗号化 object の復号 (MED-13)、§4.3 のマルチバリアント packaging (MED-08) である。
3. 最優先は「draft-02 catalog を 1 件も受理できない」点である。`MSF_KNOWN_VERSIONS` が `draft-01` と `1` のみで、version `draft-02` の catalog は decode で拒否される (MED-01)。media transmission 以前にカタログ段階で止まる。
4. §4.2 Time-alignment は実質変更が無い (「must be provided」→「needs to be provided」の文言変更のみ)。targetLatency の基準変更は §5.2.9 側の変更であり、実装の LOC TIMESTAMP の取り方と整合する。必要なのはコメント・docs の記述更新 (MED-07)。
5. §6.3 Multi-Variant Fast Track Switching は実装に存在しない。`groupSwitchGate.ts` は同一トラック内の Group 間の並べ替えを吸収する機構であり、トラック切替ではない (MED-10)。

## 2. 差分一覧

| ID     | 概要                                                                                          | 区分                  | 優先度    |
| ------ | --------------------------------------------------------------------------------------------- | --------------------- | --------- |
| MED-01 | 受信側が version `draft-02` の catalog を受理できない                                         | 前提 (catalog と重複) | P0        |
| MED-02 | §4.1.1 の `streamMapping` を publisher が送出せず、catalog 型にも無い                         | 新規シグナリング      | P2        |
| MED-03 | §4.1.1 の「subscribers MUST be prepared to consume both」に対する `object` モード受信の成立性 | 新規 MUST             | P1        |
| MED-04 | draft-01 §6「Object ごとに新 Stream」の撤廃                                                   | 撤廃 (実装は適合)     | 変更不要  |
| MED-05 | §4.1 / §6 の「Subgroup 0 に置く SHOULD」と実装の Subgroup ID 決定                             | SHOULD                | P2        |
| MED-06 | §4.2 Time-alignment は文言変更のみ                                                            | 変更なし              | 変更不要  |
| MED-07 | targetLatency の基準が「符号化後」から「エンコーダに入った時刻」へ                            | 意味変更              | P1        |
| MED-08 | §4.3 マルチバリアント向け publisher packaging 要件が新規                                      | 新規 MUST             | P1        |
| MED-09 | `keyframeSpacing` (§5.2.46) を catalog に出せず、値も保証できない                             | 新規フィールド        | P1        |
| MED-10 | §6.3 Multi-Variant Fast Track Switching が新規で未実装                                        | 新規手順              | P1        |
| MED-11 | §6.1 Group numbering は適合だが PRIOR_GROUP_ID_GAP を送出せず、JSDoc の引用が仕様に無い       | SHOULD / 引用         | P2        |
| MED-12 | §6.2 Object Numbering は適合 (変更不要)                                                       | 変更なし              | 変更不要  |
| MED-13 | §4.4 Content protection and encryption が未実装。cipherSuite 必須条件も変更                   | 新規機能 / 条件緩和   | P1        |
| MED-14 | §4.4.4 の暗号化 object 構造 (immutable properties / private properties) に未対応              | 新規機能              | P2        |
| MED-15 | §3 Scope の relay 非依存の記述はクライアント専用方針と整合                                    | 変更なし              | 変更不要  |
| MED-16 | §5.2.5 `packagingMetadata` の一般規則 (key=value、未知キー無視、最初の出現) のパーサが無い    | 新規フィールド        | P1        |
| MED-17 | §5.2.16 template は節番号変更のみ。publisher は生成せず subscriber も使わない                 | 変更なし              | P2 (任意) |
| MED-18 | MSF は Datagram 配送を規定していない (音声の既定配送は仕様の対象外)                           | 確認 (変更不要)       | 変更不要  |

## 3. 差分詳細

### MED-01 受信側が version `draft-02` の catalog を受理できない

- 仕様要件: §5.1.1 は「A subscriber MUST NOT attempt to parse a catalog version which it does not understand.」とし、「For usage against IETF Internet-Draft releases, follow the convention of specifying the version as "draft-XX"」(789-791) と定める。A.1.1 は「Catalog examples were corrected, and they now use "draft-02" as the version string.」(5364-5365) と変更を明記している。
- draft-01 での扱い: 同じ規約で `draft-01`。draft-01 の §5.1.1 本文は draft-02 と同一の文面である (585-601)。
- 現行実装の挙動: `MSF_VERSION = "draft-01"`、`MSF_KNOWN_VERSIONS = {"draft-01", "1"}` (`src/msf/version.ts:22-33`)。`decodeCatalogMessage` は未知 version を例外にする (`src/msf/catalogValidation.ts:46-60`)。したがって draft-02 準拠 publisher の catalog は decode 時点で捨てられ、メディアの購読まで到達しない (`src/createMediaSubscriber.ts:399-421` の `processCatalogPayload` が `kind: "error"` を返す)。
- 必要な変更: encode 側の `MSF_VERSION` を `draft-02` に上げ、decode 側の受理集合へ `draft-02` を追加する。`draft-01` を受理し続けるかは互換方針の判断であり、仕様は「理解できない版を parse してはならない」としか定めていない。
- 互換性影響: encode を `draft-02` にすると draft-01 準拠の購読側は catalog を受理しない可能性がある (同 §5.1.1 の MUST NOT による)。decode の受理追加は後方互換である。
- 優先度: P0。catalog 担当の領域と重複するが、media transmission の前提であるため本レポートにも記載する。

### MED-02 §4.1.1 の `streamMapping` を publisher が送出せず、catalog 型にも無い

- 仕様要件: §4.1.1 (479-529) は「MSF publishers using LOC packaging MUST select one of the mapping modes listed below, and subscribers MUST be prepared to consume both of them. The chosen mode is signaled per-track via the Section 5.2.5 field using the streamMapping key.」(483-486)、「If packagingMetadata is absent, or if it is present but does not carry a streamMapping key, the mode group MUST be assumed.」(524-525)、「Regardless of the selected mode, the mapping of samples to Objects and Groups defined above (one sample per Object, one GOP per Group) is unchanged.」(527-529)。§5.2.5 (1205-1223) は `streamMapping` を packaging 値 `loc` の唯一の定義済みキーとし、「If this key is absent, the value group is assumed.」(1222) とする。
- draft-01 での扱い: §4.1.1 は存在せず、§4.1 に「Samples that belong to the same Group of Pictures (GOP) MUST be placed within the same MOQT Group.」(draft-01 371-372) があるだけである。`packagingMetadata` というフィールドも draft-01 には無い (§4.1.1 が新規であることは A.1.2 の 1 項目目 (5383-5389) に明記)。
- 現行実装の挙動: `CatalogTrack` に `packagingMetadata` が無く (`src/msf/types.ts:100-226`)、`createCatalogTracks` も出さない (`src/createMediaPublisher.ts:2107-2163`)。実装の挙動自体は「group モード」である: 1 Group 内の全 Object を 1 本の Subgroup stream に載せ、Group が変わったときだけ新しい stream を開く (`src/session/publish.ts:226-234`、`src/session/publish.ts:325-326` で `publisherStreams` は track ごとに「現在の Group の stream」1 本だけを持つ)。つまり「MUST select one of the mapping modes」は挙動として満たし、「group が既定」(525) によりシグナリング省略も仕様上は許される。
- 必要な変更: `CatalogTrack.packagingMetadata?: string` を追加し、LOC トラックには `"streamMapping=group"` を明示送出する。decode 側は未知フィールドとして保持はされるが (`src/msf/catalogTrackValidation.ts:117-123`)、型・検証・利用が無いため、パースと利用 (MED-16) が必要。
- 互換性影響: フィールド追加は wire 上は任意フィールドの追加であり、draft-01 購読側は「未知フィールドを無視する」ため影響しない。ただし自前の decode は未知フィールドを保持するので round-trip は壊れない。
- 優先度: P2 (送出は任意。ただし MED-16 のパーサは P1)。

### MED-03 §4.1.1 の「subscribers MUST be prepared to consume both」に対する `object` モード受信の成立性

- 仕様要件: 「subscribers MUST be prepared to consume both of them」(484-485)。`object` モードは「Each MOQT Object is sent in its own MOQT Subgroup.」(516-517)。
- draft-01 での扱い: 両モードの概念が無く、§6 が「each MOQT Object MUST be mapped to a new MOQT Stream」(draft-01 2773-2774) と、むしろ `object` モード寄りの MUST を課していた。draft-02 はこれを撤廃し、既定を `group` に変えた (A.1.2 5383-5389)。
- 現行実装の挙動:
  - 受信路は Group 内の複数 Subgroup を区別して扱える。Subgroup ID は Subgroup Header の SUBGROUP_ID_MODE に従って解決され (`src/session/stream.ts:404-445`)、`object` モードで publisher が Subgroup ID = Object ID を選んだ場合も `resolvedSubgroupId` として解決される。`GroupSwitchGate` は Group ごとに開いている Subgroup を `Set` で保持するため、1 Group に複数 Subgroup が来ることを前提にしている (`src/groupSwitchGate.ts:59-60, 90-114`)。
  - 一方、映像の復号可否は Object ID の連続性で判定する。同じ Group 内で Object ID が飛ぶと `missing-reference` として捨て、次のキーフレームまで待つ (`src/videoDecodeOrder.ts:126-132`)。`object` モードでは Object ごとに別 stream になるため、QUIC の stream 間に順序保証が無く、Group 内の到着順が入れ替わると、その Group の残りを復号できなくなる。`GroupSwitchGate` が保留するのは「より新しい Group の Object」だけで、同一 Group 内の並べ替えは吸収しない (`src/groupSwitchGate.ts:103-113`)。
  - 音声は 1 Object = 1 Group であり (`src/createMediaPublisher.ts:378-405`)、`object` モードでも `group` モードでも同じ wire になる。また既定の音声配送は Datagram であり Subgroup を使わない (`src/createMediaPublisher.ts:2602-2605`)。
- 必要な変更: `object` モードを「受理できる」だけでなく「取りこぼさず復号できる」ようにするには、同一 Group 内の Object 順序の並べ替えを吸収する保留 (Subgroup をまたぐ順序付け) が必要。判断材料としては `Prior Object ID Gap` を使った連続性緩和が既にある (`src/videoDecodeOrder.ts:68-73, 128-132`)。あわせて、catalog の `streamMapping` を読んでモードを認識できるようにする (MED-16)。
- 互換性影響: 受信専用の追加であり、`group` モードの挙動を変えないなら影響は無い。ただし保留を増やすと遅延が増えるため、モードを認識して `object` のときだけ有効化するのが安全。
- 優先度: P1 (仕様は MUST。現状は構造上は受理できるが、並べ替え時に映像が欠ける)。

### MED-04 draft-01 §6「Object ごとに新 Stream」の撤廃 (実装は適合)

- 仕様要件: draft-01 §6 は「Irrespective of the Section 4 in place, each MOQT Object MUST be mapped to a new MOQT Stream.」(draft-01 2773-2774)。draft-02 §6 は「The MOQT Groups and MOQT Objects need to be mapped to MOQT Streams. This mapping is defined by the packaging Section 4 type of each track. Each MOQT Object SHOULD be placed on MOQT Subgroup 0, unless otherwise defined by the packaging type.」(3265-3270) に置き換わった。
- draft-01 での扱い: 上記 MUST。
- 現行実装の挙動: draft-01 の MUST には従っていない。Group 内の 2 件目以降の Object は同じ Subgroup stream に書く (`src/session/publish.ts:226-234` は Group が変わったときだけ新 stream を開き、`src/session/publish.ts:325-326, 361-401` は同じ writer に書き続ける)。映像は Group = GOP 単位で 1 本、音声は 1 Object = 1 Group のため結果的に 1 Object = 1 stream、catalog は 1 Group = 1 Object で FIN する (`src/createMediaPublisher.ts:1994-2000`)。
- 必要な変更: 無し。実装は draft-02 の `group` モードの記述と一致する。LOC draft-05 §4.2 も「one unidirectional QUIC stream is setup to deliver all the encoded video chunks within a MOQT group.」(LOC-05 687-688) としており、実装と一致する。
- 互換性影響: 無し (draft-01 の MUST に従っていなかったことが draft-02 で問題にならなくなった)。
- 優先度: 変更不要。ただしコメントが draft-01 §6 を引いている箇所は言い換えが必要 (`src/createMediaPublisher.ts:922-925, 1820-1822` など §6.1 の引用はそのまま有効)。

### MED-05 §4.1 / §6 の「Subgroup 0 に置く SHOULD」と実装の Subgroup ID 決定

- 仕様要件: §4.1「All MOQT Objects SHOULD be placed on MOQT Subgroup 0 unless streamMapping Section 4.1.1 indicates otherwise.」(470-471)、§6「Each MOQT Object SHOULD be placed on MOQT Subgroup 0, unless otherwise defined by the packaging type.」(3267-3268)。
- draft-01 での扱い: Subgroup に触れる規定は無い (§4.1 は GOP の MUST のみ。draft-01 370-372)。
- 現行実装の挙動: 公開 API に Subgroup ID の指定が無く、`resolveSubgroupForObject` が「その Group で最初に送る Object の Object ID」を Subgroup ID にする (`src/publisher.ts:1050-1056`)。Group の先頭 Object は Object ID 0 なので、通常は Subgroup 0 になる (`src/session/publish.ts:219-224` で Subgroup ID と先頭 Object ID が一致するときは FIRST_OBJ_EXT を使い、Subgroup ID フィールドを送らない)。同じ Group の続きは現在の Subgroup ID を再利用する (`src/publisher.ts:1005-1019`)。
- ずれる条件: ある購読に対して、その Group で最初に送る Object の Object ID が 0 でない場合 (Location Filter で先頭 Object を飛ばして途中から購読した場合など) は Subgroup ID が 0 以外になる。Track 共通の値が既に確定していれば 0 に追従する (`src/publisher.ts:1021-1042`) が、その Group で最初の購読が途中から始まった場合はその Object ID が使われる。
- 必要な変更: `SHOULD` 違反を避けるなら、Group の先頭以外から送り始める場合も Subgroup ID 0 を使う (その場合 FIRST_OBJ_EXT は使えないため EXPLICIT_EXT で 0 を明示する)。
- 互換性影響: 受信側は Subgroup ID を識別子として扱うだけで、0 固定にしても挙動は変わらない (`src/session/stream.ts:404-445`)。Range Filter の SUBGROUP_FILTER を使う購読者には影響し得る (Subgroup ID が評価値になる。`src/publisher.ts:1069-1082`)。
- 優先度: P2 (SHOULD、かつ発生条件が限定的)。

### MED-06 §4.2 Time-alignment は文言変更のみ (変更不要)

- 仕様要件: draft-02 §4.2 (531-563)。
- draft-01 との差分: 節全体を機械的に突き合わせた結果、差分は「an alternate mechanism, not defined by this specification, must be provided to the client」→「needs to be provided to the client」の 1 文のみで、規範要件 (alternate group の同時刻性、等番号 Group の先頭 Object の提示時刻の重なり、group 境界での切替可能性) は同一である。
- 現行実装の挙動: 音声・映像とも LOC TIMESTAMP を壁時計 (Unix epoch マイクロ秒) で送るため、同じ render group のトラックは同じ時間軸に載る (`src/mediaClock.ts:44-49, 66-83`、`src/audioTimestampClock.ts:1-33`、`src/playout/timeline.ts:1-30`)。`alternate group` を catalog に出す機能自体が無いため、§4.2 の 1 つ目の MUST (common alternate group のトラックは time-aligned) は現状の発動条件が無い。
- 必要な変更: 無し。
- 優先度: 変更不要。

### MED-07 targetLatency の基準が「符号化後」から「エンコーダに入った時刻」へ

- 仕様要件: §5.2.9「Target latency is defined as the offset in wallclock time between when content entered the encoder and when it is displayed to the end user.」(1361-1364)。draft-01 §5.2.8 は「between when content was encoded and when it is displayed」(draft-01 972-975)。A.1.3 は「targetLatency and timeline wallclock values are now defined relative to when content entered the encoder.」(5455-5457) と変更を明記。wallclock の定義は §11.6 (4564-4573、Unix epoch ミリ秒、UTC 同期 SHOULD)。
- draft-01 での扱い: 符号化された時刻が基準。
- 現行実装の挙動: publisher は LOC TIMESTAMP に「フレームを読んだ時点の壁時計」を使う。映像は `observe(frame.timestamp, performance.timeOrigin + performance.now())` で読んだ時刻との対応を取り (`src/createMediaPublisher.ts:2419-2421`)、符号化出力の timestamp をその対応で壁時計へ換算する (`src/createMediaPublisher.ts:2686-2699`)。音声も読み出した壁時計との差の最小値で原点を合わせる (`src/createMediaPublisher.ts:2304-2309, 2536-2543`)。いずれも encode の入力側の時刻であり、draft-02 の「entered the encoder」に一致する。subscriber は targetLatency を「2 つのトラックの表示の遅れの下限」として使い (`src/playout/timeline.ts:768-778`、`src/playout/timeline.ts:399-403`)、`isLive` が false の値は無視する (`src/msf/tracks.ts:138-148`)。
- 必要な変更: 実装の計算は変更不要。コメントと docs の文言を「符号化から表示まで」から「エンコーダに入った時刻から表示まで」へ直す (`src/codec/types.ts:304-312`、`src/playout/timeline.ts:4`、`docs/MEDIA_PLAYOUT.md:245` 付近、`docs/HIGH_LEVEL_API.md:115`)。あわせて §11.6 の UTC 同期 SHOULD はブラウザ実装では利用者の時計に依存するため、その旨を docs に書く余地がある。
- 互換性影響: 意味の解釈のみで wire は変わらない。draft-01 の「符号化後」基準で targetLatency を決めていた運用では、同じ値がわずかに「長い遅延」を意味するようになる (エンコード時間の分)。実装は元から入力側の時刻を使っているため、実測の表示遅延は変わらない。
- 優先度: P1 (docs / コメントの必須更新。実装変更は無し)。

### MED-08 §4.3 マルチバリアント向け publisher packaging 要件が新規

- 仕様要件: §4.3 (565-587)。alternate group 内で keyframe 間隔が異なるトラックを出す場合、(1)「Each MOQT Group MUST start with a keyframe. Publishers MUST NOT place multiple keyframes within a single group」(571-573)、(2)「All tracks within an alternate group MUST be time-aligned at object boundaries, not only at group boundaries.」(575-576)、(3)「The keyframeSpacing Section 5.2.46 catalog field MUST be specified for each track」(578-580)、(4)「The starting Group ID of all tracks within an alternate group MUST be identical. The GroupID of each subsequent group MUST increase by 1.」(582-584)。
- draft-01 での扱い: この節自体が無い (draft-01 §4.3 は Content protection)。A.1.2 が「Added Multi-Variant Fast Track Switching. This consists of publisher packaging requirements (Section 4.3) and a subscriber switching procedure with switch-point calculation (Section 6.3), and enables switching between alternate tracks with dissimilar keyframe intervals.」(5390-5394) と新規を明記。
- 現行実装の挙動:
  - (1) 映像はキーフレームで新しい Group を開始するため、Group の先頭はキーフレームであり、Group 内に複数のキーフレームは入らない (`src/createMediaPublisher.ts:420-434`、呼び出し `2637-2652`)。キーフレーム要求は時間間隔で決める (`src/createMediaPublisher.ts:497-506`、既定 2 秒 `src/createMediaPublisher.ts:455-467`)。ただし初回出力が delta だった場合は Group が delta で始まり得る (コードのコメント自身が `src/createMediaPublisher.ts:410-414` で言及)。
  - (2) 時間整合は LOC TIMESTAMP が壁時計であることによる。object 境界での整合を保証する仕組みは無い。
  - (3) `keyframeSpacing` を出していない (MED-09)。
  - (4) 開始 Group ID はトラックごとに独立に払い出す。`allocateInitialGroupId` は共有ガード `maxGroupIdSeen` を使って単調性を守るため、音声と映像で異なる値になる (`src/createMediaPublisher.ts:287-317, 926-927`)。`altGroup` を catalog に出す機能自体が無い (`src/createMediaPublisher.ts:2107-2163` に `altGroup` の指定が無く、`MediaPublisherOptions` にも無い `src/codec/types.ts:300-320`)。
- 必要な変更: マルチバリアント配信を行う場合、(a) `altGroup` を指定できる API、(b) alternate group 内で開始 Group ID を揃える仕組み (トラック間で共通の開始値と +1 の歩調)、 (c) `keyframeSpacing` の送出、(d) object 境界での時間整合の保証、が必要。単一バリアント配信のみなら §4.3 の適用条件 (alternate group 内に複数トラック) を満たさないため、現状でも違反ではない。
- 互換性影響: 新規 API の追加であり、既存の単一バリアント配信には影響しない。ただし開始 Group ID をトラック間で揃える変更は、既存の「トラックごとに独立に払い出す」挙動を変えるため、既存のテスト (`src/createMediaPublisher.test.ts:4108-4170`) に影響する。
- 優先度: P1 (ABR / マルチバリアントを提供するなら P0)。

### MED-09 `keyframeSpacing` (§5.2.46) を catalog に出せず、値も保証できない

- 仕様要件: §5.2.46「A number defining the number of objects per keyframe interval. A value of 15 means each group contains a keyframe followed by 14 predicted frames (15 objects total).」(1965-1969)、「This field is used by subscribers to calculate valid switch points when performing adaptive bitrate switching between tracks with different keyframe intervals.」(1971-1974)。§4.3 が alternate group 内の各トラックに MUST で要求 (578-580)。
- draft-01 での扱い: フィールドが存在しない (draft-01 に `keyframeSpacing` は無い)。`maxGopDuration` は存在するが意味が違う (ミリ秒の最大 GOP 長。draft-02 では §5.2.25 に移動、1576-1580)。
- 現行実装の挙動: `CatalogTrack` に `keyframeSpacing` が無く (`src/msf/types.ts:100-226`)、`maxGopDuration` も送出していない (`src/createMediaPublisher.ts:2146-2160`)。値の保証も無い: キーフレームは経過時間で決まり (`src/createMediaPublisher.ts:497-506`)、送信負荷で落としたフレームは Object として数えない (`src/createMediaPublisher.ts:2428-2455`) ため、1 Group あたりの Object 数は一定にならない。
- 必要な変更: `keyframeSpacing?: number` を `CatalogTrack` に追加し、publisher が実際の「1 Group の Object 数」を一定に保てるようにする (フレーム数ベースの間隔に変える、または落としたフレームを Object として数える)。subscriber は MED-10 の計算に使う。
- 互換性影響: フィールド追加は任意フィールドであり、既存の対向に影響しない。値の保証をフレーム数ベースに変えると、既存の `keyframeInterval` (秒) の意味が変わるため API 設計の判断が必要 (`src/codec/types.ts` の `VideoPublishOptions.keyframeInterval`)。
- 優先度: P1。

### MED-10 §6.3 Multi-Variant Fast Track Switching が新規で未実装

- 仕様要件: §6.3 (3293-3307) は「This section specifies how a subscriber switches between tracks within an alternate group that have dissimilar keyframeSpacing values. Publishers MUST package such tracks as described in Section 4.3.」。§6.3.1 (3309-3316) は「a subscriber SHOULD first subscribe to the track with the closest switch point that satisfies the bandwidth constraints. Once playback begins, the subscriber MAY switch to a track with a larger keyframeSpacing at a valid switch point」。§6.3.2 (3318-3328) は「Given a source track with keyframeSpacing S and a target track with keyframeSpacing T, a switch from Group ID G and Object ID N of the source track is valid if: (G * S + N) / T yields an integer. That integer is the Group ID in the target track at which the subscriber begins receiving objects, starting at Object ID 0.」
- draft-01 での扱い: 節が存在しない (§6.2 で終わり)。
- 現行実装の挙動: トラック切替の機能が無い。購読側は catalog の role で候補を絞り、名前一致が無ければ先頭の候補を 1 つだけ購読する (`src/mediaSubscriber/catalogSubscription.ts:561-575`、role 絞り込みは `src/mediaSubscriber/catalogSubscription.ts:385-396`)。`altGroup` を選択に使う関数はあるが (`src/msf/tracks.ts:69-72, 283-314`)、静的な選択であって切替ではない。`groupSwitchGate.ts` は同一トラック内の Group 間の並べ替えを吸収する機構であり (`src/groupSwitchGate.ts:1-27`)、トラック切替とは無関係。`videoDecodeOrder.ts` も同一トラック内の Group / Object 順序の判定である (`src/videoDecodeOrder.ts:1-24`)。
- 低レベル API 側の材料: 特定の Group から受信を開始するには SUBSCRIBE の Location Filter (絶対開始) が使える (`src/session/publicTypes.ts:682-705` の `{ startGroup, startObject }`)。ただし高レベルの購読はフィルタを渡していない (`src/mediaSubscriber/trackSubscriptions.ts:270-280`)。
- 必要な変更: (a) catalog の `streamMapping` / `keyframeSpacing` / `altGroup` を読む、(b) 現在再生中の (Group ID, Object ID) を取得する (復号入力の記録として位置は既に保持している `src/createMediaSubscriber.ts:2999-3007`)、(c) §6.3.2 の式で切替先 Group ID を計算する、(d) 切替先トラックを `{ startGroup, startObject: 0 }` で購読し、復号器と再生の時間軸を引き継ぐ、(e) 旧トラックの購読を終了する、という手順が必要。既存の高レベル API にはこの経路が無い。
- draft-23 との整合: §6.3.2 の「begin receiving objects starting at Object ID 0」は、draft-23 の SUBSCRIBE Location Filter の絶対開始 (§9.19.9 の 0x02) で表現できるため、transport 仕様と矛盾しない。各 Group がキーフレームで始まる (§4.3) ため、Group 先頭から購読すれば復号を開始できる。矛盾すると確認できた点は無い。
- 互換性影響: 新機能の追加であり、既存の単一トラック購読には影響しない。
- 優先度: P1 (ABR を提供するなら P0)。§6.3.1 の SHOULD / MAY は購読側の行動であり、`MAY` を使わない実装は仕様違反ではない。ただし §4.3 の publisher 要件は MUST であるため、alternate group を出すなら MED-08 と同時に対応する必要がある。
- 未確認: §6.3.1 の「switch to a track with a larger keyframeSpacing」と §6.3.2 の式 (任意の S, T) の関係について、仕様は式の適用方向を明示していない。下り方向 (より小さい keyframeSpacing への切替) を禁じているとは読めないが、明示の記述は無い。

### MED-11 §6.1 Group numbering は適合だが PRIOR_GROUP_ID_GAP を送出せず、JSDoc の引用が仕様に無い

- 仕様要件: §6.1 (3272-3286)「Group IDs for a track MUST be unique and MUST increase monotonically. Within a continuous publishing session, each subsequent Group ID SHOULD increase by 1.」(3274-3276)、「When a publisher restarts ... it MUST ensure the new starting Group ID is greater than any previously published Group ID for that track. One approach is to use the current wall clock time in milliseconds since the Unix epoch as the starting Group ID.」(3278-3282)、「If a publisher maintains state across a restart and knows the previous Group ID, it SHOULD signal the gap using the PRIOR_GROUP_ID_GAP property [MOQT], Section 10.8.」(3284-3286)。
- draft-01 との差分: draft-01 §6.1 は最後の文が「the MOQT Prior Group ID Gap Extension header」(draft-01 2788-2790) であり、draft-02 は property に改名した (A.1.1 の「the PRIOR_GROUP_ID_GAP property replaces the Prior Group ID Gap extension」5359-5361)。規範内容は同一。
- 現行実装の挙動: `allocateInitialGroupId` が「壁時計 (Unix epoch ミリ秒)」と「プロセス内の送信済み最大値 + 1」の大きい方を開始 Group ID にする (`src/createMediaPublisher.ts:303-317`、`src/msf/tracks.ts:218-220`)。再開時の MUST を満たす。連続中の増加は +1 (`src/createMediaPublisher.ts:397-404, 424-433`、catalog の送り直しは `src/createMediaPublisher.ts:2047-2049`)。PRIOR_GROUP_ID_GAP は media publisher からは送っていない (`src/publisher.ts` と `src/session/publish.ts` に `priorGroupIdGap` の送出経路が無い。property 自体の encode/decode は `src/properties.ts:334, 1060-1091, 1610-1625` に存在する)。
- 引用の誤り: `src/msf/tracks.ts:213-217` は「The Group ID of the first Group published in a track at application startup MUST be a unique integer that will not repeat in the future.」を draft-01 §6.1 として引用しているが、この文は draft-01 §6.1 (draft-01 2776-2790) にも draft-02 §6.1 (3272-3286) にも存在しない。また `src/msf/tracks.ts:225` は「Each subsequent Group ID MUST increase by 1.」と MUST で書いているが、仕様は「SHOULD increase by 1」(3276)。
- 必要な変更: (a) 再開時に gap を通知するなら `PRIOR_GROUP_ID_GAP` を Object Properties として送出する経路を publisher に追加する (SHOULD)、(b) JSDoc の引用を仕様の文面に合わせる。
- 互換性影響: (a) は追加の property であり、受信側は未知 property として無視できる。ただし draft-23 §10.8 は「A Group contains more than one Object with different values for Prior Group ID Gap」を malformed とするため、Group 内で同じ値を送る必要がある。
- 優先度: P2。

### MED-12 §6.2 Object Numbering は適合 (変更不要)

- 仕様要件: §6.2「Object ID MUST be zero for the first Object within a Group and then MUST increase monotonically by one within that Group.」(3288-3291)。draft-01 §6.2 と同一文面 (draft-01 2794-2795)。
- 現行実装の挙動: 映像はキーフレームで Object ID を 0 に戻し、以降 1 ずつ増やす (`src/createMediaPublisher.ts:420-434`)。音声は常に Object ID 0 (`src/createMediaPublisher.ts:393-405`)。catalog は Object ID 0 のみ (`src/createMediaPublisher.ts:1994-2000`)。落としたフレームは Object として数えないため、Object ID は「送った Object」に対して連続であり、番号の飛びは生じない (`src/createMediaPublisher.ts:2428-2455`)。
- 必要な変更: 無し。
- 優先度: 変更不要。

### MED-13 §4.4 Content protection and encryption が未実装。cipherSuite 必須条件も変更

- 仕様要件: §4.4 (589-595) は LOC の payload を暗号化し、relay は平文のヘッダ情報で配送できるとする。§4.4.1 (597-623) は catalog の track-level フィールド (`encryptionScheme` §5.2.38 / `cipherSuite` §5.2.39 / `keyId` §5.2.40 / `trackBaseKey` §5.2.41) でシグナリングし、「When the encryptionScheme field is present in a track definition, subscribers MUST decrypt the object payload using the specified scheme before processing.」(621-623)。§4.4.3 (645-659) は `moq-secure-objects` を RECOMMENDED とし、その場合 `cipherSuite` / `keyId` / `trackBaseKey` の 3 つを MUST とする。
- draft-01 との差分: 節番号が §4.3 → §4.4 に移動。A.1.3 は「cipherSuite is now required only when encryptionScheme is "moq-secure-objects".」(5452-5453) と条件を緩和した。draft-01 §5.2.39 は「MUST be present when encryptionScheme is specified」(draft-01 1350-1351) であり、任意の scheme で必須だった。
- 現行実装の挙動: catalog のフィールド型と検証はある (`src/msf/types.ts:209-219`、`src/msf/catalogTrackValidation.ts:285-300`)。ただし検証は draft-01 の条件のままで、`encryptionScheme` があれば `cipherSuite` を必須にしている (`src/msf/catalogTrackValidation.ts:296-299`)。暗号化・復号の実行は無い: publisher は payload をそのまま送り (`src/createMediaPublisher.ts:2574-2605, 2701-2713`)、subscriber は受信 payload をそのまま復号器へ渡す (`src/createMediaSubscriber.ts:3010`)。関連 issue も pending のままである (`issues/pending/0354-add-msf-secure-objects-encryption.md`)。
- 必要な変更: (a) `cipherSuite` 必須条件を「`encryptionScheme === "moq-secure-objects"` のときだけ」に緩和する (これをしないと、custom scheme を使う draft-02 catalog を誤って拒否する)、(b) subscriber は `encryptionScheme` があるトラックを「復号できない」と認識して明示的に失敗させる (現状は暗号文を復号器へ渡して復号エラーになる)、(c) 実装するなら §4.4.4 の構造 (MED-14) に従う。
- 互換性影響: (a) は検証の緩和であり後方互換。ただし「cipherSuite の無い encryptionScheme を受理する」ことは draft-02 では正しいが、draft-01 準拠の対向に対しては緩い検証になる。
- 優先度: P1 ((b) は誤動作の防止として実装コストが小さい。(c) は Secure Objects 仕様の取得が前提)。

### MED-14 §4.4.4 の暗号化 object 構造 (immutable properties / private properties) に未対応

- 仕様要件: §4.4.4 (661-681)「The immutable object properties (including Group ID and Object ID) remain in plaintext and are authenticated」(666-667)、「The object payload is encrypted and authenticated using the specified cipher」(677-678)、「Private object properties (type 0xA) are encrypted alongside the payload」(680-681)。draft-01 §4.3.4 は「immutable header extensions」「Private header extensions (type 0xA)」という用語だった。
- draft-01 との差分: 用語が header extension → object property に変わった (draft-23 の用語変更。A.1.1 5350-5352)。規範内容は同一。
- 現行実装の挙動: Immutable Properties (type 0xB) の encode / decode は実装済み (`src/properties.ts:329, 1310-1431, 1639-1652`)。draft-23 §10.7 の object 構造 (平文の Object Header + Immutable Properties、payload 内に Private Properties) は仕様側に存在する (`refs/moq/draft-ietf-moq-transport-23.txt:6053-6118`)。Private Properties (type 0xA) の扱いは無い (`src/properties.ts` に 0x0A の定義が無い)。LOC 側は private properties に TIMESTAMP / AUDIO_LEVEL / VIDEO_FRAME_MARKING / VIDEO_CONFIG を載せ得るとする (LOC-05 §3.1.3 (526-543))。
- 必要な変更: 暗号化を実装する場合、(a) LOC Properties を Immutable Properties として包む経路、(b) payload と private properties の連結・分離、(c) 認証付きデータ (AAD) の組み立てが必要。LOC-05 §3.1.5 は AAD に Key ID / Group ID / Object ID / Track namespace と name / serialized immutable properties を含めるとする (LOC-05 575-583)。
- 互換性影響: 暗号化しないトラックには影響しない。
- 優先度: P2 (MED-13 の後続)。

### MED-15 §3 Scope の relay 非依存の記述はクライアント専用方針と整合 (変更不要)

- 仕様要件: §3 (376-460) は「An MOQT relay can process the announcement as well as cache and propagate the tracks, both to other relays or to the final subscriber.」(397-399) と relay の役割を挙げる一方、A.1.1 は「clarify that relays do not need to understand MSF」(5341-5343) と補足する。in-scope の列挙に「Content encryption」(436) と「ABR between time-synced tracks」(438-440) が含まれる。
- draft-01 との差分: 参照名が `[MoQTransport]` → `[MOQT]`、latency の箇条書きの入れ子構造が変わったのみで、規範内容に変更は無い (機械 diff で確認)。
- 現行実装の挙動: moqt-js はクライアント専用であり relay 機能を持たない。`README.md` は publisher / subscriber 用途を掲げ (`README.md:30-48` 付近)、`docs/MSF.md:16` は catalog 取得を `subscribe()` + `fetch()` の 2 リクエストで代替する実装上の判断を記録している。§3 が relay に MSF の理解を要求しないことは、relay を実装しない本方針と矛盾しない。
- 必要な変更: 無し。
- 優先度: 変更不要。

### MED-16 §5.2.5 `packagingMetadata` の一般規則のパーサが無い

- 仕様要件: §5.2.5 (1205-1223)「Additional parameters for the Section 5.2.4 value in use, encoded as a semicolon-separated list of key=value pairs (e.g. key1=v1;key2=v2). Keys and values are case-sensitive and MUST NOT contain whitespace, = or ;.」(1209-1212)、「Subscribers MUST ignore any key that is not defined for the current packaging value. If the same key appears more than once, the first occurrence is used.」(1214-1217)、`loc` で定義されるキーは `streamMapping` のみ (1221-1223)。
- draft-01 での扱い: フィールドが存在しない。
- 現行実装の挙動: `packagingMetadata` という名前は実装に一切無い。decode 時、未知の track フィールドはそのまま保持される (`src/msf/catalogTrackValidation.ts:117-123`) が、型 (`src/msf/types.ts:100-226`)・検証・利用のいずれも無い。したがって「MUST ignore any key that is not defined」は結果的に満たすが、「streamMapping を読む」ことができない。
- 必要な変更: `packagingMetadata?: string` の型追加、`key=value` のパーサ (大文字小文字は区別、空白・`=`・`;` を含む値は不正、同一キーは最初の出現を採用、未定義キーは無視)、`loc` 用の `streamMapping` の解釈。
- 互換性影響: 追加のみ。既存の catalog は `packagingMetadata` を持たないため、既定値 `group` で動く。
- 優先度: P1 (MED-03 の前提)。

### MED-17 §5.2.16 template は節番号変更のみ。publisher は生成せず subscriber も使わない

- 仕様要件: §5.2.16 (1480-1493) は「A media timeline template for tracks with fixed-duration segments. It specifies the relationship between media time, MOQT Location, and wallclock time through starting points and intervals. See Section 7.4」(1482-1487) とし、§7.4.2 は「Publishers MUST NOT change the template values for a track after the first Object has been published.」(3521-3524)。
- draft-01 との差分: draft-01 では §5.2.15 (draft-01 1079-1093)。本文は同一で、章番号だけが 1 つ繰り上がった。
- 現行実装の挙動: catalog の `template` として型・検証・encode/decode がある (`src/msf/types.ts:59-89, 146-147`、`src/msf/catalogTrackValidation.ts:611-686`、`src/msf/catalogCodec.ts:150-174`)。一方、`createCatalogTracks` は `template` を生成せず (`src/createMediaPublisher.ts:2107-2163`)、subscriber は `template` を再生に使わない (`src/playout/timeline.ts` に `template` の参照が無い)。`src/msf/timeline.ts` は明示形式の media timeline の encode/decode のみを持つ (同ファイル 1-222)。
- 必要な変更: 無し (任意機能)。§4 / §6 の要件ではない。
- 優先度: P2 (任意)。`docs/IMPLEMENTATION_STATUS.md` には「template」の記載があるが、生成しないことは明記されていない。

### MED-18 MSF は Datagram 配送を規定していない (確認、変更不要)

- 仕様要件: draft-02 の全文に `datagram` の記述が無い (§4.1.1 と §6 は MOQT Stream への写像のみを定義する)。draft-01 にも無い。
- 現行実装の挙動: 音声の既定配送は Datagram (`src/createMediaPublisher.ts:2602-2605`、`src/codec/types.ts` の `AudioDelivery`)。LOC draft-05 §4.1 は「These objects can be sent as QUIC streams or datagrams.」(LOC-05 655-660) と Datagram を許す。
- 判定: MSF §4.1.1 / §6 の対象外であるため仕様違反ではない。ただし §4.1 の「All MOQT Objects SHOULD be placed on MOQT Subgroup 0」は Subgroup を持たない Datagram には適用されない。
- 優先度: 変更不要 (docs に「MSF は Datagram を規定しない」旨を書く余地はある)。

## 4. 指定論点の判定

1. **§4.1.1 が新規であること / `streamMapping` の所在**: 新規である (A.1.2 5383-5389)。所在は catalog の track-level フィールド `packagingMetadata` (§5.2.5) の中の `key=value` であり、packaging 値でも packagingMetadata そのものでも track property でもない (Table 1 は「signaled via `packagingMetadata`」521-523)。値は `group` (既定) と `object` (510-519)。実装は `group` モード相当で、Datagram を使う音声以外は 1 Group 1 Subgroup である (`src/session/publish.ts:226-234`)。subscriber の両モード対応は MED-03。
2. **draft-01 の「each Object を新しい MOQT Stream にマップする」撤廃**: 撤廃された (draft-01 2773-2774 → draft-02 3265-3270)。実装はこの MUST に依存していない (もともと Group 単位で stream を共有している `src/session/publish.ts:226-234`)。したがって撤廃による破壊は無い (MED-04)。
3. **「Objects SHOULD be placed on Subgroup 0」と実装の Subgroup ID 選択**: §4.1 (470-471) と §6 (3267-3268)。実装は「その Group で最初に送る Object の Object ID」を Subgroup ID にするため (`src/publisher.ts:1050-1056`)、通常は 0、Group 途中から購読を始めた場合は 0 以外になり得る (MED-05)。公開 API に Subgroup ID の指定は無い。
4. **§4.2 の変化と時刻基準**: §4.2 自体は文言のみの変更 (MED-06)。targetLatency の基準は §5.2.9 で「符号化後」から「エンコーダに入った時刻」に変わった (MED-07)。実装の時刻基準は、publisher が「フレームを読んだ壁時計」を LOC TIMESTAMP の基準にし (`src/createMediaPublisher.ts:2419-2421, 2686-2699`)、音声も読み出し壁時計との差で原点を合わせる (`src/createMediaPublisher.ts:2304-2309, 2536-2543`)。subscriber の再生は LOC TIMESTAMP + 基準の遅れ + 表示の遅れで決め (`src/playout/timeline.ts:1-30`)、targetLatency を表示の遅れの下限に使う (`src/playout/timeline.ts:768-778`)。draft-02 の基準と整合しており、コメント / docs の更新が主。
5. **§4.3 の publisher packaging 要件**: 新規 (§4.3 全体)。keyframe 開始と単一キーフレームは映像の Group 採番で満たす (`src/createMediaPublisher.ts:420-434`)。`keyframeSpacing` は未実装 (MED-09)。`altGroup` / 開始 Group ID の一致は未実装で、開始 Group ID はトラックごとに独立 (MED-08)。`maxGopDuration` は送出していない。
6. **§6.3 の切替手順と switch point 計算**: 新規 (§6.3 全体)。実装にトラック切替は無く (`src/mediaSubscriber/catalogSubscription.ts:561-575` は 1 トラックを選ぶだけ)、`groupSwitchGate.ts` / `videoDecodeOrder.ts` は同一トラック内の順序制御である (MED-10)。draft-23 の SUBSCRIBE Location Filter (絶対開始) で切替先 Group からの受信は表現できるため、transport 仕様と矛盾しない (`src/session/publicTypes.ts:682-705`)。ただし高レベル API はフィルタを渡していない (`src/mediaSubscriber/trackSubscriptions.ts:270-280`)。
7. **§6.1 / §6.2 と採番**: Group ID は壁時計起点 + 単調ガードで、再開時の MUST を満たす (`src/createMediaPublisher.ts:303-317`、`src/msf/tracks.ts:218-220`)。連続中は +1 (`src/createMediaPublisher.ts:397-404, 424-433`、catalog は `2047-2049`)。Object ID は Group 先頭 0 から +1 (`src/createMediaPublisher.ts:393-405, 420-434`)。適合 (MED-11 の PRIOR_GROUP_ID_GAP と引用の誤りを除く)。
8. **§4.4 暗号化**: catalog のフィールド型・検証はある (`src/msf/types.ts:209-219`、`src/msf/catalogTrackValidation.ts:285-300`) が、暗号化・復号の実行は未実装 (MED-13)。draft-02 では `cipherSuite` 必須条件が `moq-secure-objects` のときに限定されたため、現行の検証は緩める必要がある (`src/msf/catalogTrackValidation.ts:296-299`)。
9. **§4.4.4 の wire 形式と object エンコードへの影響**: 平文で認証される immutable object properties、暗号化される payload、payload と一緒に暗号化される private object properties (type 0xA) (666-681)。実装は Immutable Properties (0xB) の encode/decode を持つ (`src/properties.ts:1310-1431`) が、private properties (0xA) を持たず、暗号化経路も無い (MED-14)。現行の object エンコード (`src/dataStream/subgroup.ts:514-563`、`src/dataStream/datagram.ts:192-279`) は payload 長と payload をそのまま扱うため、暗号文を payload として載せること自体は可能である。
10. **§3 とクライアント専用方針の整合**: 整合する (MED-15)。§3 は relay の役割を挙げるが、relay が MSF を理解する必要は無いと A.1.1 が補足する (5341-5343)。moqt-js は relay 機能を持たない。
11. **`packagingMetadata` が media packaging の文脈で運ぶもの**: packaging 値 `loc` に対する追加パラメータで、現状定義されているのは `streamMapping` のみ (§5.2.5 1221-1223)。media packaging の文脈では「Group 内の Object を 1 Subgroup にまとめるか、Object ごとに Subgroup を分けるか」を運ぶ (Table 1 510-523)。未定義キーは無視し、同一キーは最初の出現を使う (1214-1217)。実装にパーサが無い (MED-16)。
12. **LOC-05 と MSF §4.1 の対応**: LOC-05 は payload container のみを定義し、Object を Stream へどう写像するかは定義しない (MSF-02 480-483 が明記)。LOC-05 §4.1 は音声について「one MOQT Object per MOQT Group」「each such unitary group is sent over an individual unidirectional QUIC stream」(LOC-05 649-653)、§4.2 は映像について「The GroupID is incremented by 1 at IDR Frame boundaries」「one unidirectional QUIC stream is setup to deliver all the encoded video chunks within a MOQT group」(LOC-05 683-690, 693-694) とする。実装の `src/loc.ts` は LOC の Properties と payload のみを扱い、Stream 写像には関与しない (`src/loc.ts` に MSF への参照は無い)。音声 1 chunk = 1 Group は LOC-05 の例に従っており (`src/createMediaPublisher.ts:378-405`)、draft-02 で要求は変わっていない (LOC-05 は draft-02 の Normative Reference)。

## 5. draft-01 の挙動を固定していて更新が必要なテスト一覧

| テスト                                                  | 固定している内容                                                      | 更新の理由                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/msf.test.ts:88-96`                                 | `MSF_VERSION === "draft-01"`、既知 version が `draft-01` と `1`       | MED-01 (encode 値と受理集合の変更)                                                       |
| `src/msf.prop.ts:433-438`                               | decode 後の version が常に `draft-01`                                 | MED-01                                                                                   |
| `src/msf.prop.ts:694, 719, 734, 759, 775, 843-897, 979` | fixture の version が `draft-01`                                      | MED-01 (受理集合を増やすなら追加ケースも必要)                                            |
| `src/createMediaSubscriber.catalog.test.ts:86, 109`     | catalog fixture の version が `draft-01`                              | MED-01                                                                                   |
| `src/createMediaPublisher.test.ts:4108-4170`            | `allocateInitialGroupId` / `noteGroupId` がトラック独立に払い出すこと | MED-08 (alternate group で開始 Group ID を揃えるなら前提が変わる)                        |
| `src/createMediaPublisher.test.ts:6498-6522`            | `allocateAudioObject` が 1 フレーム = 1 Group、Object ID 常時 0       | MED-18 の確認用。仕様変更は無いが、Group 採番を変える変更 (MED-08 の (4)) の影響を受ける |
| `src/createMediaPublisher.test.ts:6526-6577`            | `allocateVideoObject` がキーフレームで Group を進める                 | MED-09 (フレーム数ベースの keyframeSpacing にするなら採番の前提が変わる)                 |
| `src/createMediaPublisher.test.ts:6743-6800, 6867-7001` | `targetLatency` / `renderGroup` の catalog 出力と検証                 | MED-07 (文言) と MED-08 (`altGroup` 追加時の隣接テスト)                                  |
| `src/createMediaPublisher.test.ts:4685, 4885`           | 音声が 1 Object = 1 Group = 1 Subgroup であること                     | MED-18 の確認用。仕様変更は無い                                                          |
| `src/msf/tracks.test.ts:1-38`                           | `effectiveTargetLatencyMs` と draft-01 §5.2.8 の MUST                 | MED-07 (節番号が §5.2.9 に移動)                                                          |
| `src/msf/tracks.test.ts` 全体                           | `createInitialGroupId` / `nextGroupId` の JSDoc 前提                  | MED-11 (引用の修正)                                                                      |

補足: `src/dataStream.subgroup.test.ts`、`src/dataStream.datagram.test.ts`、`src/dataStream.fetch.test.ts` は draft-23 の wire (Subgroup Header / Object Datagram / Fetch Object fields) を検証しており、MSF の draft-01 固有の挙動を固定していない。MSF §4 / §6 の変更による更新は不要である (確認済み: 各テストの先頭コメントと全テスト名を確認)。

## 6. docs で更新が必要な記述

| 場所                                                                                     | 現在の記述                                                                                                    | 更新内容                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `README.md:45-47`                                                                        | MSF の参照が `draft-01`、`draft-01` 対応                                                                      | `draft-02` へ更新 (MED-01)                                                                                                                             |
| `docs/MSF.md:10-11`                                                                      | 正本が `refs/moq/draft-ietf-moq-msf-01.txt`                                                                   | `draft-ietf-moq-msf-02.txt` へ更新                                                                                                                     |
| `docs/MSF.md:16`                                                                         | MSF-01 §5 の Joining FETCH の解釈                                                                             | 参照を draft-02 に更新する (§5 の節番号は据え置き。記述内容は変わらないため文言の再確認のみ)                                                           |
| `docs/IMPLEMENTATION_STATUS.md:143-183`                                                  | `draft-01` の実装状況。Track の一覧に `packagingMetadata` / `keyframeSpacing` / `accessibleWindowTime` が無い | draft-02 のフィールドを追記し、未実装を明示 (MED-02, MED-09, MED-16)                                                                                   |
| `docs/IMPLEMENTATION_STATUS.md:163-172`                                                  | renderGroup / altGroup / depends、encryptionScheme 等の記載                                                   | `altGroup` は「型のみ、publisher は生成しない」ことを明記 (MED-08)                                                                                     |
| `docs/ARCHITECTURE.md:141`                                                               | 「Object ID 0 が Group 先頭であることは draft-ietf-moq-msf-01 §6.2」                                          | 節番号は据え置き (§6.2)。ただし「Group 先頭が IDR」の根拠を LOC-05 §4.2 のまま維持するか、MSF §4.3 のキーフレーム MUST を参照するかを整理する (MED-08) |
| `docs/ARCHITECTURE.md:187`                                                               | Catalog の Group ID / Object ID の採番 (msf-01 §5 / §6.1 / §6.2)                                              | 節番号は据え置き。`PRIOR_GROUP_ID_GAP` を送らないことを明記する余地 (MED-11)                                                                           |
| `docs/HIGH_LEVEL_API.md:115-139`                                                         | `targetLatency` (§5.2.8) / `renderGroup` (§5.2.11) の節番号                                                   | draft-02 では `targetLatency` は §5.2.9、`renderGroup` は §5.2.12 (MED-07)                                                                             |
| `docs/MEDIA_PLAYOUT.md:245`                                                              | draft-ietf-moq-msf-01 §5.2.8 の targetLatency                                                                 | §5.2.9 へ更新し、基準が「エンコーダに入った時刻」であることを明記 (MED-07)                                                                             |
| `docs/PLAYOUT.md` / `docs/PLAYOUT_DELAY.md`                                              | targetLatency の説明                                                                                          | 同上 (MED-07)。該当箇所の行番号は未確認                                                                                                                |
| `src/codec/types.ts:304-312`                                                             | 「符号化から表示までの wallclock の差 (ms)」「§5.2.8」                                                        | 「エンコーダに入った時刻から表示まで」「§5.2.9」(MED-07)                                                                                               |
| `src/codec/types.ts:314-320`                                                             | `renderGroup` を「§5.2.11」                                                                                   | 「§5.2.12」(MED-07 と同じ節番号の繰り上がり)                                                                                                           |
| `src/msf/version.ts:2-4, 12-33`                                                          | `draft-01` 前提の JSDoc                                                                                       | `draft-02` へ (MED-01)                                                                                                                                 |
| `src/msf/types.ts:1-8, 96-99`                                                            | `draft-ietf-moq-msf-01` 前提の JSDoc                                                                          | `draft-02` へ。`packagingMetadata` / `keyframeSpacing` の追加 (MED-02, MED-09)                                                                         |
| `src/msf/tracks.ts:213-217, 225`                                                         | 仕様に存在しない引用と MUST / SHOULD の取り違え                                                               | 引用を仕様の文面へ修正 (MED-11)                                                                                                                        |
| `src/createMediaPublisher.ts:445`                                                        | `maxGopDuration` を「draft-ietf-moq-msf-01 §5.2.24」                                                          | draft-02 では §5.2.25 (1576)                                                                                                                           |
| `src/playout/timeline.ts:4`                                                              | 「draft-ietf-moq-msf-01 §5.2.8」                                                                              | §5.2.9 (MED-07)                                                                                                                                        |
| `src/mediaSubscriber/catalogSubscription.ts:525, 538`, `src/msf/tracks.ts:130, 153, 172` | §5.2.8 の引用                                                                                                 | §5.2.9 (MED-07)                                                                                                                                        |
| `src/publisher.ts:91-98`                                                                 | Subgroup の説明が「新しい Subgroup (moqt-js の実装では新しい Group) を開く」                                  | 現行の実装 (Group 内で 1 Subgroup を共有) に合わせた記述に整理する余地 (MED-04 の確認結果)                                                             |

## 7. 実装が対応していない新規機能の一覧 (優先度つき)

| 優先度 | 機能                                                                                                 | 仕様根拠                                   | 現状                                                       |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| P0     | version `draft-02` の catalog 受理                                                                   | §5.1.1 (789-791)、A.1.1 (5364-5365)        | 未知 version として拒否 (MED-01)                           |
| P1     | `packagingMetadata` / `streamMapping` のパースと解釈 (両モード対応)                                  | §4.1.1 (483-525)、§5.2.5 (1205-1223)       | 型もパーサも無い (MED-03, MED-16)                          |
| P1     | `object` モード受信時の Group 内 Object 順序の吸収                                                   | §4.1.1 (484-485, 516-517)                  | 同一 Group 内の並べ替えで映像を欠落 (MED-03)               |
| P1     | `keyframeSpacing` の送出と値の保証                                                                   | §4.3 (578-580)、§5.2.46 (1965-1974)        | 未実装 (MED-09)                                            |
| P1     | alternate group 向け packaging (Group 先頭キーフレーム、開始 Group ID の一致、object 境界の時間整合) | §4.3 (571-584)                             | `altGroup` を出さず、開始 Group ID はトラック独立 (MED-08) |
| P1     | Multi-Variant Fast Track Switching (切替手順と switch point 計算)                                    | §6.3 (3293-3328)                           | 未実装 (MED-10)                                            |
| P1     | 暗号化トラックの復号 (または明示的な非対応の表明) と `cipherSuite` 必須条件の緩和                    | §4.4 / §4.4.1 (589-623)、A.1.3 (5452-5453) | 復号せず、条件は draft-01 のまま (MED-13)                  |
| P2     | `PRIOR_GROUP_ID_GAP` の送出 (再起動時)                                                               | §6.1 (3284-3286)                           | 送出しない (MED-11)                                        |
| P2     | `packagingMetadata` の明示送出 (group モード)                                                        | §4.1.1 (483-486)                           | 送出しない (MED-02)                                        |
| P2     | Private object properties (0xA) と暗号化 object 構造                                                 | §4.4.4 (661-681)                           | 未実装 (MED-14)                                            |
| P2     | `template` の生成 (media timeline の代替)                                                            | §5.2.16 (1480-1493)、§7.4                  | 型・検証のみで生成しない (MED-17)                          |
| P2     | `accessibleWindowTime` (§5.2.45) と DVR 窓                                                           | §5.2.45 (1927-1947)                        | 未実装 (本担当の範囲外だが media packaging に関係する)     |

## 8. 付録: 仕様差分の機械的な突き合わせ結果

`refs/moq/draft-ietf-moq-msf-02.txt` と `refs/moq/draft-ietf-moq-msf-01.txt` の該当節を正規化 (ページヘッダ除去、空行除去) して比較した結果である。

- §3 Scope: 参照名 `[MoQTransport]` → `[MOQT]`、latency の箇条書きの入れ子構造の変更のみ。規範内容の変更なし。
- §4.1 LOC packaging: 「All MOQT Objects SHOULD be placed on MOQT Subgroup 0 unless streamMapping Section 4.1.1 indicates otherwise.」が追加 (470-471)。§4.1.1 (479-529) が新規追加。GOP の MUST (472-474) は維持。
- §4.2 Time-alignment: 「must be provided」→「needs to be provided」の 1 文のみ。
- §6 Media transmission: 「each MOQT Object MUST be mapped to a new MOQT Stream」が削除され、packaging による写像と Subgroup 0 の SHOULD に置き換わった。
- §6.1 Group numbering: 最後の文の「MOQT Prior Group ID Gap Extension header」→「PRIOR_GROUP_ID_GAP property [MOQT], Section 10.8」のみ。
- §6.2 Object Numbering: 変更なし。直後に §6.3 (3293-3328) が新規追加。
- §4.3 Content protection and encryption (draft-01) → draft-02 では §4.4 に移動し、§4.3 には「Packaging for multi-variant track switching」が新設された。§4.4.4 の用語は header extension → object property に変わった。
- §5.2.9 targetLatency: 「between when content was encoded」→「between when content entered the encoder」、および §11.6 への参照追加。
- §5.2.39 cipherSuite: 「MUST be present when encryptionScheme is specified」→「MUST be present when the encryptionScheme is "moq-secure-objects"」。
- §5.2.16 template: draft-01 の §5.2.15 から 1 つ繰り上がっただけ。本文は同一。
- §5.2.46 keyframeSpacing: 新規。
- §5.2.5 packagingMetadata: 新規。
