# LOC Object Properties のエンコードを delta encoding に追従させる

- Created: 2026-08-03
- Completed: 2026-08-25
- Branch: feature/change-loc-object-properties-delta-encoding
- Polished: 2026-08-07

## 目的

draft-ietf-moq-transport-19 §11.2.1.2 / §1.4.3 に基づき、LOC の Object Properties エンコード / デコードを仕様の Key-Value-Pairs（Figure 2、delta encoding）に追従させる。`0360` は `src/properties.ts` のヘルパー群のみを delta 化しており、`src/loc.ts` の LOC Property 群が absolute 形式のまま取り残されている。

## 現状

- `src/loc.ts` の `encodeVideoProperties()` / `encodeAudioProperties()` は、各 Property を「絶対 Type + Value」の連結で出力する（`encodeTimestamp()` / `encodeVideoFrameMarking()` 等の単体エンコーダは ID を絶対値で書く）。
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` / `handleVideoEncodedChunk()` はこの出力を `sendObject()` の `properties` にそのまま渡し、`src/session/publish.ts` の `publishSendObjectInternal()` → `src/dataStream.ts` の `encodeObjectFields()` が「Properties Length + バイト列」としてワイヤに載せる（GREASE 非 opt-in の既定経路では）delta エンコード（`encodeProperties()`）を経由しない。
- ワイヤ形式の仕様違反は複数 Property を連結する場合に限定される。単一 Property のみ（例: 音声経路の timestamp のみ）のワイヤは「先頭の Delta Type は 0 からの絶対値」と同一であり仕様準拠だが、ビデオ経路（timestamp + frameMarking の 2 Property）は 2 つ目以降の Type が delta にならず、仕様準拠の対向実装が累積 delta として解釈して誤読する（例: timestamp (0x10) の後の frameMarking (0x09) は Type 0x19 として読まれる）。
- 受信側も `src/loc.ts` の `decodeVideoProperties()` / `decodeAudioProperties()` が絶対 ID で解釈する。GREASE 非 opt-in かつ delivery timeout 未指定のときは moqt-js ↔ moqt-js が自己整合するが、delivery timeout を subgroup 先頭オブジェクトに載せる経路（`publishSendObjectInternal()` → `mergeDeliveryTimeoutObjectProperties()`）では絶対 LOC バイト列が delta 寛容デコードで再構成され、GREASE opt-in 時も `appendGreaseObjectProperty()` の再構成経路で同じく再構成される。再構成後のワイヤは経路によって壊れ方が異なる: ビデオ（複数 Property）経路では 2 番目以降の絶対 Type が delta として加算されて不正な Property が混ざったワイヤに再構成される（仕様準拠の対向実装が誤読する）。音声（単一 Property）経路では再構成後のワイヤは有効な delta のまま仕様準拠の対向は読めるが、受信側の絶対解釈（`decodeAudioProperties()`）が delta 後の ID を未知として読み飛ばし timestamp が失われる。同一バイト列を delta 解釈（`readDeliveryTimeoutObjectProperties()`（呼び出し側は `src/session/stream.ts` の `processSubgroupObjects()`））と絶対解釈（`decodeVideoProperties()`）の両方で読む矛盾は両経路に共通する。
- `src/loc.ts` の冒頭コメントが「絶対 Type を連結するだけであり、Key-Value-Pair delta 符号化にはなっていない」と自己言及している。`src/loc.test.ts` の冒頭コメントも誤った解釈を固定している。

## 設計方針

- LOC Property を `Property[]` として組み立て、`src/properties.ts` の `encodeProperties()`（delta encoding）を通して Object Properties バイト列を生成する。`encodeProperties()` は ID 昇順ソートするため、複数 Property のワイヤ上の並びは従来（挿入順）と変わる（例: timestamp (0x10) + frameMarking (0x09) は frameMarking が先頭になり、Delta Type は 0x09, 0x07 になる）。
- 単一 Property のみの場合も delta encoding でエンコードする（先頭の Delta Type は 0 からの絶対値であり、単一 Property のワイヤは従来と同一になる）。
- 単体エンコーダ / デコーダ（`encodeTimestamp()` / `decodeTimestamp()` / `encodeTimescale()` / `decodeTimescale()` / `encodeVideoFrameMarking()` / `decodeVideoFrameMarking()` / `encodeAudioLevel()` / `decodeAudioLevel()` / `encodeVideoConfig()` / `decodeVideoConfig()` / `encodeAudioConfig()` / `decodeAudioConfig()`）は維持する。単体デコーダは従来どおり不正入力（VIDEO_FRAME_MARKING の Length 1-4 外等）で throw する。`encodeVideoProperties()` / `encodeAudioProperties()` は `Property[]` 組み立て + `encodeProperties()` 方式に置き換え、`decodeVideoProperties()` / `decodeAudioProperties()` も寛容デコーダによる delta 解釈に置き換える（シグネチャは不変のため、`src/createMediaSubscriber.ts` の `resolveVideoProperties()` / `resolveAudioProperties()`、devtools の `useSubscriber.ts` / `usePublisher.ts` の呼び出しは実質変更なし。ただし `src/loc.ts` の JSDoc は更新する）。なお `decodeVideoProperties()` の throw はなくなり、不正な VIDEO_FRAME_MARKING で中断していた devtools `useSubscriber.ts` の `handleObject` 内 try/catch 経路（オブジェクト処理中断）と joining fetch の `onObject` コールバック内（try/catch の外）の 2 経路で中断が解消される（完了条件の寛容性の意図どおり）。
- 受信側は 0360 と同じ寛容な抽出経路でデコードする。`decodeObjectPropertiesTolerant()` は現状非公開のため公開して流用する。Track 向け `decodeProperties()` の厳密検証（Mandatory Track Property 0x4000-0x7FFF 拒否、`validateTrackPropertyValue()`、Length 上限 2^16-1）は流用しない（Object バイト列に適用すると誤って `MalformedTrackError` になり得る）。delta 復元した `Property[]` から LOC Property ID を抽出して `VideoProperties` / `AudioProperties` を復元する。既存の `extractLocTrackProperties()` は Track スコープの 3 ID（TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG）のみを抽出するため、scope（track / object）引数を持つ単一の抽出関数に拡張し、track 入力では 3 ID、object 入力では 6 ID（+ TIMESTAMP / VIDEO_FRAME_MARKING / AUDIO_LEVEL）を抽出する（track 入力に Object スコープのみの ID が現れた場合は抽出しない。現行の `extractLocTrackProperties()` の挙動を維持）。TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG は Track, Object 両スコープを持つため、Object からの抽出による Track 上書き（現行 `resolveVideoProperties()` の優先規則）を維持する。抽出不能・不正な場合はセッションを閉じず、抽出できたフィールドのみ設定してオブジェクト配信を継続する。delta 形式は Type が前 Property との差分で連鎖するため、途中で壊れた場合は後続 Property の抽出が全滅し、先行値のみが保持される（0360 と同じ既知の制約）。VIDEO_FRAME_MARKING の Value が不正（Length 0 / 5 以上等）な場合は frameMarking を未設定として扱う。
- 寛容な抽出経路では §1.4.3 / §2.5.1 の MUST 検証（Delta Type オーバーフロー、Length 上限 2^16-1、KEY_VALUE_FORMATTING_ERROR、Mandatory Track Property 判定）を意図的に適用しない（`readDeliveryTimeoutObjectProperties()` の JSDoc と同じ明示。0379 が `decodeObjectPropertiesTolerant()` に Delta Type オーバーフロー検証を追加する場合、本 issue の LOC 抽出経路はその例外を catch して寛容に扱う。詳細は「0379 との調整」参照）。
- 合成入力（`mergeDeliveryTimeoutObjectProperties()` / `appendGreaseObjectProperty()`）が complete=false の既存バイト列を受け取った場合は破棄して再構成するため（0360 の破棄規約の継承）、不正な LOC バイト列を properties に渡した場合 LOC メタデータは送信されない。
- 後方互換性は考慮しない（プロジェクト方針。旧 absolute 形式の複数 Property は新受信側で誤読しうる。0360 と同じ扱い）。
- 既存テスト（`src/loc.test.ts` / `src/loc.prop.ts`）の期待値とコメントを delta 規約に更新し、固定バイト列でワイヤ形式を検証するテストを追加する。

## 完了条件

- LOC Object Properties が delta encoding（Figure 2）でワイヤに載る。
- 単一 Property（例: timestamp 単体 / frameMarking 単体）のワイヤが従来の絶対形式とビット一致する（= delta from 0 と同一）ことを固定バイト列で検証するテストがあること。
- 受信側が仕様準拠の delta KVP でエンコードされた Object Properties を正しくデコードできる（仕様準拠の delta KVP 固定バイト列を直接入力として検証するテストがあること）。
- 不正な delta / 不正な Length を含む Object Properties で PROTOCOL_VIOLATION を送出せず、抽出できるフィールドのみ設定して配信を継続すること（0360 と同じ寛容性。`decodeVideoProperties()` / `decodeAudioProperties()` を直接入力で検証するテストがあること）。
- 複数 Property（timestamp + frameMarking 等）のワイヤ形式（2 番目以降の Delta Type が前 ID との差分になること）を固定バイト列で検証するテストがあること。
- GREASE Property と LOC Property が混在した delta KVP バイト列を入力として、LOC フィールドのみ正しく抽出できることのテストがあること。
- LOC Property と delivery timeout / GREASE の合成経路（`mergeDeliveryTimeoutObjectProperties()` / `appendGreaseObjectProperty()` が LOC バイト列を入力に受けても delta 形式を維持する）のテストがあること。
- `src/loc.ts` の冒頭コメントと `resolveVideoProperties()` / `resolveAudioProperties()` の JSDoc（「絶対 Type 連結」等の誤った記述）、単体エンコーダ / デコーダ 12 関数の JSDoc（単一 Property 前提であり複数連結に使わない旨の注記）、`encodeLocObjectPayload()` の JSDoc（「推奨は絶対 Type 連結」）、`src/loc.test.ts` / `src/loc.prop.ts` の誤ったコメント・期待値が更新されていること。
- `CHANGES.md` の `## develop` に、本変更（LOC Object Properties の delta 化）と、複数 Property 時に旧版 moqt-js と相互運用できないワイヤ非互換を含む旨を反映した `[CHANGE]` エントリがあること。
- 0379 の issue ファイルに、本 issue（0361）との相互参照と、以下の 2 点の注記が追加されていること: (1) 0379 が `decodeObjectPropertiesTolerant()` に Delta Type オーバーフロー検証を追加した場合、LOC 抽出経路はその例外を catch して寛容に扱う（0379 が 0361 より先に実装されないための調整）。(2) 0379 の完了条件「`src/properties.ts` の全デコード経路で PROTOCOL_VIOLATION でセッションが閉じること」から、`decodeObjectPropertiesTolerant()` を利用する Object 配信経路（`readDeliveryTimeoutObjectProperties()` / LOC 抽出）は呼び出し側が例外を catch して配信を継続するため当該経路ではセッションは閉じない旨の例外を明記する。0379 ファイルへの注記追加は issue ファイルだけの編集のため、実装ブランチとは分けて develop で直接行い、コミットは `shiguredo-git` スキルの issue ファイル単体コミット規約に従うこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 0379 との調整

issue 0379（Delta Type 加算の 2^64-1 超過検証）は `decodeObjectPropertiesTolerant()` への検証追加を計画している。0379 を先に実装すると、本 issue の寛容な LOC 抽出経路（PROTOCOL_VIOLATION を送出せず配信継続）が Delta Type オーバーフローで PROTOCOL_VIOLATION を送出するようになり完了条件と矛盾する。また 0379 の完了条件「`src/properties.ts` の全デコード経路で PROTOCOL_VIOLATION でセッションが閉じること」も、LOC 抽出経路の寛容性と矛盾したまま残っている。対応方針: 本 issue（0361）を先に実装し、0379 の issue に相互参照と「LOC 抽出経路は Delta Type オーバーフロー検証の例外を catch して寛容に扱う（読めた分のみ抽出して配信継続）」旨と、「0379 の完了条件の『全デコード経路でセッションが閉じること』から `decodeObjectPropertiesTolerant()` を利用する Object 配信経路を除外する」旨の注記を追加する（完了条件に含める）。

## 参照

- draft-ietf-moq-transport-19 §1.4.3 (Key-Value-Pair Structure / Figure 2)（「Key-Value-Pairs encode a Type value as a delta from the previous Type value, or from 0 if there is no previous Type value.」）
- draft-ietf-moq-transport-19 §2.5 (Properties)
- draft-ietf-moq-transport-19 §11.2.1.2 (Object Properties)（「Object Properties are serialized as a length in bytes followed by Key-Value-Pairs (see Figure 2).」）
- draft-ietf-moq-loc-04 §2.3 (LOC Properties) / §2.3.2.2 (Video Frame Marking) / Table 1 (Property ID / Scope)
- 関連: `0360-change-object-properties-delta-encoding.md`
- 関連: `0364-change-video-frame-marking-rfc9626.md`（VIDEO_FRAME_MARKING の Value レイアウトを変更する。同じテストを触るため実装順は先に本 issue）
- 関連: `0379-moqt-draft-19-delta-type-overflow-validation.md`（`decodeObjectPropertiesTolerant()` への検証追加が本 issue の寛容性と干渉する。実装順は先に本 issue）

## 解決方法

LOC Object Properties のエンコード / デコードを Key-Value-Pair delta encoding（draft-ietf-moq-transport-19 §1.4.3 / §11.2.1.2）に追従させた。

- `src/loc.ts`: `encodeVideoProperties()` / `encodeAudioProperties()` を Property[] 組み立て + `encodeProperties()` 方式（ID 昇順ソート・delta 連鎖）に置き換えた。単体エンコーダ / デコーダ 12 関数は維持し、JSDoc に単一 Property 前提・複数連結に使わない旨の注記を追加した。冒頭コメント・`encodeLocObjectPayload()` の JSDoc・`resolveVideoProperties()` / `resolveAudioProperties()` の JSDoc を delta 規約の記述に更新した
- `src/loc.ts`: `decodeVideoProperties()` / `decodeAudioProperties()` を `decodeObjectPropertiesTolerant()` 経由の寛容な delta 解釈に置き換え、`extractLocTrackProperties()` を scope（track / object）引数を持つ `extractLocProperties()` に拡張した。不正な delta / Length で PROTOCOL_VIOLATION を送出せず、抽出できたフィールドのみ設定して配信を継続する（VIDEO_FRAME_MARKING の不正な Value は frameMarking 未設定扱い。track 入力時の Object スコープ ID は現行どおり抽出しない）
- `src/loc.test.ts`: 単一 Property の従来ワイヤとのビット一致（timestamp / frameMarking / audioLevel / config）、複数 Property の Delta Type（frameMarking 0x09 + timestamp 0x07 等）、仕様準拠 delta KVP の直接入力デコード、不正 delta / Length の非 throw と先行値保持、GREASE 混在からの LOC 抽出、delivery timeout / GREASE 合成経路の delta 維持のテストを追加した
- `src/loc.prop.ts`: 絶対 Type 連結前提のテスト（余剰付き frameMarking の後続 ID、Length 0 / 5 / 不足の寛容化、未知 ID スキップ）を delta 規約に更新した
- `CHANGES.md`: `[CHANGE]` を追記した（複数 Property 時に旧版 moqt-js（絶対 Type 連結）と相互運用できないワイヤ非互換を含む旨）

0379（Delta Type オーバーフロー検証）は `decodeObjectPropertiesTolerant()` に検証を追加しない方針で closed 済みのため、0379 の「注記 (0361 との調整)」のとおり調整は発生しない（0361 側の完了条件成立）。
