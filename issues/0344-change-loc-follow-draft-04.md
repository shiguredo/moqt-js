# LOC を draft-ietf-moq-loc-04 に追従する

- Priority: High
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-loc-follow-draft-04
- Polished: YYYY-MM-DD

## 目的

`refs/moq/draft-ietf-moq-loc-04.txt` に対し、本リポジトリの LOC 実装 (`src/loc.ts`) は依然として draft-ietf-moq-loc-02 の Property ID / ワイヤ形式のままである。一方 README は既に「draft-04 対応」と表記している。Property ID の破壊的変更を実装へ反映し、loc-04 ピアとの相互運用を可能にする。

## 優先度根拠

LOC Properties は高レベル API の映像 / 音声 Object に常時載る。TIMESTAMP / VIDEO_FRAME_MARKING / AUDIO_LEVEL の ID が draft-04 と不一致のため、loc-04 実装の peer / relay とはワイヤ互換にならない。README の「draft-04 対応」表記とも乖離している。よって High。

## 現状

### 実装が draft-02 のまま

- `src/loc.ts:3` が `* draft-ietf-moq-loc-02` を参照している
- `LOCPropertyId` (`src/loc.ts:18-49`) の ID は draft-02 値:

| プロパティ | 実装 (loc-02) | draft-04 (`refs` §2.3 / Table 1) |
|---|---|---|
| TIMESTAMP | `0x06` | `0x10` |
| TIMESCALE | `0x08` | `0x08` (一致) |
| VIDEO_FRAME_MARKING | `4` (偶数 / varint) | `0x09` (奇数 / length + bytes) |
| AUDIO_LEVEL | `6` (= `0x06`) | `0x0C` |
| VIDEO_CONFIG (`CONFIG`) | `13` (`0x0D`) | `0x0D` (一致) |
| AUDIO_CONFIG | 未定義 | `0x0F` (新規) |

- VIDEO_FRAME_MARKING は `encodeVideoFrameMarking` (`src/loc.ts:142-163`) が偶数 ID + varint 値として符号化している。draft-04 §2.3.2.2 は「encoded with a length prefix」「ID: 0x09」「Length: Varies (1-4 bytes)」
- AUDIO_CONFIG (`0x0F`) の encode / decode / 型が無い
- `createMediaPublisher.ts` / `createMediaSubscriber.ts` は `LOC.encode*Properties` / `decode*Properties` に依存しており、現行ワイヤをそのまま送受信する
- `devtools/src/hooks/useSubscriber.ts` / `usePublisher.ts` のコメントが `draft-ietf-moq-loc-02` のまま
- README は draft-04 リンクと「Audio Level」までの LOC Properties 一覧を掲げているが、AUDIO_CONFIG は未記載。実装実態は loc-02
- `issues/pending/0036-bug-loc-audio-level-timestamp-id-conflict.md` は draft-02 の AUDIO_LEVEL / TIMESTAMP ID 衝突を pending にしている。draft-04 では TIMESTAMP=`0x10` / AUDIO_LEVEL=`0x0C` に分離済み

### draft-04 で追加・明確化されたが未着手の周辺

- §2.2: MOQ Object Payload = LOC Private Properties + LOC Payload。現状の高レベル API は Payload に Encoded*Chunk の internal data のみを載せる
- §3 Payload Encryption / Secure Objects 統合 (Key ID immutable、Private Properties、cipher suite MUST 等)
- IANA Table 1 の Scope: TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG は `Track, Object`。現状は Object Properties 埋め込みのみ

## 設計方針

仕様の正本は `refs/moq/draft-ietf-moq-loc-04.txt`。破壊的変更を受け入れ、draft-02 ワイヤとの後方互換は維持しない。

1. `src/loc.ts` の参照コメント・節番号を draft-04 に更新する
2. `LOCPropertyId` を Table 1 に合わせる
   - `TIMESTAMP = 0x10n`
   - `TIMESCALE = 0x08n` (据え置き)
   - `VIDEO_FRAME_MARKING = 0x09n`
   - `AUDIO_LEVEL = 0x0Cn`
   - `VIDEO_CONFIG` (現行 `CONFIG` をリネーム) `= 0x0Dn`
   - `AUDIO_CONFIG = 0x0Fn` を追加
3. VIDEO_FRAME_MARKING を奇数 ID の length + bytes 形式に変更する。値バイト列は RFC9626 のフレームマーキングバイト列 (1–4 bytes) をそのまま載せ、varint 詰めはやめる
4. AUDIO_CONFIG の encode / decode と `AudioProperties` への optional フィールドを追加する (WebCodecs `AudioDecoderConfig.description` 相当の opaque bytes)
5. `decodeVideoProperties` / `decodeAudioProperties` の分岐を新 ID に合わせる。未知 ID のスキップ規則 (偶数 = varint、奇数 = length + bytes) は維持する
6. `src/loc.prop.ts` / LOC 単体テストを新ワイヤに合わせて更新する。TIMESTAMP / AUDIO_LEVEL 衝突前提のテスト・コメントを削除する
7. 高レベル API (`createMediaPublisher.ts` / `createMediaSubscriber.ts`) は public API を変えず、LOC ヘルパ差し替えの追従のみ行う
8. README の LOC 節に AUDIO_CONFIG を追記し、参照コメント (`devtools` 含む) を draft-04 に更新する
9. pending `#0036` は本 issue の完了後に「draft-04 で ID 衝突が解消された」旨を追記して closed にする (本 issue のコード変更コミットとは分ける)

### 範囲外 (別 issue)

- LOC Private Properties フレーミング → `#0346`
- TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG の Track Property 経路 → `#0347`
- §3 Secure Objects / Payload Encryption → `#0353` (pending: refs 未取得)
- MSF Catalog 側の変更 (本 issue は LOC モジュールとその直接利用箇所に限定)

## 完了条件

### コードベース

- `src/loc.ts` 冒頭が `draft-ietf-moq-loc-04` を参照している
- `LOCPropertyId` が Table 1 の ID と一致し、`AUDIO_CONFIG` が存在する
- VIDEO_FRAME_MARKING が `0x09` + length + 1–4 bytes で encode / decode される
- AUDIO_CONFIG (`0x0F`) の encode / decode round-trip が通る
- TIMESTAMP (`0x10`) と AUDIO_LEVEL (`0x0C`) が衝突しない
- `createMediaPublisher` / `createMediaSubscriber` が新 ID の Properties を送受信する
- README の LOC Properties に Audio Config が含まれる
- `src/` / `devtools/` に `draft-ietf-moq-loc-02` 参照が残っていない (`CHANGES.md` / `issues/` / `refs/` は除外)

### テスト

- `src/loc.prop.ts` および関連テストが新ワイヤで pass する
- `vp run test` / `vp run build` が pass する

### 関連 issue

- pending `#0036` を本対応完了後に closed にする (理由追記コミット + 移動コミット)
