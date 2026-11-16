# MSF draft-02 追従調査レポート: Media Timeline / Event Timeline / MSF Properties

> **決定事項 (本レポートの後に確定)**: draft-01 との互換性は維持しない。
> したがって、本レポートの「互換性影響」欄にある「両方を受ける」「移行期は旧綴りも受理する」
> 「後方互換になる」といった選択肢は採らない。実装時は [README.md](README.md) 冒頭の決定事項を優先する。

- 調査日: 2026-11-16
- 担当: 調査エージェント (timeline 担当)
- 対象リポジトリ: `/home/shiguredo/shiguredo/moqt-js` (読み取りのみ。リポジトリ内ファイルは一切変更していない)
- 正本 (draft-02): `refs/moq/draft-ietf-moq-msf-02.txt` (5600 行)。引用は `msf-02:行番号`
- 比較用 (draft-01): `refs/moq/draft-ietf-moq-msf-01.txt` (4144 行)。引用は `msf-01:行番号`
- 実装の現行準拠版: draft-ietf-moq-msf-01 (`src/msf.ts:6`、`src/msf/version.ts:22-33`)

## 0. 調査方法と前提

### 0.1 読んだ仕様の範囲

全文を読んだ範囲:

- §7 Media Timeline track (`msf-02:3330-3532`)、§7.1 (`3347-3368`)、§7.1.1 (`3370-3419`)、§7.2 (`3421-3438`)、§7.3 (`3440-3450`)、§7.4 (`3452-3460`)、§7.4.1 (`3462-3517`)、§7.4.2 (`3519-3531`)
- §8 Event Timeline track (`msf-02:3533-3812`)、§8.1 (`3554-3570`)、§8.1.1 (`3572-3611`)、§8.2 (`3613-3643`)、§8.3 (`3645-3658`)、§8.4 (`3660-3678`)、§8.5 (`3680-3712`)、§8.6 (`3713-3811`)
- §12 MSF Properties (`msf-02:4575-4742`)、§12.1 (`4583-4623`)、§12.1.1 (`4625-4657`)、§12.1.2 (`4659-4678`)、§12.2 (`4680-4724`)、§12.3.1 (`4728-4742`)
- §14.2 / §14.2.1 / §14.3 / §14.4 (`msf-02:5002-5116`)
- 関連する catalog 側の規定: §5.1.7 (`882-926`)、§5.2.4 / §5.2.4.1 (`1125-1204`)、§5.2.6 (`1225-1246`)、§5.2.12 (`1426-1434`)、§5.2.14 (`1447-1460`)、§5.2.15 (`1461-1479`)、§5.2.16 (`1480-1494`)、§5.2.20 (`1532-1537`)、§5.2.45 (`1927-1948`)、§5.5 (`2077-2087`)、§6.1 (`3272-3287`)、§11.6 (`4564-4573`)、§5.6.9 / §5.6.10 (`2693-2840`)
- Appendix A.1.1 / A.1.2 / A.1.3 / A.1.4 / A.1.5 / A.1.7 / A.1.8 (`msf-02:5337-5563`)

draft-01 側の対応節: §7 (`msf-01:2805-2972`)、§8 (`2973-3100`)、§10.5 (`3255-3283`)、§12 (`3732-3830`)、§14.2 (`3851-3886`)、§14.3 (`3887-3904`)、§14.4 (`3905-3937`)、§5.2.4〜§5.2.19 (`849-1130`)。

### 0.2 読んだ実装

全文を読んだファイル:

- `src/msf/timeline.ts` (222 行)
- `src/msf/types.ts` (392 行)
- `src/msf/catalogValidation.ts` (541 行)
- `src/msf/catalogTrackValidation.ts` (686 行)
- `src/msf/catalogCodec.ts` (420 行)
- `src/msf/version.ts` (90 行)
- `src/msf/ownFields.ts` (40 行)
- `src/msf/json.ts` (92 行)
- `src/msf/tracks.ts` (12003 バイト)
- `src/msf.ts` (facade)
- `src/properties.prop.ts` (375 行)
- `docs/MSF.md` (35 行)、`docs/IMPLEMENTATION_STATUS.md` (231 行)
- 全文ではなく、参照箇所を `rg` で列挙した上で該当関数とその周辺を読んだファイル: `src/properties.ts` (2571 行)、`src/loc.ts`、`src/session/params.ts`、`src/playout/timeline.ts`、`src/playout/mediaPlayout.ts`、`src/createMediaPublisher.ts` (3203 行)、`src/createMediaSubscriber.ts` (3248 行)、`src/msf/catalogDelta.ts`、`src/msf/variables.ts`、`devtools/src/**`。
- `src/playout/timeline.ts` は表示時刻を決める `PlayoutTimeline` であり、MSF の Media Timeline / Event Timeline を参照しない (`rg -i 'mediatimeline|eventtimeline|MediaTimeline|EventTimeline|MSF_COMPRESSION' src/playout/` は 0 件)。`src/playout/mediaPlayout.ts:215` は `targetLatency` (§5.2.8) を参照するのみである。

### 0.3 重要な前提 (範囲外だが本レポートの結論を左右するもの)

- **catalog の `version` 値**: draft-02 の例はすべて `"version": "draft-02"` (`msf-02:2703`、`2806`)。現行実装は `"draft-01"` しか出力せず、`"draft-02"` を入力として拒否する (`src/msf/version.ts:22-33`、`src/msf/catalogValidation.ts:55-60`)。version の扱いは catalog 担当の範囲だが、timeline の全カタログ例が `draft-02` であるため、この 1 点だけで本レポートの全カタログ例が現行実装では受理できない。本レポートでは横断項目 TL-24 として扱う。
- **`depends` の一般的な解決規則** (§5.2.15: `msf-02:1461-1479`) は depends 担当の範囲。本レポートは §7.2 / §8.3 が timeline 側から要求する形 (renderGroup 参照、参照先 track の消滅時の catalog 更新、index が参照する media timeline track の列挙) に限定して書く。
- **draft-01 の §5.2.x 番号**は draft-02 で 1 つ繰り下がる (§5.2.5 eventType → §5.2.6、§5.2.11 renderGroup → §5.2.12、§5.2.14 depends → §5.2.15、§5.2.15 template → §5.2.16 など)。実装の JSDoc とエラーメッセージ、テストの期待値は draft-01 番号で固定されている。TL-23 に一覧を置く。
- **`refs/moq/draft-ietf-moq-msf-01.txt` は既に存在しない**。`docs/MSF.md:10-11` のリンクは壊れている。

### 0.4 優先度の定義

- **P0**: draft-02 に適合する入力 (カタログ / ペイロード / property) を現行実装が誤って拒否する、または現行の wire / 公開 API が draft-02 と非互換で相互接続が成立しない。draft-02 追従の最初のリリースに必須。
- **P1**: 仕様の MUST / SHOULD が未実装で、実装しないと一部ユースケースや対向実装で相互接続が壊れる、または仕様の要求を満たせない。追従リリース内で対応する。
- **P2**: 文書・コメント・節番号・任意の改善。動作に影響しない、または仕様が SHOULD / 例のみ。

## 1. 最重要 5 件 (要点)

1. **TL-12 Event Timeline の index key が `t` / `l` / `m` → `T` / `L` / `M` に変わった (P0)**。実装は encode / decode とも小文字固定 (`src/msf/timeline.ts:111-122`、`154-172`、`195-213`)。小文字 key の payload は draft-02 では「index が無いレコード」として不正であり、逆に draft-02 の payload は `indexCount !== 1` で reject される (`src/msf/timeline.ts:215-219`)。`EventTimelineEntry` は公開型 (`src/index.ts:160`) であるため、フィールド名の変更は公開 API の破壊的変更になる。devtools も `entry.t` を直接使っている (`devtools/src/utils/eventTimeline.ts:34`、`devtools/src/components/MessageList.tsx:39`)。
2. **`depends` が renderGroup (JSON Number) を参照できるようになった (P0)**。`CatalogTrack.depends` は `string[]` 固定 (`src/msf/types.ts:144`)、decode も文字列以外を拒否する (`src/msf/catalogTrackValidation.ts:226-232`)。draft-02 の代表例は `"depends": [1]` (`msf-02:2712`) であり、現行実装はこのカタログを拒否する。`variables.ts` の変数置換も `depends` を文字列前提で走査する (`src/msf/variables.ts:166-171`) ため、型変更は 3 箇所に波及する。
3. **media timeline / event timeline の `mimeType` 必須要求が削除され、event timeline の `depends` 必須も条件付きになった (P0)**。実装は 4 つの MUST を強制している (`src/msf/catalogTrackValidation.ts:454-482`)。draft-02 の event timeline 例は `mimeType` を持たない (`msf-02:2715-2721`) ため、現行実装は仕様の例をそのまま拒否する。
4. **MSF_COMPRESSION に Property Type 0x78 が割り当てられ (Track / Object 双方、FETCH_OK でも運べる)、GZIP の MUST サポートが実際に実装可能になった (P1)**。現行実装は algorithm 定数だけを持ち (`src/properties.ts:41-44`)、Property ID を「IANA 未割当 (TBD)」として意図的に未実装のままにしている (`src/properties.ts:36-39`)。draft-02 では 0x78 / 0x7B はアプリケーション固有範囲で IANA 登録不要と明記された (`msf-02:5065-5086`) ため、pending issue `0355` のブロッカーは解消している。未対応のまま draft-02 の圧縮カタログ / timeline を受信すると、property は未知として値だけ保持され (解釈されず)、gzip バイト列を JSON として parse して失敗する。
5. **Event Timeline header data と新 property `MSF_EVENT_TIMELINE_HEADER` (0x7B) が追加された (P1)**。Subscribers は payload を parse する前に本 property の有無を確認する MUST がある (`msf-02:3564-3567`)。現行実装には property 定義も payload と header を組にした API も無く、`resolveTrackProperty` は奇数 ID (length + bytes) の property を解決できない (`src/properties.ts:1533`、`1540`) ため、そのままでは MUST を満たせない。

## 2. 差分一覧

| ID      | 分類                        | 1 行サマリ                                                                                   | 優先度 |
| ------- | --------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| TL-01   | Media Timeline payload      | explicit / template の混在が禁止になった (-01 は混在可)                                      | P2     |
| TL-02   | Media Timeline payload      | media time 順であることと Group ID の非連続が明文化された                                    | P1     |
| TL-03   | Media Timeline catalog      | §7.2 の識別が `type` から `packaging` に変わった                                             | P2     |
| TL-04   | Media Timeline catalog      | mediatimeline の `mimeType` MUST が削除された                                                | P0     |
| TL-05   | Media Timeline catalog      | `depends` が renderGroup (Number) を参照できるようになった                                   | P0     |
| TL-06   | Media Timeline catalog      | renderGroup / 個別 track の参照規則と、参照先消滅時の catalog 更新 MUST が追加された         | P1     |
| TL-07   | Media Timeline updating     | §7.3 の更新規則は変更なし (確認のみ)                                                         | P2     |
| TL-08   | Media Timeline template     | §7.4.1 の 6 要素 template は変更なし、節番号のみ -02 で §5.2.16                              | P2     |
| TL-09   | Media Timeline template     | §7.4.2 の template immutability は変更なし (確認のみ)                                        | P2     |
| TL-10   | Media Timeline / catalog    | `accessibleWindowTime` が新設され、trim SHOULD と購読側の適用 MUST が追加された              | P1     |
| TL-11   | Media Timeline catalog      | template を持つ track は別の media timeline track を持たない SHOULD が明記された             | P2     |
| TL-12   | Event Timeline payload      | index key が小文字から大文字に変わった                                                       | P0     |
| TL-13   | Event Timeline payload      | `data` が任意の JSON 値になった                                                              | P2     |
| TL-14   | Event Timeline / properties | header data と `MSF_EVENT_TIMELINE_HEADER` が追加された                                      | P1     |
| TL-15   | Event Timeline catalog      | eventtimeline の `depends` MUST が条件付きに変わった                                         | P0     |
| TL-16   | Event Timeline catalog      | eventtimeline の `mimeType` MUST が削除された                                                | P0     |
| TL-17   | Event Timeline catalog      | index が参照する media timeline track を `depends` に列挙する MUST が追加された              | P1     |
| TL-18   | Event Timeline updating     | record と Group の対応が eventType ごとに定義されるようになった                              | P1     |
| TL-19   | Event Timeline registry     | §8.5 へ移動し、well-known type の初期登録 4 件が削除された                                   | P2     |
| TL-20   | Event Timeline / catalog    | event timeline track が `publishTracks` に出現し得ることが明記された                         | P1     |
| TL-21   | Event Timeline 例           | media time indexing の例が追加された                                                         | P2     |
| TL-22   | wallclock                   | wallclock の定義が §11.6 に移動し、「エンコーダーに入った時刻」に変わった                    | P2     |
| TL-23   | 横断                        | 節番号の繰り下げ (JSDoc / エラーメッセージ / テスト期待値)                                   | P2     |
| TL-24   | 横断 (catalog)              | catalog version が `draft-02` になった (decode 拒否 / encode 不一致)                         | P0     |
| PROP-01 | Properties                  | `MSF_COMPRESSION` Track / Object property (0x78) の定義が無い                                | P1     |
| PROP-02 | Properties                  | Track / Object の排他規則と未対応 algorithm の扱いが未実装                                   | P1     |
| PROP-03 | Properties                  | GZIP の実装 (MUST) と payload 経路が未実装 (ブロッカーは解消)                                | P1     |
| PROP-04 | Properties / catalog        | VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) は LOC として実装済み。§12.2 の initRef 連携が無い | P1     |
| PROP-05 | Properties / catalog        | initDataList の `track-property` / `object-property` type が未対応                           | P1     |
| PROP-06 | Properties                  | `MSF_EVENT_TIMELINE_HEADER` (0x7B) の property 定義が無い                                    | P1     |
| PROP-07 | Registry                    | §14.3 の Property Type 値レジストリと定数の照合                                              | P2     |
| PROP-08 | Registry                    | §14.4 の Compression Algorithms レジストリと定数の照合                                       | P2     |
| PROP-09 | Properties framework        | `resolveTrackProperty` が奇数 ID (length + bytes) を解決できない                             | P1     |
| PROP-10 | Properties framework        | property scope / 重複検証テーブルと PBT の更新                                               | P1     |

## 3. 差分の詳細

### 3.1 Media Timeline (TL-01 〜 TL-11)

#### TL-01 explicit 形式と template 形式の混在が禁止された

- 仕様 (draft-02): 「The document supports two formats: an explicit entry format and a template format. A media timeline track MUST NOT use both formats.」 (`msf-02:3351-3352`)。Appendix A.1.4 にも「A media timeline track MUST NOT mix the explicit and template formats (-01 allowed both).」 (`msf-02:5466-5467`)。
- draft-01: 「Publishers MAY combine both formats in a single document.」 (`msf-01:2818-2820`)。混在が明示的に許されていた。
- 現行実装: payload の decode は explicit 形式の 3 要素配列しか受理しない (`src/msf/timeline.ts:45-95`)。template 形式は payload ではなく catalog の `template` フィールドとしてのみ実装されている (`src/msf/types.ts:76-89`、`146-147`)。したがって「1 つの payload に両形式を入れる」表現自体が存在せず、混在は構造的に起こらない。実際に template 配列 (`[0, 2002, [0,0], [1,0], ...]`) を payload として渡すと `invalid media timeline entry at index 0` で拒否される (`src/msf/timeline.ts:53-56`)。
- 必要な変更: コード変更は不要。ただし「混在禁止」は publisher 側の責務であり、本ライブラリは「media timeline track (packaging=mediatimeline) と `template` フィールドの併用」を検出していない (TL-11) ため、そちらで担保するか、少なくとも JSDoc に明記する。decode のエラー文言を「template 形式は payload では扱わない (§7.4)」と区別できるようにすると利用者の誤解を減らせる。
- 互換性影響: なし (受理集合は変わらない)。draft-01 で混在 payload を送っていた外部 publisher のデータは -02 では不正になるが、本実装は元々受理していない。
- 優先度: P2

#### TL-02 media time 順であることと Group ID の非連続が明文化された

- 仕様 (draft-02): 「The media timeline track is ordered by media time.」 (`msf-02:3394`)。また「there is no requirement from a media timeline perspective that the group numbers are sequential or are monotonically increasing.」 (`msf-02:3366-3368`)。Appendix A.1.4: 「Entries are ordered by media time, and Group IDs need not be sequential.」 (`msf-02:5467-5468`)。
- draft-01: 同等の記述は無い (§7.1 は `msf-01:2814-2820` のみで、順序にも Group ID の連続性にも言及しない)。
- 現行実装: `isMediaTimelineEntry` は 3 要素の型だけを見ており、media time の昇順も Group ID の連続性も検証しない (`src/msf/timeline.ts:71-95`)。`encodeMediaTimeline` も入力順のまま出力する (`src/msf/timeline.ts:27-36`)。Group ID の非連続は受理する (連続性を仮定するコードは無い)。なお Group ID の連続性要件は timeline が記述する側の Group に対するものであり、timeline track 自身の Group 番号は §6.1 の「unique / monotonically increasing、SHOULD +1」(`msf-02:3274-3276`) に従う。実装の `nextGroupId` は +1 固定 (`src/msf/tracks.ts:227-229`) であり、これは §6.1 の SHOULD の範囲では問題ない。
- 必要な変更: 順序は MUST ではなく「format の性質」を述べた文なので、decode で拒否するかは設計判断。推奨は (a) `encodeMediaTimeline` で media time の非降順を検証する (自分で不正な payload を送らない)、(b) `decodeMediaTimeline` は受理しつつ、順序を仮定した二分探索などの helper を公開しない、の 2 点。decode で reject する場合は受理集合が狭くなる (現行の PBT は順序を生成しない: `src/msf.prop.ts:375-379`) ため、PBT の arbitrary を media time 昇順に直す必要がある。
- 互換性影響: encode 側の検証追加は「従来 encode できた不正 payload」を拒否する破壊的変更になる。decode 側の reject も同様。順序保証を consumer が前提にするなら decode で reject しない方が安全。
- 優先度: P1 (consumer が存在しない現状では実害は小さいが、timeline を実装する際の前提になる)

#### TL-03 §7.2 の識別方法が `type` から `packaging` に変わった

- 仕様 (draft-02): 「A media timeline track MUST carry a 'packaging' Section 5.2.4 attribute with a value of "mediatimeline".」 (`msf-02:3423-3425`)。draft-02 の §5.2 に `type` というフィールドは存在しない (`msf-02:927-1040` のフィールド表、`msf-02:1034` の一覧)。
- draft-01: 「A media timeline track MUST carry a 'type' identifier in the Catalog with a value of "mediatimeline".」 (`msf-01:2871-2872`)。
- 現行実装: `packaging === "mediatimeline"` で判定しており (`src/msf/catalogTrackValidation.ts:454`)、`type` は既知フィールドに含まれないため未知フィールドとして保持されるだけ (`src/msf/catalogTrackValidation.ts:28-71`、`117-123`)。つまり draft-01 の `type` は検証せず、draft-02 の `packaging` は検証している。**draft-02 の方向に既に一致している**。
- 必要な変更: なし。draft-01 形式 (`type` のみで `packaging` が無い) のカタログは元々 `packaging` 必須で拒否されるため、追加の互換処理は不要。
- 互換性影響: なし。
- 優先度: P2 (JSDoc と テスト内の「§7.2」引用はそのまま利用できる)

#### TL-04 mediatimeline の `mimeType` MUST が削除された

- 仕様 (draft-02): §7.2 の MUST は `packaging` と `depends` の 2 つだけ (`msf-02:3423-3431`)。`mimeType` への言及は無い。Appendix A.1.4: 「Catalog requirements now use the packaging field and drop the mimeType requirement.」 (`msf-02:5470-5471`)。
- draft-01: 「The mime-type of a media timeline track MUST be specified as "application/json".」 (`msf-01:2874-2875`)。
- 現行実装: `packaging === "mediatimeline"` のとき `track.mimeType !== "application/json"` なら throw する (`src/msf/catalogTrackValidation.ts:459-465`)。テストもこの拒否を固定している (`src/msf.test.ts:1163-1179`、`src/msf.test.ts:618-644`)。`mimeType` 自体は §5.2.20 の任意フィールドとして引き続き受理する (`src/msf/catalogTrackValidation.ts:247`、`src/msf/types.ts:158-159`)。
- 必要な変更: `src/msf/catalogTrackValidation.ts:459-465` の分岐を削除する。`mimeType` は任意フィールドとして型検証のみ残す。draft-02 の例 `msf-02:2702-2713` は `mimeType` を持つが、これは任意であり、持たない -02 カタログも受理しなければならない。
- 互換性影響: 受理集合が広がる (従来拒否していた入力の受理)。逆に、現状は draft-02 適合カタログを拒否している。draft-01 を前提に「mimeType 必須」で相互接続している相手とは、こちらの出力に関しては `mimeType` を付け続ければ互換を保てる (フィールドを消す必要はない)。
- 優先度: P0

#### TL-05 `depends` が renderGroup (Number) を参照できるようになった

- 仕様 (draft-02): 「A media timeline track MUST carry a 'depends' attribute which contains an array of any track names and renderGroups to which the media timeline track applies.」 (`msf-02:3425-3426`)。§5.2.15: 「Each element can be either a track name Section 5.2.3 or renderGroup Section 5.2.12. ... any entry with a JSON type of String MUST reference a track name and any entry with a JSON type of Number MUST reference a renderGroup. ... Each Number element MUST match the renderGroup identifier of exactly one renderGroup in the catalog. A catalog in which a dependency does not resolve is invalid.」 (`msf-02:1468-1478`)。代表例は `"depends": [1]` (`msf-02:2712`)。Appendix A.1.4 (`msf-02:5473-5475`)。
- draft-01: 「a 'depends' attribute which contains an array of all track names to which the media timeline track applies.」 (`msf-01:2872-2874`)。文字列のみ。draft-01 §5.2.14 も「Each element is a Track Name」で Number は無い (`msf-01:1069-1078`)。
- 現行実装: `CatalogTrack.depends?: string[]` (`src/msf/types.ts:144`)。decode は「文字列の配列」でなければ throw する (`src/msf/catalogTrackValidation.ts:226-232`、エラー文言は `depends must be an array of strings per §5.2.14`)。`variables.ts` も `depends` を文字列前提で置換する (`src/msf/variables.ts:166-171`)。`getTracksByRenderGroup` は存在する (`src/msf/tracks.ts:76-78`) が、`depends` の解決には使われていない。
- 必要な変更: (1) 型を `(string | number)[]` に変更する (要素の型で track 名 / renderGroup を判別する、§5.2.15 の規則どおり)。(2) decode の検証を「string または整数 number」に変更する。renderGroup は `Number.isSafeInteger` で検証する (JSON Number であり、`renderGroup` フィールド自体は既に number として検証している: `src/msf/catalogTrackValidation.ts:215`)。(3) `variables.ts` は number 要素をそのまま通す。(4) 公開 API の破壊的変更として CHANGES と docs に記載する。(5) `assertJsonSafeBigInt` 相当の範囲検証は不要 (renderGroup は整数 ID であり Location ではない)。
- 互換性影響: **wire 互換性が壊れる**。現行 decode は Number 要素を拒否するため、draft-02 の publisher のカタログを受理できない。現行 encode は Number 要素を出力できないため、renderGroup 参照を要求する -02 の MUST (TL-06) を満たせない。`CatalogTrack.depends` は公開型 (`src/index.ts` / `src/msf.ts:27-43`) なので、TypeScript 利用者のコードも影響を受ける (広がる方向なので代入は通るが、`string[]` 前提の処理が壊れる)。
- 優先度: P0

#### TL-06 renderGroup / 個別 track の参照規則と、参照先消滅時の catalog 更新 MUST が追加された

- 仕様 (draft-02): 「If all tracks in a renderGroup match the media timeline, then the renderGroup MUST be referenced and the individual track names MUST NOT be referenced. If only a subset of tracks in the renderGroup match the media timeline, then the renderGroup MUST NOT be referenced and the individual tracks MUST be referenced.」 (`msf-02:3426-3431`)。「If multiple tracks are referenced and then one of those tracks ceases publication, the publisher MUST produce a catalog update which removes the 'depends' reference of the track that ceased publication.」 (`msf-02:3433-3435`)。Appendix A.1.4 (`msf-02:5473-5475`)。
- draft-01: この区別は無い (`msf-01:2869-2875`)。参照先 track の消滅時の更新 MUST も無い。
- 現行実装: catalog 全体を受け取る検証でも、`depends` の参照解決 (「String は catalog 内のちょうど 1 つの track 名と一致し、Number はちょうど 1 つの renderGroup と一致する」: `msf-02:1472-1478`) を行っていない。`validateCatalog` は root / track 単位の検証のみで (`src/msf/catalogValidation.ts:38-161`)、`getTracksByRenderGroup` は検索用 helper としてのみ存在する (`src/msf/tracks.ts:76-78`)。renderGroup の「全一致なら renderGroup のみ、部分一致なら個別名のみ」の検証コードは無い。publisher 側にも「参照先 track が止まったら `depends` を消す catalog 更新を出す」機構は無い (高レベル publisher は timeline track 自体を生成しない: `src/createMediaPublisher.ts:2107-2165`)。
- 必要な変更: (1) catalog 全体の検証段 (root レベルの検証、または `validateCatalog` 内) に depends 解決と renderGroup 規則を追加する。ただし §5.2.15 の一般的な depends 解決は depends 担当の範囲なので、重複を避けて分担する (timeline 側は「media timeline track の depends が renderGroup 規則を満たすか」を担当)。(2) `encodeCatalog` / `createCatalog` は自己 decode で同じ検証を通るため (`src/msf/catalogCodec.ts:114-124`)、生成時にも検出できる。(3) publisher の自動追従は timeline track を publish する実装 (現状は devtools のみで、devtools は event timeline だけ) で必要になる。少なくとも helper (`dependsReferencesTrack` のような) と JSDoc で責務を明示する。
- 互換性影響: 検証を追加すると、従来受理していた「解決しない depends を持つカタログ」(例: 存在しない track 名) が拒否される。これは仕様が「invalid」と定めるため正しい方向だが、受理集合が狭くなる破壊的変更として扱う。
- 優先度: P1 (検証と rules が未実装。renderGroup 規則は MUST)

#### TL-07 §7.3 Media Timeline track updating は変更なし

- 仕様 (draft-02): 「The publisher MUST publish an independent media timeline in the first MOQT Object of each MOQT Group ... The publisher MAY publish incremental updates in the second and subsequent Objects within each Group.」 (`msf-02:3440-3450`)。
- draft-01: 同一文言 (`msf-01:2877-2888`)。
- 現行実装: media timeline を publish するコードパスが無い (devtools も media timeline は扱わない: `devtools/src/hooks/*` に media timeline の参照は無い)。したがって独立 object / 増分 object の規則を満たす/破る実装は存在せず、違反の可能性も無い。helper も無い。
- 必要な変更: なし (将来 media timeline を publish する際の設計入力として記録)。
- 互換性影響: なし。
- 優先度: P2

#### TL-08 §7.4.1 template の 6 要素は変更なし (節番号のみ移動)

- 仕様 (draft-02): 6 要素 (startMediaTime, deltaMediaTime, startLocation, deltaLocation, startWallclock, deltaWallclock) を固定順で持ち、すべて必須 (`msf-02:3464-3502`)。計算式は `mediaTime[n] = startMediaTime + n * deltaMediaTime` など (`msf-02:3504-3508`)。template は「inline track attribute using the Section 5.2.16 field」 (`msf-02:3465-3466`)。
- draft-01: 同一内容で、参照先が §5.2.15 (`msf-01:2901-2902`、`msf-01:1079-1093`)。
- 現行実装: 6 要素配列を厳密に検証し (`src/msf/catalogTrackValidation.ts:615-642`)、内部表現では Location を bigint で保持し (`src/msf/types.ts:76-89`)、encode 時に number へ変換する (`src/msf/catalogCodec.ts:158-175`)。precision loss と負値を拒否する (`src/msf/catalogTrackValidation.ts:679-686`、`src/msf/json.ts:25-45`)。計算 helper (mediaTime[n] などを求める関数) は公開されていない。
- 必要な変更: 検証ロジックは変更なし。参照節番号を §5.2.15 → §5.2.16 に更新する (TL-23)。template の計算 helper は未提供だが、仕様は「Clients compute entry values using the following formulas」と定めるため、利便性のため追加するかは任意。
- 互換性影響: なし。
- 優先度: P2

#### TL-09 §7.4.2 template immutability は変更なし

- 仕様 (draft-02): 「Publishers MUST NOT change the template values for a track after the first Object has been published.」 (`msf-02:3526-3528`)。
- draft-01: 同一文言 (`msf-01:2956-2961`)。
- 現行実装: 型と JSDoc で「publish 開始後に template を書き換えないこと」を利用者責務として明記している (`src/msf/types.ts:65-71`)。enforce する仕組みは無い。高レベル publisher は template を送らない (`src/createMediaPublisher.ts:2107-2165`) ため、現状で違反経路は無い。
- 必要な変更: なし。publisher 側で template を扱う API を追加する場合に、初回 publish 後の変更を拒否する状態管理が必要になる。
- 互換性影響: なし。
- 優先度: P2

#### TL-10 `accessibleWindowTime` が新設され、trim SHOULD と購読側の適用 MUST が追加された

- 仕様 (draft-02): §7 冒頭「A media timeline track MAY describe content that lies outside the accessibility window defined by the Accessible Window Time Section 5.2.45 track property. Publishers of media timeline tracks SHOULD trim their media timeline so as to not describe content outside of the availability window. Subscribers of media timeline tracks MUST apply any Accessible Window Time constraints before attempting to retrieve content based on a media timeline description.」 (`msf-02:3339-3345`)。§5.2.45: `accessibleWindowTime` は「a time delta in wallclock milliseconds behind the live edge」で、earliest available content は現在の wallclock から本値を引いた threshold より後の wallclock を持つ最初の Group として求める (`msf-02:1927-1948`)。同一 alternate group の track は同じ値 MUST (`msf-02:1946-1947`)。Appendix A.1.4 (`msf-02:5477-5478`)。
- draft-01: `accessibleWindowTime` は存在しない (`rg 'accessibleWindowTime' refs/moq/draft-ietf-moq-msf-01.txt` は 0 件)。§7 冒頭にも trim / 適用の要求は無い (`msf-01:2805-2812`)。
- 現行実装: `CatalogTrack` に `accessibleWindowTime` が無く (`src/msf/types.ts:100-226`)、`KNOWN_TRACK_FIELDS` にも無い (`src/msf/catalogTrackValidation.ts:28-71`)。したがって decode では未知フィールドとして値がそのまま保持され (`src/msf/catalogTrackValidation.ts:117-123`)、encode で再出力される (`src/msf/catalogCodec.ts:107-112`) が、型が無く、数値検証も無く、playout / timeline 側で参照するコードも無い。media timeline の consumer 自体が存在しない (TL-07)。
- 必要な変更: (1) `accessibleWindowTime?: number` を `CatalogTrack` と `KNOWN_TRACK_FIELDS` に追加し、有限数として検証する。(2) media timeline の consumer を実装する際に「現在の wallclock - accessibleWindowTime より古い entry を捨てる」helper を提供する (MUST の適用点)。(3) publisher 側で timeline を trim する helper (SHOULD)。(4) 同一 alternate group で値が一致する MUST の検証 (`src/msf/tracks.ts` の group 判定 helper を再利用できる: `src/msf/tracks.ts:156-167`)。
- 互換性影響: フィールド追加は受理集合が広がる方向 (未知として既に受理している) だが、数値以外を拒否する検証を追加すると受理集合が狭くなる。draft-02 のカタログは数値なので実害は無い。
- 優先度: P1 (「購読側 MUST」を満たす実装が無い。ただし timeline を消費する機能自体が未実装)

#### TL-11 template を持つ track は別の media timeline track を持たない SHOULD

- 仕様 (draft-02): §5.2.16 「Tracks that include a template field SHOULD NOT also have a separate media timeline track, as the template provides equivalent functionality.」 (`msf-02:1490-1492`)。§7.4 も「a media timeline template MAY be used instead of an explicit media timeline track」 (`msf-02:3454-3456`)。
- draft-01: 同一の SHOULD が §5.2.15 に存在 (`msf-01:1089-1092`)。
- 現行実装: `template` の型検証はあるが (`src/msf/catalogTrackValidation.ts:233-236`)、同一 catalog 内の「template 付き track」と「mediatimeline track」の併用を検出しない (catalog 全体を見る検証が無い)。
- 必要な変更: なし (SHOULD であり、自動検出は false positive になり得る)。JSDoc に SHALL でないことを明記する程度。
- 互換性影響: なし。
- 優先度: P2

### 3.2 Event Timeline (TL-12 〜 TL-22)

#### TL-12 index key が小文字 (`t` / `l` / `m`) から大文字 (`T` / `L` / `M`) に変わった

- 仕様 (draft-02): 「An index reference, which MUST be either 'T' for wallclock time, 'L' for Location or 'M' for Media PTS. Only one of these index values may be used within each record. Event timelines SHOULD use the same index reference type for each record.」 (`msf-02:3620-3623`)。例はすべて大文字 (`msf-02:3608-3611`、`3717-3743`、`3749-3766`、`3772-3810`)。Appendix A.1.5: 「Index keys changed from lowercase ('t', 'l', 'm') to uppercase ('T', 'L', 'M').」 (`msf-02:5482-5483`)。
- draft-01: 「An index reference, which MUST be either 't' for wallclock time, 'l' for Location or 'm' for Media PTS.」 (`msf-01:2997-2999`)。例も小文字 (`msf-01:3051-3054`、`3090-3093`)。
- 現行実装: encode は常に小文字 key を書き (`src/msf/timeline.ts:111-122`)、decode は小文字 key しか読まない (`src/msf/timeline.ts:154-172`)。`isEventTimelineEntry` の「ちょうど 1 つ」検証も小文字のみを数える (`src/msf/timeline.ts:195-219`) ため、大文字 key のレコードは `indexCount === 0` で `invalid event timeline entry at index N` になる。型も小文字フィールド (`src/msf/types.ts:380-392`)。
- 必要な変更: (1) `EventTimelineEntry` のフィールドを `T` / `L` / `M` に変更する (公開型: `src/msf.ts:36-43`、`src/index.ts:159-160`)。(2) encode / decode / 検証を大文字へ変更する。(3) 後方互換を残すなら、decode で小文字も受理しつつ内部表現へ正規化するか、別名フィールドを deprecated として残す。ただし「両方を受け入れる」と draft-01 の壊れた payload を draft-02 環境で受理し続けることになるため、推奨は大文字のみ + CHANGES で破壊的変更として告知。(4) devtools の `buildMessageEventEntry` (`devtools/src/utils/eventTimeline.ts:33-35`) と `MessageList.tsx:39` の `entry.t` を更新する。(5) 「ちょうど 1 つ」検証は維持する (仕様の MUST は変わっていない)。
- 互換性影響: **wire 互換性が壊れる (双方向)**。draft-01 の publisher の event timeline は -02 実装では parse できず、逆も同様。公開型のフィールド名変更は TypeScript 利用者のコードを壊す。devtools の表示と送信も同時に直す必要がある。
- 優先度: P0

#### TL-13 `data` が任意の JSON 値になった

- 仕様 (draft-02): 「A 'data' field, a JSON value whose structure is defined by the eventType Section 5.2.6 value declared for this track in the Catalog.」 (`msf-02:3630-3632`)。Appendix A.1.5 (`msf-02:5483`)。
- draft-01: 「A 'data' Object, whose structure is defined by the Section 5.2.5 value ...」 (`msf-01:3007-3008`)。オブジェクトに限定した記述。
- 現行実装: 型は既に `data: unknown` で「任意の JSON 値 (オブジェクト、配列、文字列、数値等)」と明記している (`src/msf/types.ts:374-392`)。decode は `data` キーの存在のみを要求し (`src/msf/timeline.ts:191-193`)、値の型は問わない。`null` も受理する (`undefined` のみ拒否)。encode は値をそのまま載せる (`src/msf/timeline.ts:108-109`)。
- 必要な変更: なし。draft-01 の「Object」という記述より緩く実装していたため、-02 で仕様に追いついた形。JSDoc の「§8.1」を §8.2 に更新する (TL-23)。なお `data: undefined` は encode すると key が消え、自分の decode が拒否する (既存の契約どおり)。`data: null` は仕様上有効な JSON 値なので受理を維持する。
- 互換性影響: なし。
- 優先度: P2

#### TL-14 Event Timeline header data と `MSF_EVENT_TIMELINE_HEADER` が追加された

- 仕様 (draft-02): §8.1 「Certain event payloads require header data ... This header data is communicated by the MSF_EVENT_TIMELINE_HEADER Track property Section 12.3.1. Subscribers to an Event Timeline Track MUST check for the presence of this track property before parsing the payload of the event timeline track. Usage of this track property is optional. Absence ... indicates that no header data is provided.」 (`msf-02:3554-3570`)。§8.1.1 の例では header は `{"crs": "WGS84", "fields": [...], "altitudeUnit": "meter"}` のような JSON オブジェクト (`msf-02:3598-3602`)。§12.3.1: Property Type 0x7B、値の serialization は event timeline type (§5.2.6) が定義し、PUBLISH / SUBSCRIBE_OK / FETCH_OK に載せる MUST (`msf-02:4728-4742`)。Appendix A.1.5 (`msf-02:5493-5494`)。
- draft-01: header data の概念自体が無い (§8.1 `msf-01:2990-3008`)。
- 現行実装: 該当 property の定数・scope・encode/decode helper・payload と組にした API が無い (`src/properties.ts:324-407` の ID 表に 0x7B は無い)。`decodeEventTimeline(data)` は payload だけを受け取り (`src/msf/timeline.ts:136`)、header を渡す引数も返す口も無い。track properties から読むには `decodeProperties` の生配列を利用者が走査するしかなく、さらに `resolveTrackProperty` は奇数 ID を解決できない (PROP-09)。
- 必要な変更: (1) PROP-06 の property 定義 (定数 0x7BN、scope は Track のみ、encode/decode helper)。(2) subscriber 向けに「track properties から header を取り出す helper」と「header を渡して payload を parse する API」を用意し、header の有無を確認せずに parse しない構造を提供する (MUST を満たすための API 設計)。(3) decode の戻り値を `{ header, entries }` にするか、header を別関数で解決するかを決める。(4) header は eventType ごとに任意の JSON なので、`JSON.parse` の失敗は property の不正として扱い、payload の parse とは別のエラーにする。
- 互換性影響: 追加のみ (既存 API はそのまま)。ただし「header を確認せずに parse する」既存コードは MUST 違反になるため、docs で明示する。
- 優先度: P1 (購読側 MUST。実装しないと draft-02 の event timeline を正しく解釈できない)

#### TL-15 eventtimeline の `depends` MUST が条件付きに変わった

- 仕様 (draft-02): §8.3 の MUST は `packaging` と `eventType` の 2 つ (`msf-02:3647-3653`)。`depends` は「If an Event Timeline track has an index reference which refers to one or more Media Timeline tracks, then those Media Timeline tracks MUST be listed in a 'depends' Section 5.2.15 field」という条件付き (`msf-02:3655-3658`)。Appendix A.1.5: 「depends and mimeType are no longer required.」 (`msf-02:5496`)。
- draft-01: 「a Section 5.2.14 attribute which contains an array of all track names to which the event timeline track applies.」 (`msf-01:3016-3017`) → 無条件 MUST。
- 現行実装: `packaging === "eventtimeline"` のとき `track.depends === undefined` なら throw する (`src/msf/catalogTrackValidation.ts:473-475`)。テストも固定している (`src/msf.test.ts:1182-1199`、`src/msf.test.ts:1124-1138` は depends をわざわざ補っている)。devtools は常に `depends` を載せている (`devtools/src/hooks/usePublisher.ts:389-398`)。
- 必要な変更: 無条件 MUST を削除し、条件付き (index が media timeline track を参照する場合のみ) の検証に置き換える。条件判定には payload の index (`L` / `M` が media timeline の Location / PTS を参照するか、`T` は wallclock なので参照しない) と catalog の media timeline track 一覧が必要で、catalog 検証だけでは決まらない。したがって (a) catalog 検証では「`depends` がある場合は型のみ検証」、(b) 実際の MUST 検証は「event timeline と media timeline を組で扱う機能」または利用者向けの検証 helper で行う、という分担にする。
- 互換性影響: 受理集合が広がるが、draft-01 の相手は `depends` を要求するため、こちらの出力から `depends` を消すと draft-01 の相手に拒否される可能性がある。互換のため「参照先がある場合は従来どおり載せる」実装を維持するのが無難。
- 優先度: P0 (draft-02 適合カタログを拒否している)

#### TL-16 eventtimeline の `mimeType` MUST が削除された

- 仕様 (draft-02): §8.3 に `mimeType` の要求は無い (`msf-02:3645-3658`)。Appendix A.1.5 (`msf-02:5496-5497`)。
- draft-01: 「a Section 5.2.19 attribute with a value of "application/json".」 (`msf-01:3019-3020`)。
- 現行実装: `track.mimeType !== "application/json"` なら throw する (`src/msf/catalogTrackValidation.ts:476-482`)。テストで固定 (`src/msf.test.ts:1182-1199`、`src/msf.test.ts:618-644`)。
- 必要な変更: 当該分岐を削除する。`mimeType` は §5.2.20 の任意フィールドとして受理する。
- 互換性影響: 受理集合が広がる (draft-02 適合カタログの受理)。draft-02 の §8.1.1 の例は `mimeType` を持たない (`msf-02:3585-3594`) ため、現行実装はこの例を拒否する。
- 優先度: P0

#### TL-17 index が参照する media timeline track を `depends` に列挙する MUST が追加された

- 仕様 (draft-02): 「If an Event Timeline track has an index reference which refers to one or more Media Timeline tracks, then those Media Timeline tracks MUST be listed in a 'depends' Section 5.2.15 field.」 (`msf-02:3655-3658`)。Appendix A.1.5: 「depends MUST list any media timeline tracks that the index references.」 (`msf-02:5496-5497`)。
- draft-01: この要求は無い (`msf-01:3012-3030`)。
- 現行実装: `depends` の内容と payload の index (`L` / `M`) の対応を検証しない。そもそも catalog と payload を組で検証する API が無い (TL-14 / TL-15)。
- 必要な変更: 「event timeline track の payload が `L` / `M` を持つとき、catalog の `depends` に media timeline track が列挙されているか」を検証する helper を追加する。catalog 単体では決まらないため、event timeline を購読する側 (または publisher の送信前検証) で行う。devtools は `T` (wallclock) のみを使う (`devtools/src/utils/eventTimeline.ts:28-35`) ため、現状の devtools には影響しない。
- 互換性影響: 追加検証のみ。既存の `T` index の publisher には影響しない。
- 優先度: P1 (MUST。実装しないと draft-02 の整合性を保証できない)

#### TL-18 record と Group の対応が eventType ごとに定義されるようになった

- 仕様 (draft-02): 「The mapping of Event Timeline payloads to MOQT Groups is defined by the 'eventType'. If the data in the event timeline track is to be consumed as a sequence, then the publisher SHOULD publish an independent event timeline in the first MOQT Object of each MOQT Group ... The publisher MAY publish incremental updates in the second and subsequent Objects within each Group. ... If the data in the event timeline track is independent of its history, then the publisher SHOULD publish each record in its own MOQT Group and use a single MOQT Object per MOQT Group.」 (`msf-02:3662-3678`)。Appendix A.1.5 (`msf-02:5499-5501`)。
- draft-01: すべての event timeline に対して「MUST publish an independent event timeline in the first MOQT Object of each MOQT Group / MUST contain all records」を課していた (`msf-01:3034-3042`)。eventType ごとの区別も、history-independent のパターンも無い。
- 現行実装: ライブラリは record と Group の対応を規定せず、helper も提供しない (`src/msf/timeline.ts` は payload の encode/decode のみ)。devtools の publisher は「1 record = 1 Group、Group の先頭 Object 1 に全履歴」で送る (`devtools/src/hooks/usePublisher.ts:2053-2055`、`2288-2310`)。これは sequential パターンの「Group 先頭 Object は独立した全履歴」に一致し、2 番目以降の Object を送らないため矛盾はしない。一方、history-independent パターン (1 record per Group、Group あたり 1 Object) を実装した publisher は存在しない。devtools のコメントは draft-01 の MUST を根拠にしている (`devtools/src/utils/eventTimeline.ts:19-24`、`devtools/src/hooks/usePublisher.ts:2283-2287`)。
- 必要な変更: (1) `devtools` と docs のコメントを「SHOULD / eventType ごとの定義」に更新する (MUST ではなくなった)。(2) ライブラリとして「sequential 用の履歴管理 helper」と「history-independent 用の 1 record per Group helper」を提供するか方針を決める。現状は利用者任せであり、少なくとも docs で両パターンを示す。(3) devtools の `EVENT_HISTORY_LIMIT = 100` は「アクセス可能な履歴」を上限で切る実装であり、-02 の「accumulated and accessible up to that point」の解釈として妥当だが、SHOULD なので厳密性は要求されない。
- 互換性影響: なし (wire は変わらない)。Group 構成の指針が変わるだけ。
- 優先度: P1 (実装方針と docs の更新が必要。devtools のコメントが古い MUST を根拠にしている)

#### TL-19 §8.5 へ移動し、well-known type の初期登録 4 件が削除された

- 仕様 (draft-02): §8.5 は 「The "MSF Event Timeline Types" registry (Section 14.2) is established by this document but has no initial entries; entries are registered by the specifications that define each event type」 (`msf-02:3683-3686`)。§14.2 も「The initial contents of this registry are empty.」 (`msf-02:5025-5027`)。Custom type は Reverse Domain Name Notation を SHOULD (`msf-02:3707-3711`)。Appendix A.1.8 (`msf-02:5556-5560`)。
- draft-01: §10.5 (`msf-01:3255-3283`) に「Publishers SHOULD use registered types when applicable」があり、§14.2 のレジストリに 4 件 (`urn:scte:scte35:2013:bin`、`urn:scte:scte35:2013:xml`、`urn:msf:timedtext:webvtt`、`urn:msf:timedtext:imsc1`) が初期登録されていた (`msf-01:3860-3885`)。
- 現行実装: event type の定数は存在しない (`rg 'urn:scte|urn:msf|scte35|webvtt|imsc1' src/ --glob '!*.test.ts'` は 0 件)。`eventType` は任意の文字列として受理する (`src/msf/catalogTrackValidation.ts:166-179`)。したがって「4 件の初期登録」に依存したコードは無く、削除対象も無い。devtools は自前の逆ドメイン名を使っている (`devtools/src/utils/eventTimeline.ts:15-16`) ため、-02 の SHOULD に適合する。
- 必要な変更: なし。devtools のコメントにある「§10.5」の参照を §8.5 に更新する (TL-23)。将来 registry の型を定数化する場合は、初期値が空であることに注意する (SCTE-35 / WebVTT / IMSC1 は個別仕様側の登録になる)。
- 互換性影響: なし。
- 優先度: P2

#### TL-20 event timeline track が `publishTracks` に出現し得ることが明記された

- 仕様 (draft-02): 「Event timeline tracks can be present in both the 'tracks' and 'publishTracks' arrays, implying that they can be both consumed and produced by an endpoint.」 (`msf-02:3551-3552`)。Appendix A.1.5: 「Event timeline tracks may appear in publishTracks.」 (`msf-02:5503`)。
- draft-01: この記述は無い (`msf-01:2973-2988`)。ただし publishTracks 自体は存在し (`msf-01:819-829`)、-01 の validation でも eventtimeline を publishTracks に置くことは型的に可能だった。
- 現行実装: `Catalog.publishTracks` は `PublishTrack extends CatalogTrack` として受理し (`src/msf/types.ts:234-240`)、`validateCatalogTrack` は `source: "publishTracks"` でも packaging 別ルールを適用する (`src/msf/catalogValidation.ts:106-116`、`src/msf/catalogTrackValidation.ts:107-115`)。したがって eventtimeline を publishTracks に置くと、TL-15 / TL-16 の過剰な MUST (depends / mimeType) が適用されて拒否される。また publishTracks 専用フィールドは `connectionUri` / `token` のみを許可する (`src/msf/catalogTrackValidation.ts:326-350`、`src/msf/catalogValidation.ts:416-428`)。なお `token` は -02 で track から削除された (Appendix A.1.3: `msf-02:5444-5446`) が、これは catalog 担当の範囲。
- 必要な変更: TL-15 / TL-16 を直せば eventtimeline を publishTracks に置けるようになる。追加の変更として、publishTracks の eventtimeline track でも `eventType` 必須 (Table 6: `msf-02:1187-1196`) が適用されることをテストで固定する。高レベル publisher は publishTracks を生成しない (`src/createMediaPublisher.ts:2107-2165`) ため、ライブラリ利用者が `createCatalog` に publishTracks を渡す経路のみ。
- 互換性影響: 受理集合が広がる。既存の publishTracks 出力には影響しない。
- 優先度: P1 (TL-15 / TL-16 の一部だが、publishTracks 経路の検証が未整備)

#### TL-21 media time indexing の例が追加された

- 仕様 (draft-02): §8.6.3 に `M` (media PTS) index の例が追加された (`msf-02:3768-3810`)。§8.6.2 は `L` (`msf-02:3745-3766`)、§8.6.1 は `T` (`msf-02:3715-3743`)。
- draft-01: `t` と `l` の例のみ (`msf-01:3046-3099`)。`m` の例は無い。
- 現行実装: `m` は型・encode・decode とも対応済み (`src/msf/types.ts:387-388`、`src/msf/timeline.ts:120-122`、`169-172`)。ただし key は小文字 (TL-12)。
- 必要な変更: TL-12 の変更後、§8.6.3 の例をそのままテストデータとして追加する (media time indexing の round-trip テスト)。特に `data` がネストしたオブジェクト (bounding_box など) である点を固定する。
- 互換性影響: なし。
- 優先度: P2

#### TL-22 wallclock の定義が §11.6 に移動し、「エンコーダーに入った時刻」に変わった

- 仕様 (draft-02): §7.1.1 の第 3 要素は「the wallclock time at which the content, represented by the media presentation timestamp, entered the encoder. Wallclock time is defined by Section 11.6.」 (`msf-02:3387-3390`)。§11.6: 「expressed as the number of milliseconds elapsed since the Unix epoch (1970-01-01T00:00:00Z), excluding leap seconds, as defined for "Seconds Since the Epoch" in [POSIX], scaled to milliseconds」 (`msf-02:4564-4571`)。Appendix A.1.3: 「targetLatency and timeline wallclock values are now defined relative to when content entered the encoder.」 (`msf-02:5455-5457`)。
- draft-01: 「the wallclock time at which the media was encoded, defined as the number of milliseconds that have elapsed since January 1, 1970 (midnight UTC/GMT)」 (`msf-01:2840-2843`)。
- 現行実装: 単位 (Unix epoch ミリ秒) は同一で、型は number (`src/msf/types.ts:361-368`)。VOD の 0 SHOULD も同じ (`src/msf/timeline.ts:28-34` で値域検証なし)。「エンコーダーに入った時刻」という意味の差は実装に影響しない (値は publisher が決める)。
- 必要な変更: なし (JSDoc の説明を「エンコーダーに入った時刻 (Unix epoch ミリ秒)」に更新する)。
- 互換性影響: なし。
- 優先度: P2

### 3.3 横断 (TL-23 〜 TL-24)

#### TL-23 節番号の繰り下げ (JSDoc / エラーメッセージ / テスト期待値)

- 仕様 (draft-02): §5.2 に `packagingMetadata` が挿入された (`msf-02:1205-1224`) ため、eventType 以降の節番号が 1 つ繰り下がる。timeline 関連の対応表:

  | フィールド                 | draft-01                | draft-02                |
  | -------------------------- | ----------------------- | ----------------------- |
  | eventType                  | §5.2.5 (`msf-01:874`)   | §5.2.6 (`msf-02:1225`)  |
  | renderGroup                | §5.2.11 (`msf-01:1034`) | §5.2.12 (`msf-02:1426`) |
  | initRef                    | §5.2.13 (`msf-01:1055`) | §5.2.14 (`msf-02:1447`) |
  | depends                    | §5.2.14 (`msf-01:1069`) | §5.2.15 (`msf-02:1461`) |
  | template                   | §5.2.15 (`msf-01:1079`) | §5.2.16 (`msf-02:1480`) |
  | mimeType                   | §5.2.19 (`msf-01:1129`) | §5.2.20 (`msf-02:1532`) |
  | Event timeline data format | §8.1 (`msf-01:2990`)    | §8.2 (`msf-02:3613`)    |
  | Event timeline catalog     | §8.2 (`msf-01:3010`)    | §8.3 (`msf-02:3645`)    |
  | Event timeline updating    | §8.3 (`msf-01:3032`)    | §8.4 (`msf-02:3660`)    |
  | well-known event types     | §10.5 (`msf-01:3255`)   | §8.5 (`msf-02:3680`)    |
  | Presenting Authorization   | §11.4.3 (`msf-01:3673`) | §11.5.3 (`msf-02:4513`) |
  | Wallclock time             | 無し                    | §11.6 (`msf-02:4564`)   |

- draft-01: 上記の左列。
- 現行実装: すべての JSDoc とエラーメッセージが draft-01 番号 (`src/msf/timeline.ts:2`、`src/msf/types.ts:2`、`src/msf/catalogTrackValidation.ts:449-513`、`src/msf/catalogValidation.ts:397-401` など)。テストもエラーメッセージの `§5.2.14` などを固定している (`src/msf.test.ts:461`)。
- 必要な変更: 機械的に置換する。特にエラーメッセージはテストの正規表現と連動するため、同時に更新する。利用者に露出するメッセージの変更なので CHANGES に記載する。
- 互換性影響: 動作は変わらないが、エラーメッセージ文字列に依存するテストと利用者コードが壊れる。
- 優先度: P2 (ただし変更量が多く、TL-04 / TL-05 / TL-15 / TL-16 の修正と同時に行うのが効率的)

#### TL-24 catalog version が `draft-02` になった (decode 拒否 / encode 不一致)

- 仕様 (draft-02): 「For usage against IETF Internet-Draft releases, follow the convention of specifying the version as "draft-XX". For example "draft-03" refers to the -03 draft release.」 (`msf-02:786-790`)。すべての例が `"version": "draft-02"` (`msf-02:2703`、`2806`、`2923`、`2993`、`3030`)。Subscriber は理解できない version を parse してはならない (`msf-02:778-780`)。Appendix A.1.1: 「Catalog examples ... now use "draft-02" as the version string.」 (`msf-02:5364-5366`)。
- draft-01: `"draft-01"` (例: `msf-01:2094` 付近)。Subscriber の MUST NOT parse は同じ (`msf-01:772-780`)。
- 現行実装: `MSF_VERSION = "draft-01"`、`MSF_KNOWN_VERSIONS = {"draft-01", "1"}` (`src/msf/version.ts:22-33`)。`validateCatalog` は未知 version を拒否する (`src/msf/catalogValidation.ts:55-60`)。`encodeCatalog` は出力を自己 decode するため (`src/msf/catalogCodec.ts:114-124`)、`version: "draft-02"` を設定しても encode の段階で拒否される。
- 必要な変更: `MSF_VERSION = "draft-02"` にし、`MSF_KNOWN_VERSIONS` の扱いを決める。選択肢は (a) `draft-02` のみ受理 (draft-01 との相互接続を切る; wire の event timeline index も変わるため一貫している)、(b) `draft-01` も受理し version 別の timeline 規則を適用 (互換性は高いが実装が二重化する)。推奨は (a) で、CHANGES に破壊的変更として記載する。(b) を選ぶ場合、`EventTimelineEntry` の key 変換を version 別に行う必要があり、TL-12 の実装が複雑になる。
- 互換性影響: **wire 互換性が壊れる (双方向)**。現行 publisher は `draft-01` を送出するため、draft-02 のみを理解する実装は本ライブラリの catalog を拒否する。逆に draft-02 の catalog は現行実装が拒否する。timeline の全例が `draft-02` なので、この項目を直さないと TL-04 / TL-05 / TL-15 / TL-16 の修正を検証できない。
- 優先度: P0 (catalog / version 担当の範囲だが、timeline の前提。担当が別なら依存として連携する)

### 3.4 MSF Properties / レジストリ (PROP-01 〜 PROP-10)

#### PROP-01 `MSF_COMPRESSION` Track / Object property (0x78) の定義が無い

- 仕様 (draft-02): §12.1.1 「Track Property type: 0x78」 (`msf-02:4625-4627`)、PUBLISH / SUBSCRIBE_OK / FETCH_OK に載せる MUST (`msf-02:4634-4636`)、購読側は payload 処理前に確認する MUST (`msf-02:4638-4639`)、未対応値なら処理せず unsubscribe する SHOULD (`msf-02:4653-4657`)。§12.1.2 「Object Property type: 0x78」 (`msf-02:4659-4661`)、圧縮した object ごとに載せる MUST (`msf-02:4670-4671`)、購読側は object ごとに確認する MUST (`msf-02:4673-4678`)。値は varint の algorithm 番号 (Table 14: 0 = None、1 = GZIP、`msf-02:4610-4620`)。
- draft-01: §14.3 で「MSF_COMPRESSION / TBD / varint」として IANA 登録を要求 (`msf-01:3887-3903`)。Property ID が TBD のため実装不能とされていた (§12.1 自体は `msf-01:3732-3830` に存在)。
- 現行実装: algorithm 定数のみ (`src/properties.ts:41-44`)。Property ID 定数は無く、「IANA 未割当 (TBD) のため encode/decode helper も併用 MUST NOT 検証も未実装」とコメントで明記 (`src/properties.ts:36-39`)。`TrackPropertyId` にも `MOQTPropertyId` にも 0x78 は無い (`src/properties.ts:324-407`)。`PROPERTY_SCOPES` / `SUPPORTED_PROPERTY_TYPES` にも無い (`src/properties.ts:557-583`、`590-604`)。したがって 0x78 は未知 property として値だけが保持され、意味を解釈するコードが無い (`src/properties.ts:1857-1876`) ため、gzip の payload は JSON として parse されて失敗する。
- 必要な変更: (1) `MSF_COMPRESSION` の Property Type 定数 0x78 を追加する (Track / Object で共用)。(2) `PROPERTY_SCOPES` に 0x78 → "both" を追加し、`SUPPORTED_PROPERTY_TYPES` に加える (scope 違反を malformed にするため)。(3) 偶数 ID なので varint value 形式 (`{id: 0x78n, value: 0n | 1n}`)。`resolveTrackProperty` は value 形式なのでそのまま使える。(4) `TrackPropertyId` ではなく MSF 用の名前空間 (例: `MsfPropertyId`) を新設するか、`properties.ts` の既存表に追記する。LOC の ID (`LOCPropertyId`) と MSF の ID が同一表で管理されている現状 (`src/properties.ts:557-583`) に合わせるのが自然。(5) 送信経路として `buildPublishTrackProperties` (`src/session/params.ts:446-581`) にオプションを追加する。(6) FETCH_OK の track properties は既存の REQUEST_OK 経路で扱えるため、追加の受信実装は不要 (確認は `src/session/` の REQUEST_OK デコード)。
- 互換性影響: 未知 property として無視していた相手とは相互運用が変わる。0x78 を別用途で使う実装とは衝突し得るが、-02 で「アプリケーション固有範囲であり、独立に開発された拡張間で同じ値が使われ得る」と注意されている (`msf-02:5078-5086`) ため、仕様どおりのリスク。
- 優先度: P1 (MUST の一部。圧縮を使う対向実装との相互接続に必要)

#### PROP-02 Track / Object の排他規則と未対応 algorithm の扱いが未実装

- 仕様 (draft-02): 「A publisher MUST NOT use both mechanisms on the same track. If the track property is set, then every object in the track is compressed and the object property MUST NOT be present. If compression varies between objects, then the track property MUST NOT be set and the object property MUST be used on each compressed object.」 (`msf-02:4604-4608`)。「All MSF implementations MUST support both uncompressed payloads (value 0 or property absent) and GZIP compressed payloads (value 1).」 (`msf-02:4622-4623`)。未対応 algorithm を受けたら payload を処理しない MUST / unsubscribe する SHOULD (`msf-02:4653-4657`、`4676-4678`)。
- draft-01: 同一の排他規則と MUST サポート (`msf-01:3746-3760` 付近、`msf-01:3780-3830`)。変更なし。
- 現行実装: 排他規則を検証するコードは無い (property 自体が未実装のため)。未知 property は黙って読み飛ばすため、「未対応 algorithm なら処理しない」も実装されていない (結果として payload を JSON として処理してしまう)。
- 必要な変更: (1) 受信時: track properties に 0x78 があり、かつ object properties に 0x78 がある場合は Track を malformed とする (両方の情報が揃うのは受信経路のみ)。(2) 値が 0/1 以外なら payload を処理せず、購読を止める経路に流す (MUST NOT process / SHOULD unsubscribe)。値域検証を `validateTrackPropertyValue` に追加すると MALFORMED_KEY_VALUE でセッションを閉じてしまい「処理しない」という仕様の要求と一致しないため、値域エラーではなく「未対応 algorithm」として扱う分岐にする。(3) 送信時: 両方の指定を同時に受け付けない (MUST NOT)。
- 互換性影響: 追加検証のみ。ただし `assertKnownPropertyValuesInObjectPropertyList` に値域検証を追加すると、未知値を送る対向と切断されるため注意 (上記のとおり値域検証にはしない)。
- 優先度: P1

#### PROP-03 GZIP の実装 (MUST) と payload 経路が未実装 (ブロッカーは解消)

- 仕様 (draft-02): 「All MSF implementations MUST support both uncompressed payloads (value 0 or property absent) and GZIP compressed payloads (value 1).」 (`msf-02:4622-4623`)。対象は catalog (§5.5: `msf-02:2077-2087`)、media timeline (§7.1: `msf-02:3349-3351`)、event timeline (§8.2: `msf-02:3615-3617`)。Appendix A.1.8 (`msf-02:5536-5540`)。
- draft-01: 同じ MUST (`msf-01:3776-3778`)。Property ID は TBD (`msf-01:3893-3899`)。
- 現行実装: gzip の encode/decode 実装が無い (`rg 'gzip|GZIP|CompressionStream|DecompressionStream' src/ --glob '!*.test.ts'` はコメントと定数のみ)。`encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline` は無圧縮 JSON のみ (`src/msf/timeline.ts:27-36`、`45-69`、`107-129`、`136-176`)。`docs/MSF.md:28` と `docs/IMPLEMENTATION_STATUS.md:181` に「未実装」と明記。pending issue `issues/pending/0355-add-msf-compression-property.md` は「Property ID が TBD のため pending」としている (`同ファイル:16`、`39-41`)。
- 必要な変更: (1) `DecompressionStream("gzip")` / `CompressionStream("gzip")` を使う同期 API の設計 (現行 timeline API は同期関数。`docs/MSF.md:27` に「いずれも同期関数」と明記)。非同期化するか、圧縮/展開を呼び出し側に委ねるかを決める。(2) catalog / media timeline / event timeline の 3 経路で共通の「track property → 圧縮有無」「object property → 圧縮有無」判定を実装する。(3) 受信側は「track property が 0x78 = 1 なら全 object が gzip」「object property が 0x78 = 1 ならその object のみ gzip」を適用する。(4) 展開後のサイズ上限を設ける (§13.1 のセキュリティ要求: 「subscribers MUST bound decompressed object size」: `msf-02:5353-5354`)。
- 互換性影響: 追加。ただし未対応のまま -02 の圧縮カタログを受信すると、property を無視して解析に失敗する (silent failure)。エラーを「未対応 algorithm のため処理しない」と区別できるようにする。
- 優先度: P1 (MUST だが、圧縮を送らない相手とは従来どおり相互接続できる。ID 確定により実装可能になった)

#### PROP-04 VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) は LOC として実装済み。§12.2 の initRef 連携が無い

- 仕様 (draft-02): §12.2 「VIDEO_CONFIG type 0x0D / AUDIO_CONFIG type 0x0F ... carries the initialization data for a track with a track role type of "video" / "audio"」 (`msf-02:4680-4694`)。初期化データが track の寿命で不変なら Track property として載せ、`initRef` で `initDataList` の `track-property` 型エントリを参照する MUST。可変なら Object property として載せ、`initRef` で `object-property` 型エントリを参照する MUST。Object property は Group の最初の Object に載せる SHOULD (`msf-02:4709-4724`)。Appendix A.1.8 (`msf-02:5549-5551`)。
- draft-01: §12 にはこの節が無い (初期化データは catalog の `initDataList` の `inline` のみ: `msf-01:692-719`)。したがって §12.2 は -02 の新規要求。
- 現行実装: `LOCPropertyId.VIDEO_CONFIG = 0x0dn` / `AUDIO_CONFIG = 0x0fn` として定義済み (`src/loc.ts:84`、`89`)。encode/decode は length + bytes 形式 (`src/loc.ts:523-547`、`549-570`、`572-596`、`598-626`)。Track / Object 両 scope として扱い (`src/properties.ts:557-583`、`590-604` の 0x0D / 0x0F)、Object 優先・Track フォールバックで解決する (`src/loc.ts:794-850`、`967-981`、`992-1006`)。送信側の Track property 経路もある (`src/session/params.ts:527-546`)。したがって **property の wire 形式と両 scope の扱いは既に実装済み**。一方、catalog 側の `initRef` / `initDataList` 連携は無く、高レベル publisher は `initDataList` を生成しない (`src/createMediaPublisher.ts:1959-1961`)。高レベル publisher は VIDEO_CONFIG / AUDIO_CONFIG を Object property として送る (`src/createMediaPublisher.ts:2512-2542`、`2664-2698`、`docs/ARCHITECTURE.md:142-165`) が、`initRef` を持たないため §12.2 の MUST を満たさない。
- 必要な変更: (1) 高レベル publisher が VIDEO_CONFIG / AUDIO_CONFIG を Object property として送る場合、catalog の track に `initRef` を追加し、`initDataList` に `type: "object-property"`, `data: "0x0D"` / `"0x0F"` のエントリを追加する。(2) Track property として送る場合 (`options.locVideoConfig` / `locAudioConfig` 利用時) は `type: "track-property"` のエントリを追加する。(3) subscriber 側で `initRef` → `initDataList` の type を見て、対応する property の値を初期化データとして解決する helper を追加する (PROP-05)。
- 互換性影響: catalog に `initRef` / `initDataList` が増えるため、カタログのサイズが増える。draft-01 の相手は未知フィールドとして無視する (parser MUST ignore unknown fields) ため破壊的ではない。ただし §5.1.7 で initDataList は tracks の後に置く SHOULD がある (`msf-02:922-926`) ため、エンコード順に注意する。
- 優先度: P1 (仕様の MUST。ただし draft-01 からの差分ではなく新規要求)

#### PROP-05 initDataList の `track-property` / `object-property` type が未対応

- 仕様 (draft-02): §5.1.7 の type は `inline` (Base64)、`track-property` (Track property type を hex 表記)、`object-property` (Object property type を hex 表記) の 3 種 (`msf-02:898-912`)。「For both the track-property and object-property types, the initialization data is serialized as raw binary data and carried in the value field of the initialization properties, see Section 12.2.」 (`msf-02:918-921`)。initDataList は tracks の後ろに置く SHOULD (`msf-02:922-926`)。Appendix A.1.3 (`msf-02:5448`)。
- draft-01: type は `inline` のみ (`msf-01:702-712`)。
- 現行実装: `InitDataEntry.type` は型としては任意の文字列を受けるが、JSDoc は「現バージョンでは `inline` のみ定義」としている (`src/msf/types.ts:27-39`)。decode の検証は type が string であることだけを見る (`src/msf/catalogValidation.ts:315-343`)。`resolveInitData` は `type !== "inline"` なら `undefined` を返す (`src/msf/tracks.ts:32-39`)。したがって **値をそのまま返さない点は安全** (Base64 でない生バイナリを文字列として返さない) が、`track-property` / `object-property` を解釈する経路が無い。
- 必要な変更: (1) `InitDataEntry.type` を union (`"inline" | "track-property" | "object-property"`) にし、decode で未知 type を拒否するかは設計判断 (将来の拡張に備えるなら string のまま)。(2) `resolveInitData` を拡張し、`track-property` / `object-property` の場合は「property type の hex 文字列」を返す別関数 (例: `resolveInitPropertyType`) を追加する。(3) 実際の初期化データは property の値から取るため、`track properties` / `object properties` と `initRef` を組にした解決 helper を追加する。(4) `data` の hex 表記 (`"0x0D"` など) の parse を実装する。
- 互換性影響: 受理集合が広がる。既存の `inline` のみのカタログはそのまま動く。
- 優先度: P1 (PROP-04 と一体)

#### PROP-06 `MSF_EVENT_TIMELINE_HEADER` (0x7B) の property 定義が無い

- 仕様 (draft-02): §12.3.1 「Track Property type: 0x7B ... carries header data for an Event Timeline track. This initialization data is immutable over the life of the track. The serialization of the value of the property is defined by the Event timeline type Section 5.2.6. If used, publishers MUST include ... in the PUBLISH message ... or SUBSCRIBE_OK message or FETCH_OK.」 (`msf-02:4728-4742`)。§14.3 で 0x7B はアプリケーション固有範囲 (IANA 登録不要) (`msf-02:5075-5078`)。Appendix A.1.5 / A.1.8 (`msf-02:5493-5494`、`5559-5561`)。
- draft-01: 存在しない。
- 現行実装: 定数・scope・helper が無い (`src/properties.ts:324-407`)。奇数 ID なので length + bytes 形式 (`{id: 0x7Bn, data: Uint8Array}`) で、`decodeProperties` は未知の奇数 ID として data を保持する (`src/properties.ts:1863-1885`) が、意味のある解決はできない。`resolveTrackProperty` は `value` を持つ property だけを返すため、0x7B は解決できない (`src/properties.ts:1520-1546`)。
- 必要な変更: (1) 定数 0x7BN を追加する。(2) `PROPERTY_SCOPES` に "track" を追加し、`SUPPORTED_PROPERTY_TYPES` に加える (Object property として受信したら malformed にする MUST を満たすため。§12.3.1 は Track property のみ)。(3) Track properties から 0x7B の data を取り出す helper を追加する (偶数専用の `resolveTrackProperty` では解決できない: PROP-09)。(4) header の JSON parse と payload decode を組にした API (TL-14)。(5) 送信側は `buildPublishTrackProperties` にオプションを追加する。(6) 値は eventType ごとに任意の JSON なので、property レイヤーでの内容検証はしない。
- 互換性影響: 追加。未対応のまま -02 の event timeline を購読すると header を無視して payload を解釈することになる (MUST 違反だが、ハードエラーにはならない)。
- 優先度: P1

#### PROP-07 §14.3 の Property Type 値レジストリと定数の照合

- 仕様 (draft-02): §14.3 「The MSF_COMPRESSION Track and Object properties (Section 12.1) use Property Type value 0x78. This value falls within the range that [MOQT], Section 8.4 reserves for application-specific use, for which IANA registration is not permitted. Accordingly, this document requests no IANA action ... The MSF_EVENT_TIMELINE_HEADER Track property (Section 12.3.1) uses Property Type value 0x7B, which falls within the same range ... Implementers should note the caveat ... an endpoint processing tracks from uncoordinated sources could encounter the same Property Type value used with different semantics.」 (`msf-02:5065-5086`)。§14 冒頭 (`msf-02:4973-4980`)。Appendix A.1.8 (`msf-02:5556-5561`)。
- draft-01: §14.3 は MSF_COMPRESSION を "Track Properties" レジストリへ登録要求 (Property ID は TBD) (`msf-01:3887-3903`)。0x7B は存在しない。
- 現行実装: 0x78 / 0x7B の定数は無い。MOQT の Property Type 範囲のコメント (0x78-0x7F がアプリケーション固有) は既にある (`src/properties.ts:458`)。pending issue `0355` は ID 未割当を pending 理由にしている。
- 必要な変更: 定数を追加する (PROP-01 / PROP-06)。**pending issue `0355` の「Property ID が TBD」というブロッカーは -02 で解消した**ので、issue を pending から進められる状態に更新する。IANA への登録要求は不要 (ドキュメント上の記述も「登録不要」に直す)。同じ 0x78 / 0x7B を別用途で使う実装との衝突リスクは仕様が明示しているため、docs に注意書きを入れる。
- 互換性影響: なし (定数追加のみ)。
- 優先度: P2 (PROP-01 / PROP-06 の一部。issue の状態更新を含む)

#### PROP-08 §14.4 の Compression Algorithms レジストリと定数の照合

- 仕様 (draft-02): §14.4 の初期値は 0 = None (uncompressed)、1 = GZIP で (`msf-02:5105-5115`)、2-127 は Standards Action、128 以上は private use で登録禁止 (`msf-02:5101-5103`)。Table 14 (本文) と同じ (`msf-02:4610-4620`)。
- draft-01: 同じ 0 / 1 の初期値 (`msf-01:3925-3937`)。変更なし。
- 現行実装: `MsfCompressionAlgorithm = { NONE: 0n, GZIP: 1n }` (`src/properties.ts:41-44`)。値は一致している。128 以上を private use として扱う定数は無い。
- 必要な変更: なし (値は一致)。private use の範囲を定数化するかは任意。テストの参照節番号を §14.4 Table 16 に更新する (`src/msf.test.ts:2707`)。
- 互換性影響: なし。
- 優先度: P2

#### PROP-09 `resolveTrackProperty` が奇数 ID (length + bytes) を解決できない

- 仕様 (draft-02): §12.3.1 の 0x7B は奇数 ID の length + bytes 形式 (`msf-02:4730-4737`)。§12.2 の 0x0D / 0x0F も奇数 (`msf-02:4686-4688`)。MOQT の KVP 形式では奇数 Type は length + bytes (`msf-02` の [MOQT] 参照)。
- draft-01: 同じ KVP 形式 (変更なし)。
- 現行実装: `resolveTrackProperty` は `property.value !== undefined` の property だけを返す (`src/properties.ts:1520-1546`)。したがって偶数 ID (varint value) 専用であり、奇数 ID の `data` を持つ property は解決できない。LOC はこれを使わず独自の `extractLocProperties` を持つ (`src/loc.ts:794-820`)。`resolveTrackProperty` の呼び出しは `DEFAULT_PUBLISHER_PRIORITY` / `DEFAULT_PUBLISHER_GROUP_ORDER` の 2 箇所のみ (`src/properties.ts:1561`、`src/session/params.ts:698`) で、いずれも偶数 ID。
- 必要な変更: 0x7B / 0x0D / 0x0F を解決するには、(a) `resolveTrackProperty` を「value または data を持つ property を返す」に一般化するか、(b) `resolveTrackPropertyData` のような別関数を追加する。既存の 2 呼び出しは value 前提なので、(b) の方が安全 (既存の戻り値型 `Property` の `value` を読むコードを壊さない)。Immutable Properties の内側を探す 2 パス構造 (`src/properties.ts:1526-1544`) を踏襲する。
- 互換性影響: なし (追加 API)。一般化する場合は既存呼び出しの型が変わるため注意。
- 優先度: P1 (TL-14 / PROP-06 の前提。これが無いと header も config も既存 helper で読めない)

#### PROP-10 property scope / 重複検証テーブルと PBT の更新

- 仕様 (draft-02): 0x78 は Track / Object の両方 (`msf-02:4627`、`4661`)、0x7B は Track のみ (`msf-02:4730`)。MOQT §8.4 の scope 違反は malformed、同一 Track / Object に 1 インスタンスのみ (実装の既存コメント: `src/properties.ts:548-556`、`613-621`)。0x78 の Track と Object の併用は MSF が別途 MUST NOT (`msf-02:4604-4608`)。
- draft-01: 0x78 の ID が無いため scope 表にも無い。
- 現行実装: `PROPERTY_SCOPES` に 0x78 / 0x7B が無い (`src/properties.ts:557-583`)。`SUPPORTED_PROPERTY_TYPES` にも無い (`src/properties.ts:590-604`)。`KNOWN_PROPERTY_TYPES` にも無い (`src/properties.ts:530-543`)。そのため未知 property として扱われ、scope 違反も重複も検出されない。
- 必要な変更: (1) `PROPERTY_SCOPES` に `[0x78n, "both"]`、`[0x7Bn, "track"]` を追加する。(2) `SUPPORTED_PROPERTY_TYPES` に両方を追加する (scope 違反検出と重複検出を有効にする)。(3) `KNOWN_PROPERTY_TYPES` への追加は任意。追加すると「既知 Type だが varint / length が壊れている」場合のエラーコードが MALFORMED_KEY_VALUE に変わる (`src/properties.ts:941-979`、`1966-1996`)。0x78 は varint 値なので追加してよいが、0x7B の値は任意の JSON バイト列なので serialization 制約を課してはならない (追加しても内容検証が無ければ影響は小さい)。(4) `properties.prop.ts` の arbitrary が 0x78 / 0x7B を生成し得る (`src/properties.prop.ts:34-44`、`218-265`) ため、**値域検証を追加してはならない** (0x78 の未対応 algorithm 値は受理しなければならない: PROP-02)。(5) テストの scope 一覧 (`src/properties.test.ts:1770-1789`) に 2 件を追加する。
- 互換性影響: scope 違反検出を有効にすると、従来受理していた「0x7B を Object property として送る」ようなワイヤが malformed になる。仕様どおりだが受理集合が狭くなる。
- 優先度: P1 (PROP-01 / PROP-06 と一体)

## 4. 未確認・範囲外・依存

### 4.1 未確認

- `msf-02` の §5 全体 (catalog の必須フィールド表、delta update の新仕様、variable substitution の変更) は本レポートの範囲外。§7.2 / §8.3 から参照する部分 (§5.2.4.1 Table 6、§5.2.15、§5.2.16、§5.2.45) のみ読んだ。
- `msf-02` の §11.6 以外の workflow (§11.1〜§11.5) は、timeline の wallclock 定義の参照先として §11.6 のみ読んだ。
- 高レベル API の `createMediaSubscriber` が event timeline を購読する経路は無い (`rg 'timeline' src/createMediaSubscriber.ts` は 0 件)。devtools のみが購読する (`devtools/src/hooks/useSubscriber.ts:170-172`、`1964`)。したがって「event timeline 購読の MUST (header 確認)」を満たすべき主体は現状 devtools とライブラリ利用者である。この整理が将来の高レベル API 追加で変わるかは未確認。
- `properties.ts` の 2571 行のうち、LOC 固有の Property 値検証 (CODEC_STRING / VIDEO_FRAME_MARKING / AUDIO_LEVEL) の細部は本レポートの対象外。0x78 / 0x7B の追加がそれらに影響しないことは確認した (ID が重複しない)。
- `draft-ietf-moq-msf-02.txt` の §14.2 の Expert Review の詳細 (`msf-02:5029-5064`) は実装に影響しないため要約のみ。
- 実際に `decodeCatalogMessage` に draft-02 の例を投入する実行確認は行っていない (リポジトリを変更できないため)。判定はコードの静的読解に基づく。エラーの発生箇所は `src/msf/catalogValidation.ts:55-60` (version) → `src/msf/catalogTrackValidation.ts:228-229` (depends) → `src/msf/catalogTrackValidation.ts:476-482` (mimeType) の順で、いずれも throw することがコード上明らか。
- `msf.prop.ts` の PBT が 0x78 / 0x7B を実際に生成して失敗するかは、arbitrary の分布に依存する (0x78 は偶数 ID の範囲 0x00-0xFE に含まれ、0x7B は奇数 ID の範囲 0x01-0xFF に含まれる)。値域検証を追加しない限り失敗しないと判断しているが、実際のシードでの出現は未確認。

### 4.2 依存する他担当の項目

- **catalog / version**: TL-24 (version `draft-02`)。本レポートの P0 項目 (TL-04 / TL-05 / TL-15 / TL-16) の検証には version の受理が必要。
- **depends 全般 (§5.2.15)**: 一般的な depends 解決 (String は catalog 内の track 名と一致、Number は renderGroup と一致、解決不能なら catalog は invalid) は depends 担当。本レポートは timeline 側の要求 (TL-05 / TL-06 / TL-17) に限定した。
- **§12.1 / §12.2 の property フレームワーク**: 本レポートは timeline の payload と property の結線を担当。property の一般的な encode/decode フレームワークの変更 (PROP-09 / PROP-10) は properties 担当と重複し得る。
- **catalog の track フィールド (accessibleWindowTime、packagingMetadata、initDataList の SHOULD 配置)**: TL-10 / PROP-05 は catalog 担当の範囲と重なる。
- **devtools**: TL-12 / TL-18 の変更は devtools の実装とテストに波及する (`devtools/src/utils/eventTimeline.ts`、`usePublisher.ts`、`useSubscriber.ts`、`MessageList.tsx`)。

## 5. 参考: 仕様の該当箇所一覧 (draft-02)

| 節      | 行        | 内容                                                                  |
| ------- | --------- | --------------------------------------------------------------------- |
| §7      | 3330-3346 | Media Timeline の概要、accessible window の trim SHOULD / 適用 MUST   |
| §7.1    | 3347-3368 | payload の形式、explicit / template の混在禁止、Group ID 非連続の許容 |
| §7.1.1  | 3370-3419 | explicit entry の 3 要素、media time 順、例                           |
| §7.2    | 3421-3438 | packaging / depends の MUST、renderGroup 参照規則、depends 更新 MUST  |
| §7.3    | 3440-3450 | 独立 object / 増分 object                                             |
| §7.4    | 3452-3460 | template の適用条件                                                   |
| §7.4.1  | 3462-3517 | 6 要素、計算式、例                                                    |
| §7.4.2  | 3519-3531 | template の不変性                                                     |
| §8      | 3533-3552 | Event Timeline の概要、publishTracks への出現                         |
| §8.1    | 3554-3570 | header data と購読側の確認 MUST                                       |
| §8.1.1  | 3572-3611 | header data の例                                                      |
| §8.2    | 3613-3643 | 大文字 index、data は任意の JSON 値                                   |
| §8.3    | 3645-3658 | packaging / eventType の MUST、条件付き depends                       |
| §8.4    | 3660-3678 | eventType ごとの Group マッピング                                     |
| §8.5    | 3680-3712 | well-known type (レジストリは初期空)                                  |
| §8.6    | 3713-3811 | payload 例 (T / L / M)                                                |
| §12.1   | 4583-4623 | 圧縮の 2 方式、排他、algorithm 表、GZIP MUST                          |
| §12.1.1 | 4625-4657 | MSF_COMPRESSION Track property (0x78)                                 |
| §12.1.2 | 4659-4678 | MSF_COMPRESSION Object property (0x78)                                |
| §12.2   | 4680-4724 | VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) と initRef                  |
| §12.3.1 | 4728-4742 | MSF_EVENT_TIMELINE_HEADER (0x7B)                                      |
| §14.2   | 5002-5064 | MSF Event Timeline Types レジストリ (初期空)                          |
| §14.3   | 5065-5086 | Property Type 値 (0x78 / 0x7B はアプリケーション固有)                 |
| §14.4   | 5088-5115 | MSF Compression Algorithms レジストリ                                 |
| §5.1.7  | 882-926   | initDataList の type (inline / track-property / object-property)      |
| §5.2.15 | 1461-1479 | depends の要素型と解決 MUST                                           |
| §5.2.16 | 1480-1494 | template フィールド                                                   |
| §5.2.45 | 1927-1948 | accessibleWindowTime                                                  |
| §5.5    | 2077-2087 | catalog の圧縮                                                        |
| §11.6   | 4564-4573 | wallclock の定義                                                      |
| A.1.4   | 5464-5478 | Media timeline の変更点                                               |
| A.1.5   | 5480-5502 | Event timeline の変更点                                               |
| A.1.7   | 5517-5534 | Workflow の変更点                                                     |
| A.1.8   | 5536-5563 | MSF properties / IANA の変更点                                        |

## 6. draft-01 の挙動を固定していて更新が必要なテスト一覧

### 6.1 必ず更新が必要 (仕様変更により期待値が変わる)

| テスト (path:行)                                               | 固定している内容                                                                                                                                | 必要な更新                                                                                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/msf.test.ts:454-461`                                      | `depends` は文字列配列のみ。穴あき配列を `depends must be an array of strings per §5.2.14` で拒否                                               | メッセージを §5.2.15 に変更し、Number 要素 (renderGroup) を受理する期待値に変更。穴あき (疎配列) の拒否自体は維持                                        |
| `src/msf.test.ts:618-644`                                      | §7.2 / §8.2 の `depends` / `mimeType` の MUST をまとめて拒否                                                                                    | mediatimeline の `depends` 欠落のみ残し、`mimeType` 欠落は受理する期待値に反転                                                                           |
| `src/msf.test.ts:1163-1179`                                    | mediatimeline で `mimeType ≠ application/json` を拒否                                                                                           | 削除 (または「任意の mimeType を受理する」テストに反転)                                                                                                  |
| `src/msf.test.ts:1182-1199`                                    | eventtimeline で `depends` / `mimeType` / `eventType` の MUST が揃わないと拒否                                                                  | `eventType` 欠落のみ拒否する形に変更。`depends` / `mimeType` 欠落は受理                                                                                  |
| `src/msf.test.ts:1124-1138`                                    | eventtimeline の `eventType` 欠落を検出するため `depends` / `mimeType` を補っている                                                             | 補助フィールドを削除し、`eventType` 欠落のみで検出できることを固定                                                                                       |
| `src/msf.test.ts:1768-1797`                                    | clone で `eventType` を継承し packaging を `loc` に override すると拒否 (フィクスチャに `depends` / `mimeType` を付与)                          | フィクスチャから不要フィールドを削除 (期待する拒否自体は維持)                                                                                            |
| `src/msf.test.ts:2707-2710`                                    | `MsfCompressionAlgorithm` の値 (0 / 1)。参照は §14.4 Table 15                                                                                   | 値は維持。参照を §14.4 Table 16 に変更し、Property Type 0x78 のテストを追加                                                                              |
| `src/msf.test.ts:2733-2776`                                    | Media / Event Timeline の round-trip、`data` 欠落、`t` / `l` / `m` 複数指定                                                                     | Event Timeline のフィクスチャを `T` / `L` / `M` に変更。小文字 key を拒否するテストを追加。`{"t":123}` は `{"T":123}` に変更                             |
| `src/msf.prop.ts:375-379`                                      | `mediaTimelineEntryArb` が media time の昇順を保証しない                                                                                        | TL-02 で encode / decode の順序検証を入れる場合、media time でソートした arbitrary に変更                                                                |
| `src/msf.prop.ts:395-402`                                      | `eventTimelineEntryArb` が小文字 `t` / `l` / `m` を生成                                                                                         | 大文字 `T` / `L` / `M` に変更                                                                                                                            |
| `src/msf.prop.ts:55-60`                                        | `packagingArb` に timeline を含めつつ、`catalogTrackArb` からは timeline を除外する根拠が「§7.2 / §8.2 の depends / mimeType / eventType MUST」 | コメントを -02 の条件 (eventtimeline は eventType のみ、mediatimeline は depends のみ) に変更。`catalogTrackArb` に eventtimeline を含められるようになる |
| `src/msf.prop.ts:166-168`                                      | 同上 (`catalogTrackArb` の除外理由)                                                                                                             | 同上                                                                                                                                                     |
| `src/msf.prop.ts:55-60`、`1097-1106`                           | `depends` を文字列配列として扱う                                                                                                                | renderGroup (Number) を含むケースを PBT と固定テストに追加                                                                                               |
| `src/properties.test.ts:1770-1789`                             | `getPropertyScope` の一覧 (0x78 / 0x7B は含まない)                                                                                              | `getPropertyScope(0x78n) === "both"`、`getPropertyScope(0x7Bn) === "track"` を追加                                                                       |
| `src/properties.test.ts:1799-1834`                             | `assertPropertyScopes` の Track / Object 違反検出                                                                                               | 0x7B を Object property として受信すると malformed になるテストを追加                                                                                    |
| `src/msf.test.ts` 全体 (174 箇所)                              | `"version": "draft-01"` のリテラル                                                                                                              | TL-24 の決定に合わせて `"draft-02"` へ置換 (174 箇所)。raw JSON フィクスチャ (`src/msf.test.ts:1433`、`1865-1875` など) も含む                           |
| `src/msf.prop.ts` (28 行 / `"draft-01"` 19 箇所)               | `version: "draft-01"` の生成                                                                                                                    | 同上                                                                                                                                                     |
| `devtools/src/utils/eventTimeline.ts:33-35`                    | `{ t: wallClockMs, data: ... }`                                                                                                                 | `{ T: wallClockMs, data: ... }` に変更                                                                                                                   |
| `devtools/src/components/MessageList.tsx:39`                   | `entry.t`                                                                                                                                       | `entry.T` に変更                                                                                                                                         |
| `devtools/src/hooks/usePublisher.ts:389-398`                   | event track が `mimeType` / `depends` を無条件で持つ                                                                                            | -02 では不要。残す場合も意味をコメントで更新 (依存関係の表明として妥当)                                                                                  |
| `devtools/src/hooks/usePublisher.test.ts:886-899`、`1428-1456` | `depends` の内容固定                                                                                                                            | 文字列配列のままであれば変更不要。ただしコメントの「§8.2」を「§8.3」に更新                                                                               |
| `devtools/src/utils/eventTimeline.test.ts:17`                  | 「eventType / depends / mimeType を MUST で要求する」というコメント                                                                             | -02 では depends / mimeType は不要。コメントを修正                                                                                                       |

### 6.2 更新してはならない (変更なしを確認したテスト)

| テスト (path:行)                                         | 理由                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/msf.test.ts:1152-1161`                              | mediatimeline の `depends` 欠落は -02 でも MUST (`msf-02:3425-3426`)                                                                                                                                                                                              |
| `src/msf.test.ts:1507-1531`、`1533-1549`、`1865-1875`    | template の 6 要素検証、precision loss、負値拒否は -02 でも同じ (`msf-02:3464-3502`)                                                                                                                                                                              |
| `src/msf.test.ts:1799-1818`                              | clone 後の mediatimeline で `depends` 欠落を拒否するのは -02 でも正しい                                                                                                                                                                                           |
| `src/msf.test.ts:2851-2877`                              | template の JSON 安全範囲検証は -02 でも同じ                                                                                                                                                                                                                      |
| `src/msf.test.ts:2707-2710` (値のみ)                     | algorithm 0 / 1 は -02 でも同じ (`msf-02:4610-4620`)                                                                                                                                                                                                              |
| `src/properties.test.ts:762-763`、`807-808`、`1546-1597` | 0x0D を「未知の奇数 Type」として扱うテスト。**0x0D / 0x0F を `KNOWN_PROPERTY_TYPES` に追加してはならない** (追加すると未知 Type 前提のエラーコードが変わる)。0x0D / 0x0F は既に `SUPPORTED_PROPERTY_TYPES` で scope 検証済みであり、値の serialization 制約は無い |
| `src/properties.test.ts:1841-1870`                       | scope / 重複検証の既存挙動。0x78 / 0x7B 追加後も既存 Type の挙動は変えない                                                                                                                                                                                        |
| `src/properties.prop.ts:34-44`、`218-265`                | 0x78 / 0x7B を任意値で生成する PBT。**0x78 に値域検証を追加すると落ちる**。未対応 algorithm 値は受理する仕様 (PROP-02) なので値域検証は追加しない                                                                                                                 |

## 7. docs で更新が必要な記述

| ファイル:行                                                                           | 現状の記述                                                                       | 必要な更新                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/MSF.md:10`                                                                      | 正本が `refs/moq/draft-ietf-moq-msf-01.txt`                                      | `refs/moq/draft-ietf-moq-msf-02.txt` に変更 (draft-01 のファイルは既に存在しない)                                                                                                                                                                                       |
| `docs/MSF.md:11`                                                                      | 公開版リンクが draft-01                                                          | draft-02 に変更                                                                                                                                                                                                                                                         |
| `docs/MSF.md:16`                                                                      | 「MSF-01 §5 は ...」                                                             | 「MSF-02 §5 は ...」。(Joining FETCH の記述は §5 の該当箇所が -02 でも同じか確認が必要。本レポートでは未確認)                                                                                                                                                           |
| `docs/MSF.md:22-24`                                                                   | §11.1 / §11.4.3 の参照                                                           | §11.1 / §11.5.3 に変更 (節番号が変わった: `msf-02:4513`)                                                                                                                                                                                                                |
| `docs/MSF.md:27`                                                                      | Timeline の公開 API 一覧                                                         | `MSF_EVENT_TIMELINE_HEADER` の取得 API、media timeline の `accessibleWindowTime` 適用 helper、圧縮対応の有無を追記                                                                                                                                                      |
| `docs/MSF.md:28`                                                                      | 「MSF_COMPRESSION (未実装)」                                                     | -02 では 0x78 が確定したため「Property ID 0x78 は確定。実装は issue 0355 で対応」に変更                                                                                                                                                                                 |
| `docs/MSF.md:29`                                                                      | 「draft-00 の Catalog wire 形式および Timeline 圧縮オプションとは非互換」        | draft-01 → draft-02 の非互換 (Event Timeline の index key、`depends` の Number、version 文字列、mimeType 要求の削除) を追記                                                                                                                                             |
| `docs/IMPLEMENTATION_STATUS.md:143`                                                   | 「draft-ietf-moq-msf-01 の機能実装状況」                                         | draft-02 に変更                                                                                                                                                                                                                                                         |
| `docs/IMPLEMENTATION_STATUS.md:150`                                                   | 「version (`draft-01`)」                                                         | `draft-02` に変更                                                                                                                                                                                                                                                       |
| `docs/IMPLEMENTATION_STATUS.md:157`                                                   | 「packaging: loc / mediatimeline / eventtimeline / moqlog / moqmetrics」         | -02 は `catalog` も追加 (`msf-02:1145`)。timeline としては、mediatimeline と eventtimeline の要件 (下表) を分けて書く                                                                                                                                                   |
| `docs/IMPLEMENTATION_STATUS.md:160`                                                   | 「initRef / template」                                                           | initDataList の `track-property` / `object-property` (PROP-05)、template の不変性 (TL-09) を追記                                                                                                                                                                        |
| `docs/IMPLEMENTATION_STATUS.md:177-181`                                               | Timeline の実装状況 (Media / Event / 無圧縮のみ)                                 | (1) Event Timeline の index key が -02 で大文字になったこと、(2) header data (`MSF_EVENT_TIMELINE_HEADER`) が未実装であること、(3) media timeline の consumer が存在しないこと、(4) `accessibleWindowTime` が未実装であること、(5) 圧縮 (0x78) が未実装であることを明記 |
| `docs/IMPLEMENTATION_STATUS.md` (新節)                                                | MSF Properties (§12) の節が無い                                                  | §12.1 (COMPRESSION)、§12.2 (VIDEO_CONFIG / AUDIO_CONFIG と initRef)、§12.3.1 (EVENT_TIMELINE_HEADER) の実装状況を追加                                                                                                                                                   |
| `docs/ARCHITECTURE.md:61`                                                             | `src/playout/timeline.ts` を「基準の時計、到着の学習、表示時刻、A/V 同期」と説明 | MSF の Media Timeline track とは無関係であることを明記 (名前の衝突による誤解を防ぐ)                                                                                                                                                                                     |
| `docs/ARCHITECTURE.md:142`、`154`、`160`、`165`                                       | VIDEO_CONFIG / AUDIO_CONFIG を LOC の property として説明                        | MSF §12.2 が同じ property を MSF の初期化データとして規定し、`initRef` + initDataList の type が必要であることを追記                                                                                                                                                    |
| `docs/HIGH_LEVEL_API.md:115`、`119`、`1234`                                           | draft-01 の節番号 (§5.2.8 targetLatency、§5.2.11 renderGroup)                    | -02 の節番号 (§5.2.9 targetLatency、§5.2.12 renderGroup) に変更                                                                                                                                                                                                         |
| `docs/HIGH_LEVEL_API.md:148`                                                          | 「draft-ietf-moq-msf-01 由来であり、将来の draft 改版で変わる可能性がある」      | draft-02 で実際に変わった項目 (timeline 関連) を列挙                                                                                                                                                                                                                    |
| `docs/HIGH_LEVEL_API.md:338`、`348`、`351`、`363`、`760`、`763`                       | draft-01 の節番号                                                                | -02 の節番号に変更                                                                                                                                                                                                                                                      |
| `docs/DEVELOPMENT.md:132`                                                             | 「event timeline の PUBLISH」                                                    | 変更不要 (機能の記述としては正しい)                                                                                                                                                                                                                                     |
| `issues/pending/0355-add-msf-compression-property.md:16`、`39-41`                     | 「Property ID が TBD のため pending」                                            | -02 で 0x78 / 0x7B が確定し IANA 登録不要になったため、pending 理由を削除して実装可能な状態に更新                                                                                                                                                                       |
| すべての `src/msf/*.ts`、`src/properties.ts`、`src/loc.ts`、`src/msf.ts` の先頭 JSDoc | 「参照: draft-ietf-moq-msf-01」                                                  | 「参照: draft-ietf-moq-msf-02」+ 節番号の更新 (TL-23 の対応表)                                                                                                                                                                                                          |
| `src/msf/catalogTrackValidation.ts:470`、`474`、`478`、`510` などのエラーメッセージ   | §5.2.5 / §8.2 / §5.2.14                                                          | §5.2.6 / §8.3 / §5.2.15                                                                                                                                                                                                                                                 |
| `src/msf/version.ts:41-44` の packaging コメント                                      | draft-00 / draft-01 の履歴                                                       | `catalog` 追加 (-02) を追記                                                                                                                                                                                                                                             |
| `docs/MSF.md:29` と CHANGES                                                           | 非互換の記載                                                                     | Event Timeline index key の変更、`depends` の Number 対応、version 文字列の変更を破壊的変更として記載                                                                                                                                                                   |

## 8. wire 互換性が壊れる変更の一覧

| #   | 変更                                                                                    | 壊れる方向                                                                                         | 根拠                                                                                                  | 関連 ID           |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Event Timeline の index key が `t` / `l` / `m` → `T` / `L` / `M`                        | 双方向 (encode した payload を -02 実装が解釈できず、-02 の payload を本実装が拒否)                | `msf-02:3620-3623`、`5482-5483` / `src/msf/timeline.ts:111-122`、`154-172`、`195-219`                 | TL-12             |
| 2   | `depends` の要素が track 名 (String) だけ → track 名または renderGroup (Number)         | 双方向 (Number を受理できず、Number を出力できない)                                                | `msf-02:3425-3426`、`1468-1478` / `src/msf/types.ts:144`、`src/msf/catalogTrackValidation.ts:226-232` | TL-05             |
| 3   | catalog の `version` が `draft-01` → `draft-02`                                         | 双方向 (現行 encode は `draft-01` を送出し、現行 decode は `draft-02` を拒否)                      | `msf-02:786-790`、`2703` / `src/msf/version.ts:22-33`、`src/msf/catalogValidation.ts:55-60`           | TL-24             |
| 4   | mediatimeline の `mimeType` 必須が削除                                                  | 片方向 (現行実装が -02 適合カタログを拒否)                                                         | `msf-02:3423-3431`、`5470-5471` / `src/msf/catalogTrackValidation.ts:459-465`                         | TL-04             |
| 5   | eventtimeline の `depends` 必須が条件付きに変更                                         | 片方向 (現行実装が -02 適合カタログを拒否)                                                         | `msf-02:3655-3658`、`5496-5497` / `src/msf/catalogTrackValidation.ts:473-475`                         | TL-15             |
| 6   | eventtimeline の `mimeType` 必須が削除                                                  | 片方向 (現行実装が -02 適合カタログを拒否。§8.1.1 の例も拒否)                                      | `msf-02:3645-3658`、`3589-3596` / `src/msf/catalogTrackValidation.ts:476-482`                         | TL-16             |
| 7   | MSF_COMPRESSION (0x78) が Track / Object property として登場し、GZIP payload が運ばれる | 片方向 (未知 property として値だけ保持し、gzip バイト列を JSON として parse して失敗)              | `msf-02:4625-4678` / `src/properties.ts:36-44`、`530-604`                                             | PROP-01 / PROP-03 |
| 8   | MSF_EVENT_TIMELINE_HEADER (0x7B) が Track property として登場                           | 片方向 (無視するため header の意味が失われる。ハードエラーにはならない)                            | `msf-02:4728-4742` / `src/properties.ts:530-604`                                                      | TL-14 / PROP-06   |
| 9   | initDataList の type に `track-property` / `object-property` が追加                     | 片方向 (現行実装は type を任意文字列として受理するが解釈しない。初期化データの解決に失敗する)      | `msf-02:898-921`、`4709-4724` / `src/msf/types.ts:27-39`、`src/msf/tracks.ts:32-39`                   | PROP-04 / PROP-05 |
| 10  | media timeline の explicit / template 混在が禁止                                        | 片方向 (draft-01 で混在 payload を送っていた publisher のデータは -02 で不正。本実装は元々未対応)  | `msf-02:3351-3352` / `src/msf/timeline.ts:45-95`                                                      | TL-01             |
| 11  | media timeline の entry が media time 順であることの明文化                              | 片方向 (順序を前提にした consumer を追加した場合、-01 の非順序 payload を不正として扱うことになる) | `msf-02:3394` / `src/msf/timeline.ts:71-95`                                                           | TL-02             |
| 12  | `accessibleWindowTime` の追加                                                           | なし (未知フィールドとして保持・再出力される)                                                      | `msf-02:1927-1948` / `src/msf/catalogTrackValidation.ts:117-123`                                      | TL-10             |

参考: 本レポートの範囲外だが、draft-02 では track 直下の `token` が削除され `authInfo` に置き換わっている (`msf-02:5444-5446`)。`src/msf/types.ts:234-240` は `token` を publishTracks のフィールドとして保持しており、catalog 担当の差分として扱う必要がある。
