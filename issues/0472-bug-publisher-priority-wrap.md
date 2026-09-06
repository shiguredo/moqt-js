# Publisher Priority の未検証による黙示丸め

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-publisher-priority-range
- Polished: 2026-09-06

## 目的

subgroup / datagram 両経路で範囲外 priority が `Uint8Array` 化で黙って丸められ (`300` → `44`)、意図しない優先度で送信される。encode 層で検証して失敗させる必要がある。

## 現状

- 丸めの実体は `src/dataStream.ts` の `encodeSubgroupHeader` と `encodeObjectDatagram` の `new Uint8Array([priority])` であり、範囲検証なしに剰余化する。`src/session/publish.ts` の両使用箇所 (`publishSendObject` / `publishSendDatagram` の `params.priority ?? 128`) にも 0-255 検証がない。
- `src/session/params.ts` の `buildPublishTrackProperties` が検証するのは PUBLISH 制御メッセージ用の `options.publisherPriority` という別値であり、送信経路の `params.priority` とは異なる。共通化ではなく送信経路側の検証欠落が問題である。
- per-object / per-datagram の `Publisher Priority (8)` の規範は §11.2 / §11.3 / §11.4.2 の 8 bit 定義である (§12.4 の invalid 定義は `DEFAULT_PUBLISHER_PRIORITY` Track Property の規定のため根拠にしない)。

## 設計方針

1. `encodeSubgroupHeader` と `encodeObjectDatagram` で `Uint8Array` 化前に検証し、非整数または 0-255 外は `throw` する (英語メッセージ、期待値と実際値を含む。両経路一括)。
2. subgroup 経路の `throw` の伝播 (キューチェーンの吸収) は `0471` の見直しに合わせる。datagram 経路は同期 `throw` が呼び出し元に直接伝搬する。
3. 境界値の単体テストを追加する (`0` / `255` / `256` / `-1` / `300` / `1.5` / `NaN` × subgroup / datagram 両経路)。

## 完了条件

- 範囲外・非整数 priority で送信前に失敗し、両経路とも丸め送信が起きないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.2 / §11.3 / §11.4.2
- `0471` (subgroup 経路の `throw` 伝播の見直し)
