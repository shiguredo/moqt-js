# Object Forwarding Preference を Delivery Mode に改名する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-delivery-mode-terminology
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 で Object Forwarding Preference が Delivery Mode に改名された（改名は Appendix A (Change Log) の "Rename Forwarding Preference to Delivery Mode, established by the Original Publisher (#1886, #1891, #1914)" に記され、定義は v22 §2.1.1 (Object Fields) にある）。用語だけでなく意味も整理され、「Original Publisher が最初の送信方法で Object の Delivery Mode を確立し、subscription ではその Delivery Mode に従って送る」となった。v21 にあった「Object ごとに変わり得る」という記述は削除され、Fetch では Delivery Mode が適用されないことが §3.2.1 に明記された。

moqt-js は v21 の用語でコメントを書いているため、用語と参照を更新し、実装の意味解釈が v22 と整合することを確認する。

## 現状

- `src/dataStream/fetch.ts` の `decodeFetchSubgroupId` / `decodeFetchObjectFields` / `createFirstFetchObjectFlags` のコメントが "Forwarding Preference" と v21 §11.4.1.1 を参照している
- `src/` に `ObjectForwardingPreference` / `DeliveryMode` のシンボルは無い (draft-18 で追加され draft-19 で未使用削除済み)。Subgroup と Datagram の区別は `SubgroupHeader` / `ObjectDatagram` / Fetch の DATAGRAM ビット (0x40) で表現している
- Fetch Object のデコードは DATAGRAM ビットで Subgroup ID の有無を切り替えており、v22 §3.2.1「Fetch に Delivery Mode は適用されない」と矛盾しない
- Publisher は `sendObject` (Subgroup) と `sendDatagram` (Datagram) を API で選ぶ。Object の初回送信で方式が決まるという v22 の意味づけと一致する

## 設計方針

- コメント・JSDoc の用語を Delivery Mode に統一し、参照を v22 §2.1.1 (Object Fields) / §3.2.1 (Fetch Object Delivery) / §11.4.1.1 (Flags) に更新する
- v22 §11.4.1.1 の表は Table 9 (Subgroup ID encoding) / Table 10 (Independent flag bits) に再採番されているため、`FetchSerializationFlags` の JSDoc で v21 の Table 8 / 9 を引用している箇所も合わせる
- 「Original Publisher が初回送信で確立する」ことと「Fetch では適用されない」ことをコメントに明記する
- シンボルの新設・改名は行わない (既存の API で方式を選ぶ設計を維持する)
- devtools やログに "Forwarding Preference" の表示が残っていないか確認し、あれば Delivery Mode に合わせる

## 完了条件

- `src/` と `devtools/` のコメント・表示から "Forwarding Preference" (大文字・小文字を問わず) が無くなっている (refs/ と CHANGES.md の過去履歴は対象外)
- ワイヤ形式・挙動の変更が無いことをテストで確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §2.1.1 (Delivery Mode の定義) / §3.2.1 (Fetch Object Delivery) / §11.4.1.1 (Flags) / §11.2.1 (Object Datagram) / §11.3.1 (Subgroup Header)
- `src/dataStream/fetch.ts` の `decodeFetchSubgroupId` / `decodeFetchObjectFields` / `createFirstFetchObjectFlags` / `FetchSerializationFlags.DATAGRAM`
- `src/dataStream/datagram.ts` の `ObjectDatagram` / `src/dataStream/subgroup.ts` の `SubgroupHeader`

## 解決方法

### 1. 用語と参照の更新

- `src/dataStream/fetch.ts`: "Forwarding Preference" と書いていた 3 箇所 (`decodeFetchSubgroupId` の JSDoc、`decodeFetchObjectFields` の引用、`createFirstFetchObjectFlags` の `@param`) を直した。`decodeFetchObjectFields` の引用は `decodeFetchSubgroupId` の JSDoc と同じ内容だったため、呼び出し側のコメントは短くして 1 箇所に集約した。逐語引用は v22 §11.4.1.1 (Flags) の文面に合わせ、`FetchSerializationFlags.DATAGRAM` の JSDoc とファイル冒頭にも Delivery Mode の位置づけを書いた
- DATAGRAM ビット (0x40) の説明は「Subgroup ID の有無だけを表す」ではなく、v22 §11.4.1.1 の MUST / SHOULD に合わせて主体を書き分けた (送信側は MUST で立て、下位 2 ビットを 0 にするのが SHOULD。受信側は下位 2 ビットを無視する MUST)
- `src/publisher.ts`: `sendObject` / `sendDatagram` の JSDoc に、Delivery Mode が Original Publisher の最初の送信方法で確立されること (§2.1.1)、確立後は同じ Object を Delivery Mode に従って送る必要があること、異なる Delivery Mode で受け取った Object は malformed track になること (§12.1 の条件 7)、Fetch では Delivery Mode が適用されないこと (§3.2.1) を書いた
- Fetch では Delivery Mode が適用されない (§3.2.1) ため、Fetch Object の DATAGRAM ビットは Delivery Mode ではなく符号化の指示 (Subgroup ID フィールドを持たない) であることを明記した

### 2. Subgroup と Datagram の併用の根拠の更新

同じ「同一 Track で Subgroup と Datagram を併用できる」という記述が v21 §2.2 / §11.2 を引いていたため、v22 §2.1 に揃えた (混在できるのは Object 単位であり、同じ Object を両方式で送ることはできない)。

- `src/publisher.ts` / `src/dataStream.ts` / `src/subscriber.ts`
- `devtools/src/utils/audioDelivery.ts` / `devtools/src/signals/subscriber.ts` / `devtools/src/signals/statsSnapshot.ts`

### 3. devtools と本体の用語の確認

`src/` と `devtools/` で "Forwarding Preference" (大文字小文字を問わず) は 0 件になった。devtools に残る "forwarding" は FORWARD パラメータ (Forward State) の表示 ("1 (forwarding)") であり、Delivery Mode とは別の概念なので変更していない。

### 4. 挙動とワイヤ形式

差分はコメントと CHANGES.md のみで、実行されるコードは変更していない。DATAGRAM ビット (0x40) の扱いは `src/dataStream.fetch.test.ts` と `src/dataStream.prop.ts` の既存テストがワイヤ長まで含めて固定しており、`vp test run` で変わらないことを確認した。

### 5. 対象外としたもの

`src/dataStream/datagram.ts` / `src/dataStream/subgroup.ts` は "Forwarding Preference" を含まず、参照しているのは Object Datagram (§11.2.1) と Subgroup Header (§11.3.1) のビット定義である。節番号は v22 でも同じだが、Figure の番号 (v21 Figure 24/25/26 → v22 Figure 25/26/27) と draft の版表記が v21 のまま残っている。これは用語の改名とは別の一括更新の対象であり、本 issue では触れていない。

### 6. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3569 tests) が通る。`/review-diff-code` を 3 周回し、指摘はすべて反映した (最終周で致命的 0 件)。CHANGES.md の `## develop` の `### misc` に [UPDATE] エントリを追加した。
