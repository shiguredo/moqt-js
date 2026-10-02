# Object Forwarding Preference を Delivery Mode に改名する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/change-delivery-mode-terminology
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §1.3 で Object Forwarding Preference が Delivery Mode に改名された。用語だけでなく意味も整理され、「Original Publisher が最初の送信方法で Object の Delivery Mode を確立し、subscription ではその Delivery Mode に従って送る」となった。v21 にあった「Object ごとに変わり得る」という記述は削除され、Fetch では Delivery Mode が適用されないことが §3.2.1 に明記された。

moqt-js は v21 の用語でコメントを書いているため、用語と参照を更新し、実装の意味解釈が v22 と整合することを確認する。

## 現状

- `src/dataStream/fetch.ts` の `decodeFetchSubgroupId` / `decodeFetchObjectFields` / `createFirstFetchObjectFlags` のコメントが "Forwarding Preference" と v21 §11.4.1.1 を参照している
- `src/` に `ObjectForwardingPreference` / `DeliveryMode` のシンボルは無い (draft-18 で追加され draft-19 で未使用削除済み)。Subgroup と Datagram の区別は `SubgroupHeader` / `ObjectDatagram` / Fetch の DATAGRAM ビット (0x40) で表現している
- Fetch Object のデコードは DATAGRAM ビットで Subgroup ID の有無を切り替えており、v22 §3.2.1「Fetch に Delivery Mode は適用されない」と矛盾しない
- Publisher は `sendObject` (Subgroup) と `sendDatagram` (Datagram) を API で選ぶ。Object の初回送信で方式が決まるという v22 の意味づけと一致する

## 設計方針

- コメント・JSDoc の用語を Delivery Mode に統一し、参照を v22 §1.3 (Terms and Definitions) / §3.2.1 (Fetch Object Delivery) / §11.4.1.1 (Flags) に更新する
- 「Original Publisher が初回送信で確立する」ことと「Fetch では適用されない」ことをコメントに明記する
- シンボルの新設・改名は行わない (既存の API で方式を選ぶ設計を維持する)
- devtools やログに "Forwarding Preference" の表示が残っていないか確認し、あれば Delivery Mode に合わせる

## 完了条件

- `src/` と `devtools/` のコメント・表示から "Forwarding Preference" が無くなっている (refs/ と CHANGES.md の過去履歴は対象外)
- ワイヤ形式・挙動の変更が無いことをテストで確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §1.3 (Delivery Mode) / §3.2.1 / §11.4.1.1 / §11.2.1 / §11.3.1
- `src/dataStream/fetch.ts` の `decodeFetchSubgroupId` / `createFirstFetchObjectFlags` / `FetchSerializationFlags.DATAGRAM`
- `src/dataStream/datagram.ts` の `ObjectDatagram` / `src/dataStream/subgroup.ts` の `SubgroupHeader`

## 解決方法

{未着手}
