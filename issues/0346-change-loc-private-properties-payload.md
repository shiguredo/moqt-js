# LOC Object Payload に Private Properties フレーミングを実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-loc-private-properties-payload
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-loc-04 §2.2 では、MOQ Object Payload は「LOC Private Properties + LOC Payload」で構成される。現状の高レベル API は Encoded\*Chunk の internal data のみを Payload に載せており、Private Properties を Payload 側へ載せる経路が無い。公開 Properties と Payload 側 Private Properties の配置を仕様どおりにする。

## 優先度根拠

Property ID 追従 (`#0344`) の後続作業。暗号化 (`#0353`) なしでも Private Properties の空 / 非機密メタデータ配置は意味があるが、相互運用のブロッカーは ID 不一致の方が大きいため Medium。

## 現状

- loc-04 §2.2 (refs L286-315): `LOC Private Properties + LOC Payload = all MOQ Object Payload`
- `createMediaPublisher` は `sendObject({ payload: chunk.data, properties })` で Public Properties のみを Object Properties に載せ、Payload は生チャンク
- Private Properties の長さ prefix / キー値列の符号化ヘルパは `src/loc.ts` に無い

## 設計方針

1. `#0344` (Property ID 追従) 完了後に着手する
2. Payload 先頭に Private Properties ブロックを載せる encode / decode API を `src/loc.ts` に追加する
3. 高レベル API は当面 Public Properties のみを使い、Private を空 (または未使用) にできるデフォルトを維持する
4. Sensitive metadata を Private へ移す判断は Secure Objects issue (`#0353`) と分担する

## 完了条件

- Private Properties + LOC Payload の encode / decode round-trip がある
- 空 Private Properties 時に現行と同じ生チャンク Payload と相互運用できる方針がテストで固定されている
- `vp run test` / `vp run build` が pass する

## 関連

- `#0344` LOC draft-04 Property ID 追従 (先行必須)
- `#0353` LOC Secure Objects 統合 (Private の暗号化利用)
