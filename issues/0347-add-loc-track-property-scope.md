# LOC Properties を Track Property としても扱えるようにする

- Priority: Low
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-loc-track-property-scope
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-loc-04 Table 1 では TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG の Scope が `Track, Object` である。現状は Object Properties (LOC 埋め込み) 経路のみで、PUBLISH / SUBSCRIBE_OK 等の Track Properties として広告・解釈する経路が無い。

## 優先度根拠

Object 単位の Properties でも再生は成立する。Track スコープは冗長送信削減や初期化共有向けで、今すぐの相互運用ブロッカーではないため Low。

## 現状

- loc-04 Table 1 (refs L957-971): TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG は Track, Object
- TIMESTAMP / VIDEO_FRAME_MARKING / AUDIO_LEVEL は Object のみ
- `src/loc.ts` の encode / decode は Object Properties バイト列向け
- Track Properties は `src/properties.ts` の `TrackPropertyId` 経由。LOC ID は未登録

## 設計方針

1. `#0344` 完了後に着手する (ID が draft-04 と一致している前提)
2. Track Properties リストへ TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG を載せられる helper を追加する
3. 高レベル publisher が Track 初期化時に Config / Timescale を Track Property として送る経路を任意で用意する
4. subscriber は Track Property と Object Property の両方を探索する (Object 側を優先する等、方針をテストで固定)

## 完了条件

- Track Property としての TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG の encode / decode がある
- Object のみ / Track のみ / 両方 のケースをテストでカバーする
- `vp run test` / `vp run build` が pass する

## 関連

- `#0344` LOC draft-04 Property ID 追従 (先行必須)
