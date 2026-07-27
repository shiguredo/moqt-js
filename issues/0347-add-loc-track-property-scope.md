# LOC Properties を Track Property としても扱えるようにする

- Priority: Low
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-loc-track-property-scope
- Polished: 2026-07-27

## 目的

draft-ietf-moq-loc-04 Table 1 で TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG の Scope が `Track, Object` と定義されているが、現状は Object Properties (LOC 埋め込み) 経路のみで、PUBLISH / SUBSCRIBE_OK 等の Track Properties として広告・解釈する経路が無い。Track Property 経路を追加する。

## 優先度根拠

Object 単位の Properties でも再生は成立する。Track スコープは冗長送信削減や初期化共有向けで、今すぐの相互運用ブロッカーではないため Low。

## 現状

- loc-04 Table 1 (refs L957-971): TIMESCALE (0x08) / VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) は Scope: Track, Object。TIMESTAMP (0x10) / VIDEO_FRAME_MARKING (0x09) / AUDIO_LEVEL (0x0C) は Object のみ
- `src/loc.ts` の encode / decode は Object Properties バイト列向け（絶対 Type ID 連結であり、Track Properties が要求する delta 符号化とは異なる）
- Track Properties は `src/properties.ts` の `encodeProperties()` / `decodeProperties()` が delta-encoded Key-Value-Pair 形式 (transport-19 §1.4.3) で扱う。LOC ID も `Property` オブジェクトとして渡せば既存インフラで encode / decode 可能
- `TrackPropertyId` に LOC ID は未登録。ただし `LOCPropertyId` の ID を `Property.id` にそのまま渡せるため、`TrackPropertyId` への追加は必須ではない
- transport-19 Table 15 (provisional) は VIDEO_CONFIG の Scope を Object のみとしており loc-04 Table 1 と不一致。Scope の正本は loc-04 Table 1（`#0344` で transport-19 provisional 値の不採用方針は確立済み）
- `#0344` (closed, 2026-07-24 完了) で LOC Property ID は draft-04 に追従済み

## 設計方針

1. Track Properties 経路は `src/properties.ts` の `Property` オブジェクト + `encodeProperties()` (delta 符号化) を使う。`src/loc.ts` の絶対 Type 連結 encode 関数は Track Properties に流用しない（ワイヤ形式が異なる）
2. publisher が Track 初期化時に Config / Timescale を Track Property として送る helper を追加する（optional な API パラメータとして提供。送らない場合は既存どおり Object Properties のみ）
3. subscriber は Track Property と Object Property の両方を探索する。同一 Property が両方に存在する場合、Object Property が Track Property を上書きする（transport-19 §12.1 の SUBGROUP_DELIVERY_TIMEOUT 先例に倣う）

## 完了条件

- `LOCPropertyId.TIMESCALE` / `VIDEO_CONFIG` / `AUDIO_CONFIG` を `Property` オブジェクトとして構築し、`encodeProperties()` 経由で Track Properties バイト列に載せる helper がある
- subscriber が Track Property と Object Property の両方を探索し、Object 優先で解釈する経路がある
- Object のみ / Track のみ / 両方 のケースをテストでカバーする
- `CHANGES.md` の `## develop` に `[ADD]` を追記する
- `vp run test` / `vp run build` が pass する

## 関連

- `#0344` LOC draft-04 Property ID 追従 (2026-07-24 完了)
