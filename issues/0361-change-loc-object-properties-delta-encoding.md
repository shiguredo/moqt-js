# LOC Object Properties のエンコードを delta encoding に追従させる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-loc-object-properties-delta-encoding
- Polished: 2026-08-03

## 目的

draft-ietf-moq-transport-19 §11.2.1.2 / §1.4.3 に基づき、LOC の Object Properties エンコード / デコードを仕様の Key-Value-Pairs（Figure 2、delta encoding）に追従させる。`0360` は `src/properties.ts` のヘルパー群のみを delta 化しており、`src/loc.ts` の LOC Property 群が absolute 形式のまま取り残されている。

## 現状

- `src/loc.ts` の `encodeVideoProperties()` / `encodeAudioProperties()` は、各 Property を「絶対 Type + Value」の連結で出力する（`encodeTimestamp()` / `encodeVideoFrameMarking()` 等の単体エンコーダは ID を絶対値で書く）。
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` / `handleVideoEncodedChunk()` はこの出力を `sendObject()` の `properties` にそのまま渡し、`src/session/publish.ts` の `publishSendObjectInternal()` → `src/dataStream.ts` の `encodeObjectFields()` が「Properties Length + バイト列」としてワイヤに載せる。delta エンコード（`encodeProperties()`）を経由しない。
- 受信側も `src/loc.ts` の `decodeVideoProperties()` / `decodeAudioProperties()` が絶対 ID で解釈するため、GREASE 非 opt-in 時は moqt-js ↔ moqt-js が自己整合するが、ワイヤ形式は仕様違反である。GREASE opt-in 時は `appendGreaseObjectProperty()` の再構成経路がこのバイト列を delta 寛容デコードするため、LOC Property が壊れる。2 つ目以降の Property は仕様準拠の対向実装が累積 delta として解釈し誤読する（例: timestamp (0x10) の後の frameMarking (0x09) は Type 0x19 として読まれる）。
- 同一バイト列を delta 解釈（`src/properties.ts` の `readDeliveryTimeoutObjectProperties()`（呼び出し側は `src/session/stream.ts` の `processSubgroupObjects()`）、`decodeObjectPropertiesTolerant()`）と絶対解釈（`decodeVideoProperties()`）の両方で読む矛盾がある。
- `src/loc.ts` の冒頭コメントが「絶対 Type を連結するだけであり、Key-Value-Pair delta 符号化にはなっていない」と自己言及している。`src/loc.test.ts` の冒頭コメントも誤った解釈を固定している。

## 設計方針

- LOC Property を `Property[]` として組み立て、`src/properties.ts` の `encodeProperties()`（delta encoding）を通して Object Properties バイト列を生成する。`encodeProperties()` は ID 昇順ソートするため、複数 Property のワイヤ上の並びは従来（挿入順）と変わる（例: timestamp (0x10) + frameMarking (0x09) は frameMarking が先頭になり、Delta Type は 0x09, 0x07 になる）。
- 単一 Property のみの場合も delta encoding でエンコードする（先頭の Delta Type は 0 からの絶対値であり、単一 Property のワイヤは従来と同一になる）。
- 単体エンコーダ / デコーダ（`encodeTimestamp()` 等）は単一 Property のワイヤが delta from 0 と同一のため維持する。単体デコーダは従来どおり不正入力（VIDEO_FRAME_MARKING の Length 1-4 外等）で throw する。`encodeVideoProperties()` / `encodeAudioProperties()` は `Property[]` 組み立て + `encodeProperties()` 方式に置き換え、`decodeVideoProperties()` / `decodeAudioProperties()` も寛容デコーダによる delta 解釈に置き換える（シグネチャは不変のため、`src/createMediaSubscriber.ts` の `resolveVideoProperties()` / `resolveAudioProperties()`、devtools の `useSubscriber.ts` / `usePublisher.ts` の呼び出しは実質変更なし。ただし `src/loc.ts` の JSDoc は更新する）。
- 受信側は 0360 と同じ寛容な抽出経路でデコードする。`decodeObjectPropertiesTolerant()` は現状非公開のため公開して流用する。Track 向け `decodeProperties()` の厳密検証（Mandatory Track Property 0x4000-0x7FFF 拒否、`validateTrackPropertyValue()`、Length 上限 2^16-1）は流用しない（Object バイト列に適用すると誤って `MalformedTrackError` になり得る）。delta 復元した `Property[]` から LOC Property ID を抽出して `VideoProperties` / `AudioProperties` を復元する。既存の `extractLocTrackProperties()` は Track スコープの 3 ID（TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG）のみを抽出するため、Object スコープの ID（TIMESTAMP / VIDEO_FRAME_MARKING / AUDIO_LEVEL）も含む抽出に拡張する。TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG は Track, Object 両スコープを持つため、Object からの抽出による Track 上書き（現行 `resolveVideoProperties()` の優先規則）を維持する。Track 側入力に Object スコープのみの ID が現れた場合は抽出しない（現行の `extractLocTrackProperties()` の挙動を維持）。抽出不能・不正な場合はセッションを閉じず、抽出できたフィールドのみ設定してオブジェクト配信を継続する。delta 形式は Type が前 Property との差分で連鎖するため、途中で壊れた場合は後続 Property の抽出が全滅し、先行値のみが保持される（0360 と同じ既知の制約）。VIDEO_FRAME_MARKING の Value が不正（Length 0 / 5 以上等）な場合は frameMarking を未設定として扱う。
- 既存テスト（`src/loc.test.ts` / `src/loc.prop.ts`）の期待値とコメントを delta 規約に更新し、固定バイト列でワイヤ形式を検証するテストを追加する。

## 完了条件

- LOC Object Properties が delta encoding（Figure 2）でワイヤに載る。
- 受信側が仕様準拠の delta KVP でエンコードされた Object Properties を正しくデコードできる（仕様準拠の delta KVP 固定バイト列を直接入力として検証するテストがあること）。
- 不正な delta / 不正な Length を含む Object Properties で PROTOCOL_VIOLATION を送出せず、抽出できるフィールドのみ設定して配信を継続すること（0360 と同じ寛容性。テストがあること）。
- 複数 Property（timestamp + frameMarking 等）のワイヤ形式（2 番目以降の Delta Type が前 ID との差分になること）を固定バイト列で検証するテストがあること。
- LOC Property と delivery timeout / GREASE の合成経路（`mergeDeliveryTimeoutObjectProperties()` / `appendGreaseObjectProperty()` が LOC バイト列を入力に受けても delta 形式を維持する）のテストがあること。
- `src/loc.ts` の冒頭コメントと `resolveVideoProperties()` / `resolveAudioProperties()` の JSDoc（「絶対 Type 連結」等の誤った記述）、`src/loc.test.ts` / `src/loc.prop.ts` の誤ったコメント・期待値が更新されていること。
- `CHANGES.md` の `## develop` に本変更（LOC Object Properties の delta 化）を反映した `[CHANGE]` エントリがあること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §1.4.3 (Key-Value-Pair Structure / Figure 2)
- draft-ietf-moq-transport-19 §2.5 (Properties)
- draft-ietf-moq-transport-19 §11.2.1.2 (Object Properties)
- 関連: `0360-change-object-properties-delta-encoding.md`（properties.ts のヘルパー群のみ対応し loc.ts が取り残された）
- 関連: `0364-change-video-frame-marking-rfc9626.md`（VIDEO_FRAME_MARKING の Value レイアウトを変更する。同じテストを触るため実装順は先に本 issue）

## 解決方法

未着手。
