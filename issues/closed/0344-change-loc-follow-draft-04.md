# LOC を draft-ietf-moq-loc-04 に追従する

- Priority: High
- Created: 2026-07-24
- Completed: 2026-07-24
- Model: Composer
- Branch: feature/change-loc-follow-draft-04
- Polished: 2026-07-24

## 目的

`refs/moq/draft-ietf-moq-loc-04.txt` に対し、本リポジトリの LOC 実装 (`src/loc.ts`) は依然として draft-ietf-moq-loc-02 の Property ID / 個別 Value 形式のままである。一方 README は既に「draft-04 対応」と表記している。Property ID と各 Property の個別 Value 形式を §2.3.x / §6.1 Table 1 に合わせる。

本 issue の到達点は「絶対 Type 連結のまま、LOC Property の ID / 個別 Value 形式を loc-04 に揃える」ことである。次は本 issue では保証しない。

- Object Properties の Key-Value-Pair delta 符号化 (transport-19 §1.4.3 / §11.2.1.2)。現行 `LOC.encode*Properties` は絶対 Type を連結しており、`properties.ts` の `encodeProperties` を通さない
- §2.2 Private Properties フレーミング
- Track Scope / Secure Objects

## 優先度根拠

LOC Properties は高レベル API / devtools の映像・音声 Object に載る。TIMESTAMP / VIDEO_FRAME_MARKING / AUDIO_LEVEL の ID が draft-04 と不一致のため、同一スタック内でも「loc-04 の ID 表を前提にした実装」との Object Properties 解釈が食い違う。README の「draft-04 対応」表記とも乖離している。よって High。

## 現状

### 実装が draft-02 のまま

- `src/loc.ts:3` が `* draft-ietf-moq-loc-02` を参照している
- `LOCPropertyId` (`src/loc.ts:18-49`) の ID は draft-02 値:

| プロパティ              | 実装 (loc-02)                        | draft-04 (§2.3.x / §6.1 Table 1)           |
| ----------------------- | ------------------------------------ | ------------------------------------------ |
| TIMESTAMP               | `0x06` (偶数 / vi64)                 | `0x10` (偶数 / vi64)                       |
| TIMESCALE               | `0x08` (偶数 / vi64)                 | `0x08` (一致)                              |
| VIDEO_FRAME_MARKING     | `4` (偶数 / varint 詰め)             | `0x09` (奇数 / length + bytes, Length 1–4) |
| AUDIO_LEVEL             | `6` (= `0x06`, 偶数 / vi64)          | `0x0C` (偶数 / vi64)                       |
| VIDEO_CONFIG (`CONFIG`) | `13` (`0x0D`, 奇数 / length + bytes) | `0x0D` (一致、名称のみ VIDEO_CONFIG)       |
| AUDIO_CONFIG            | 未定義                               | `0x0F` (奇数 / length + bytes, 新規)       |

- VIDEO_FRAME_MARKING は `encodeVideoFrameMarking` (`src/loc.ts:142-163`) が偶数 ID + varint 値として符号化している。draft-04 §2.3.2.2 は「encoded with a length prefix」「ID: 0x09」「Length: Varies (1-4 bytes)」
- AUDIO_CONFIG (`0x0F`) の encode / decode / 型が無い
- `createMediaPublisher.ts` / `createMediaSubscriber.ts` は `LOC.encode*Properties` / `decode*Properties` に依存しており、現行ワイヤをそのまま送受信する。高レベルが載せるのは audio=`timestamp`、video=`timestamp` + `frameMarking` のみ (`description?` は LOC に載せない)
- `devtools/src/hooks/usePublisher.ts` は同一ヘルパで `config: chunk.description` を含め Object Properties を直接送る実クライアントである。コメントは `draft-ietf-moq-loc-02` / `ID: 13` のまま。`useSubscriber.ts` も loc-02 参照コメントのまま
- README は draft-04 リンクと「Audio Level」までの LOC Properties 一覧を掲げているが、AUDIO_CONFIG は未記載。実装実態は loc-02
- `docs/HIGH_LEVEL_API.md` は「LOC Header Extensions」「CAPTURE_TIMESTAMP」表記のまま、かつ高レベルが実際には送らない `VIDEO_CONFIG` / `AUDIO_LEVEL` を「自動処理」として列挙している。`docs/MSF.md` も「LOC Header Extensions」「Capture Timestamp … Config」
- `LOC.encode*Properties` は絶対 Type ID を連結するだけであり、Object Properties が要求する Key-Value-Pair delta (transport-19 §1.4.3) にはなっていない。`dataStream.ts` は受け取った `properties` バイト列をそのまま載せる
- 現行 LOC `TIMESTAMP=0x06` は MOQT `TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT` (`properties.ts`) と同値である。`session/stream.ts` は subgroup 先頭 Object の Properties を `readDeliveryTimeoutObjectProperties` に渡すため、TIMESTAMP を timeout と誤認しうる。本 issue の `0x10` 化でこの偽陽性は消える。delivery timeout ヘルパ自体の改修は範囲外
- `issues/pending/0036-bug-loc-audio-level-timestamp-id-conflict.md` は draft-02 の AUDIO_LEVEL / TIMESTAMP ID 衝突を pending にしている。draft-04 では TIMESTAMP=`0x10` / AUDIO_LEVEL=`0x0C` に分離済み。なお `#0036` の「状況確認」はデコードループが AUDIO_LEVEL を突き合わせないとしているが、現行 `decodeAudioProperties` (`src/loc.ts:373-380`) には AUDIO_LEVEL 分岐がある。ID が同一のため TIMESTAMP 分岐が先に勝ち、AUDIO_LEVEL 分岐は実質デッドコードになっている

## 設計方針

仕様の正本は `refs/moq/draft-ietf-moq-loc-04.txt` の §2.3.x / §6.1 Table 1。破壊的変更を受け入れ、draft-02 ワイヤとの後方互換は維持しない。

`refs/moq/draft-ietf-moq-transport-19.txt` Table 15 の provisional 値 (`TIMESTAMP=0x06` / `VIDEO_FRAME_MARKING=0x0A` 等) は **採用しない**。LOC Property ID は loc-04 Table 1 に従う。

### 破壊面の分離

- **破壊する**: LOC が出力する Object Properties バイト列の内容 (Property ID / VIDEO_FRAME_MARKING の length+bytes 形式)、公開 `LOC` 名前空間 (`src/index.ts` の `export * as LOC from "./loc"`)。具体的には `LOCPropertyId.CONFIG` → `VIDEO_CONFIG`、`encodeConfig` / `decodeConfig` → `encodeVideoConfig` / `decodeVideoConfig`、各 ID 値の変更、`AUDIO_CONFIG` 関連シンボルの追加
- **維持する**: `createMediaPublisher` / `createMediaSubscriber` の TypeScript 公開シグネチャ。これらは既に `LOC.encode*Properties` / `decode*Properties` を呼んでいるだけなので、ヘルパ更新の副作用確認に留める。devtools `usePublisher` は `config: chunk.description` を送っているため、VIDEO_CONFIG の ID / 関数リネームの副作用も確認する (送信経路自体は本 issue で増やさない)

### 実装手順

1. `src/loc.ts` の参照コメント・節番号を draft-04 (§2.3.x / §6.1 Table 1) に更新する。VIDEO_FRAME_MARKING 周りに残る「RFC9626 準拠」表現は、独自レイアウト維持方針と矛盾しない言い回しに直す (完全準拠を謳わない)
2. `LOCPropertyId` を Table 1 に合わせる
   - `TIMESTAMP = 0x10n`
   - `TIMESCALE = 0x08n` (据え置き)
   - `VIDEO_FRAME_MARKING = 0x09n`
   - `AUDIO_LEVEL = 0x0Cn`
   - `VIDEO_CONFIG` (現行 `CONFIG` をリネーム、エイリアス無し) `= 0x0Dn`
   - `AUDIO_CONFIG = 0x0Fn` を追加
3. VIDEO_FRAME_MARKING を奇数 ID の length + bytes 形式に変更する
   - 本 issue の対象は **ID と length フレーミングのみ** loc-04 §2.3.2.2 に合わせること。Value のビット配置は既存の独自レイアウトを維持する (I / D / B / TID / 2bit SID)。RFC9626 の 8-bit LID / TL0PICIDX までの型拡張、および §2.3.2.2 が参照する RFC9626 Value 完全準拠は範囲外
   - encode: 現行どおり 2 バイト (`byte1`, `byte2`) を組み立て、`ID(0x09)` + `length varint (=2)` + 生 2 バイトで載せる。varint 詰めはやめる
   - decode (`decodeVideoFrameMarking` および `decodeVideoProperties` 内の同分岐):
     - Length 1–4 を受理。Length=1 は SID=0 扱い、Length≥2 は先頭 2 バイトから既存フィールドを読む。フィールド解釈は最大 2 バイト分だが、**ワイヤ上は宣言 Length バイトを必ず消費してから次 Property へ進む**
     - Length=0、Length>4、または Value バイトがバッファに足りない場合は、現行 CONFIG 経路のような黙った切り詰めではなく、明示的にデコード失敗とする。例外型は `IncompleteDataError` 以外を使う (`session/stream.ts` が `IncompleteDataError` をストリーム不足として `break` するため)。`ProtocolViolationError` を推奨する (`Error` でも既存 uni-stream 経路で `INTERNAL_ERROR` になり得るが、不正 LOC Properties には PROTOCOL_VIOLATION の方が意図に合う)。`createMediaSubscriber` は LOC decode を try/catch しないため、例外は既存どおり `handleSubgroupStream` / uni-stream の catch に届き **セッションを閉じる**。本 issue ではこの伝播を意図どおり受け入れ、高レベルでの握りつぶしは範囲外とする。VIDEO_CONFIG / AUDIO_CONFIG の黙切り詰め是正は本 issue では触らない (VFM のみ明示失敗に切り替える)
4. AUDIO_CONFIG を追加する
   - `encodeAudioConfig` / `decodeAudioConfig` (VIDEO_CONFIG 側は `encodeVideoConfig` / `decodeVideoConfig` にリネーム)
   - `AudioProperties` に `config?: Uint8Array` を追加し、`encodeAudioProperties` / `decodeAudioProperties` が載せる / 読む (VideoProperties の `config` と同じ命名)
   - 値は WebCodecs `AudioDecoderConfig.description` (`EncodedAudioChunkMetadata` 側) 相当の opaque bytes (§2.3.3.1)
   - 高レベル API / `createMediaPublisher` は本 issue では AUDIO_CONFIG を送らない (helper 追加のみ)。VIDEO_CONFIG の高レベル未配線も本 issue では触らない (devtools の既存送信はそのままヘルパ追従)
5. `decodeVideoProperties` / `decodeAudioProperties` の分岐を新 ID に合わせる
   - VIDEO_FRAME_MARKING 分岐は length + bytes パースに切り替える (ID 差し替えだけでは不十分)
   - AUDIO_LEVEL は偶数 ID のまま形式は vi64 維持。ID だけ `0x0C` に変更する (§2.3.3.2)
   - 未知 ID のスキップ規則 (偶数 = vi64、奇数 = length + bytes) は §2.3 の Length/Value 定義に基づき維持する
6. `src/loc.prop.ts` を新ワイヤに合わせて更新する
   - TIMESTAMP / AUDIO_LEVEL 衝突前提の除外コメントとテスト欠落を削除し、`AudioProperties` のラウンドトリップ (timestamp + audioLevel 同時載せを含む) を復活させる
   - 各 Property の先頭バイトが Table 1 の ID であること、VIDEO_FRAME_MARKING の Length=2 ラウンドトリップ、Length=1 と Length=3 または 4 (余剰バイト付き) の decode を `decodeVideoFrameMarking` **および** `decodeVideoProperties` の両経路で検証する。Length=0 / Length>4 / バッファ不足の明示失敗も検証する。AUDIO_CONFIG / VIDEO_CONFIG の空・非空 description、未知偶数 / 奇数 ID のスキップを検証する
7. ドキュメントとコメントを更新する
   - README: LOC モジュールが対応する Properties 一覧を draft-04 名称にし、Audio Config を追記する
   - `docs/HIGH_LEVEL_API.md`: 「Header Extensions」→「Properties」、「CAPTURE_TIMESTAMP」→「TIMESTAMP」。ASCII 図中の「LOC Extensions」も「LOC Properties」に揃える。**高レベルが実際に自動処理する Properties だけを列挙する** (現状: TIMESTAMP、映像の VIDEO_FRAME_MARKING)。VIDEO_CONFIG / AUDIO_CONFIG / AUDIO_LEVEL は LOC モジュール対応だが高レベル未配線である旨を分ける
   - `docs/MSF.md`: 「LOC Header Extensions」→「LOC Properties」、Capture Timestamp → Timestamp、Config → Video Config / Audio Config に揃える。MSF Catalog 全体の書き直しは `#0345` の範囲 (本 issue は LOC 名称のみ)
   - `usePublisher.ts`: `draft-ietf-moq-loc-02` → draft-04、`ID: 13` → `0x0D` (VIDEO_CONFIG)
   - `useSubscriber.ts`: `draft-ietf-moq-loc-02 §2.1.2` → draft-04 §2.1.2 (Catalog initData 経路の説明。VIDEO_CONFIG の `0x0D` をここに混ぜない)。「Capture Timestamp」→「TIMESTAMP」。Object Properties の VIDEO_CONFIG 受信配線は本 issue では触らない (コメント更新のみ)
   - `devtools/src/components/ConnectionSettings.tsx`: 「Header Extensions」→「Properties」、「Capture Timestamp」→「Timestamp」、リンクを `draft-ietf-moq-loc-04` に更新し、Audio Config を一覧に含める
8. `CHANGES.md` の `## develop` に `[CHANGE]` を追記する (ワイヤ非互換、`LOCPropertyId.CONFIG` → `VIDEO_CONFIG`、`encodeConfig` → `encodeVideoConfig`、AUDIO_CONFIG 追加)

### 範囲外 (別 issue)

- Object Properties の Key-Value-Pair delta 符号化 (`LOC.encode*Properties` が `encodeProperties` 相当の昇順 + delta を出すようにする)
- LOC Private Properties フレーミング (§2.2: MOQ Object Properties ← LOC Public Properties、MOQ Object Payload ← LOC Private Properties + LOC Payload) → `#0346`
- TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG の Track Property 経路 (§6.1 Table 1 Scope: `Track, Object`) → `#0347`
- §3 Payload Encryption / Secure Objects 統合 → `#0353` (pending: Secure Objects の refs 未取得)
- VIDEO_FRAME_MARKING 値の RFC9626 フル準拠 (8-bit LID / TL0PICIDX 等の型拡張)
- MSF Catalog 側の変更 (本 issue は LOC モジュールとその直接利用箇所に限定。`docs/MSF.md` の全面書き直しは `#0345`)
- `devtools/main.ts` の死んだ `LOC.packVideo` / `LOC.unpackVideo` 参照 (本 issue の ID 追従とは別件)

## 完了条件

### コードベース

- `src/loc.ts` 冒頭が `draft-ietf-moq-loc-04` を参照している
- VIDEO_FRAME_MARKING コメントが「RFC9626 準拠」を謳っていない (独自レイアウト維持と矛盾しない表現)
- `LOCPropertyId` が §6.1 Table 1 の ID と一致し、`AUDIO_CONFIG` が存在し、`CONFIG` シンボルが残っていない
- `encodeVideoConfig` / `decodeVideoConfig` / `encodeAudioConfig` / `decodeAudioConfig` が存在し、旧 `encodeConfig` / `decodeConfig` が残っていない
- VIDEO_FRAME_MARKING が `0x09` + length (=2) + 2 bytes で encode され、Length 1–4 を decode できる。Length=0 / Length>4 / バッファ不足は `IncompleteDataError` 以外 (推奨: `ProtocolViolationError`) で明示失敗する
- AUDIO_CONFIG (`0x0F`) の encode / decode round-trip が通る
- TIMESTAMP (`0x10`) と AUDIO_LEVEL (`0x0C`) が衝突せず、同一 `AudioProperties` に両方載せた decode が成立する
- `createMediaPublisher` / `createMediaSubscriber` の公開シグネチャは維持したまま、新 ID の Properties を送受信する
- README の LOC Properties 一覧が draft-04 名称で Audio Config を含む
- `docs/HIGH_LEVEL_API.md` が draft-04 名称であり、高レベル自動処理の列挙が実装と一致している (未配線の VIDEO_CONFIG / AUDIO_CONFIG / AUDIO_LEVEL を「自動処理」と書かない)
- `docs/MSF.md` の LOC 行が draft-04 名称 (Properties / Timestamp / Video Config / Audio Config) である
- `devtools/src/components/ConnectionSettings.tsx` の LOC 説明が Properties / Timestamp 表記で、リンクが draft-04、Audio Config を含む
- `src/` / `devtools/` / `docs/` に `draft-ietf-moq-loc-02` 参照が残っていない (`CHANGES.md` / `issues/` / `refs/` は除外)
- `CHANGES.md` の `## develop` にワイヤ破壊と公開 `LOC` シンボル破壊を含む `[CHANGE]` がある

### テスト

- `src/loc.prop.ts` が新ワイヤで pass する。最低限次を含む:
  - 各 Property の ID 断言 (Table 1)
  - VIDEO_FRAME_MARKING: Length=2 ラウンドトリップ。Length=1 および Length=3 または 4 (余剰付き) の decode を `decodeVideoFrameMarking` と `decodeVideoProperties` の両経路で検証
  - VIDEO_FRAME_MARKING: Length=0 / Length>4 / バッファ不足が `IncompleteDataError` 以外 (推奨: `ProtocolViolationError`) で明示失敗すること
  - AudioProperties ラウンドトリップ復活 (timestamp + audioLevel 同時)
  - AUDIO_CONFIG / VIDEO_CONFIG の空・非空 description
  - 未知偶数 / 奇数 ID のスキップ
- `vp run test` / `vp run build` が pass する

### 関連 issue

- pending `#0036` を本対応完了後に closed にする。理由追記では「draft-04 で TIMESTAMP=`0x10` / AUDIO_LEVEL=`0x0C` に分離されたこと」と「本リポジトリの ID 追従で衝突前提の暫定措置を除去したこと」を書く。理由追記コミット + 移動コミットは本 issue のコード変更コミットとは分ける

## 解決方法

draft-ietf-moq-loc-04 §2.3.x / §6.1 Table 1 に合わせて LOC Properties のワイヤと公開シンボルを更新した。

### コード

- `src/loc.ts`: `LOCPropertyId` を Table 1 に合わせた (`TIMESTAMP=0x10`, `VIDEO_FRAME_MARKING=0x09`, `AUDIO_LEVEL=0x0C`, `VIDEO_CONFIG=0x0D`, `AUDIO_CONFIG=0x0F`)
- `CONFIG` / `encodeConfig` / `decodeConfig` を `VIDEO_CONFIG` / `encodeVideoConfig` / `decodeVideoConfig` にリネームした (エイリアス無し)
- `VIDEO_FRAME_MARKING` を奇数 ID の length + bytes 形式に変更した。Value のビット配置は独自レイアウトを維持する
- Length 0 / Length>4 / Value バイト不足は `ProtocolViolationError` で明示失敗する
- `encodeAudioConfig` / `decodeAudioConfig` と `AudioProperties.config` を追加した
- `src/loc.prop.ts`: 新ワイヤ向けの ID 断言、VFM Length 1–4 / 失敗系、AudioProperties 同時載せ、未知 ID スキップを追加した

### ドキュメント / クライアント

- README / `docs/HIGH_LEVEL_API.md` / `docs/MSF.md` / `ConnectionSettings.tsx` を draft-04 名称に更新した
- `usePublisher.ts` / `useSubscriber.ts` のコメントを draft-04 に更新した
- `CHANGES.md` の `## develop` に `[CHANGE]` を追記した

### 関連

- pending `#0036` は本対応完了後に別コミットで closed にする
