# LOC Object Properties のエンコードを delta encoding に追従させる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-loc-object-properties-delta-encoding
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §11.2.1.2 / §1.4.3 に基づき、LOC の Object Properties エンコード / デコードを仕様の Key-Value-Pairs（Figure 2、delta encoding）に追従させる。`0360` は `src/properties.ts` のヘルパー群のみを delta 化しており、`src/loc.ts` の LOC Property 群が absolute 形式のまま取り残されている。

## 現状

- `src/loc.ts` の `encodeVideoProperties()` / `encodeAudioProperties()` は、各 Property を「絶対 Type + Value」の連結で出力する（`encodeTimestamp()` / `encodeVideoFrameMarking()` 等の単体エンコーダは ID を絶対値で書く）。
- `src/createMediaPublisher.ts` の `handleAudioEncodedChunk()` / `handleVideoEncodedChunk()` はこの出力を `sendObject()` の `properties` にそのまま渡し、`src/session/publish.ts` の `publishSendObjectInternal()` → `src/dataStream.ts` の `encodeObjectFields()` が「Properties Length + バイト列」としてワイヤに載せる。delta エンコード（`encodeProperties()`）を経由しない。
- 受信側も `src/loc.ts` の `decodeVideoProperties()` / `decodeAudioProperties()` が絶対 ID で解釈するため、moqt-js ↔ moqt-js は自己整合するが、ワイヤ形式は仕様違反である。2 つ目以降の Property は仕様準拠の対向実装が累積 delta として解釈し誤読する（例: timestamp (0x10) の後の frameMarking (0x09) は Type 0x19 として読まれる）。
- 同一バイト列を delta 解釈（`src/session/stream.ts` の `readDeliveryTimeoutObjectProperties()`、`src/properties.ts` の `decodeObjectPropertiesTolerant()`）と絶対解釈（`decodeVideoProperties()`）の両方で読む矛盾がある。
- `src/loc.ts` の冒頭コメントが「絶対 Type を連結するだけであり、Key-Value-Pair delta 符号化にはなっていない」と自己言及している。`src/loc.test.ts` の冒頭コメントも誤った解釈を固定している。

## 設計方針

- LOC Property を `Property[]` として組み立て、`src/properties.ts` の `encodeProperties()`（delta encoding）を通して Object Properties バイト列を生成する。
- 受信側は `decodeProperties()` の結果から LOC Property ID（`LOCPropertyId`）を抽出して `VideoProperties` / `AudioProperties` を復元する。`extractLocTrackProperties()` 相当の ID 抽出に統一する。
- 単一 Property のみの場合も delta encoding でエンコードする（先頭の Delta Type は 0 からの絶対値であり、単一 Property のワイヤは従来と同一になることを確認する）。
- 既存テスト（`src/loc.test.ts` / `src/loc.prop.ts` / `src/dataStream.datagram.test.ts`）の期待値とコメントを delta 規約に更新し、固定バイト列でワイヤ形式を検証するテストを追加する。

## 完了条件

- LOC Object Properties が delta encoding（Figure 2）でワイヤに載る。
- 受信側が仕様準拠の delta KVP でエンコードされた Object Properties を正しくデコードできる。
- 複数 Property（timestamp + frameMarking 等）のワイヤ形式（2 番目以降の Delta Type が前 ID との差分になること）を固定バイト列で検証するテストがあること。
- `src/loc.test.ts` / `src/loc.prop.ts` の誤ったコメント・期待値が更新されていること。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §1.4.3 (Key-Value-Pair Structure / Figure 2)
- draft-ietf-moq-transport-19 §11.2.1.2 (Object Properties)
- 関連: `0360-change-object-properties-delta-encoding.md`（properties.ts のヘルパー群のみ対応し loc.ts が取り残された）

## 解決方法

未着手。
