# MSF_COMPRESSION Property を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-compression-property
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-02 §12.1 は Catalog / Timeline 等のペイロード圧縮を MSF_COMPRESSION Track / Object Property でシグナリングし、無圧縮と GZIP の双方を MUST サポートとする。`#0316` で `options.gzip` を撤廃した代替経路が無く、Property ID の定数と Algorithm 定数のみ存在する。

## 優先度根拠

draft-02 で Property ID が 0x78 に確定したため、保留理由 (TBD 待ち) は解消した。実装は未着手であり、draft-02 の MUST (無圧縮と GZIP の両対応、Track と Object の併用 MUST NOT) を満たす必要がある。

## 現状

- `MsfCompressionAlgorithm = { NONE: 0n, GZIP: 1n }` (`src/properties.ts`)
- `MSFPropertyId.MSF_COMPRESSION = 0x78n` を定義済み。scope 表 (`both`) と対応済み Property 表にも登録済み
- ただし gzip の encode / decode は未実装であり、`decodeCatalogMessage` / `decodeMediaTimeline` / `decodeEventTimeline` は無圧縮 JSON を前提にしている。0x78 を「対応済み」として素通しするため、圧縮 payload は `JSON.parse` で失敗する
- `#0316` で「ID 確定後に別 issue」とされていた本項目

## 前提の更新 (2026-11-16)

- draft-02 §12.1 で Property ID 0x78、Algorithm 0 (無圧縮) / 1 (GZIP) が確定した
- §12.1.1 / §12.1.2 は Track scope と Object scope の両方を許し、同一 track での併用を MUST NOT とする
- 本 issue を再開するときは、上の 2 点を満たす設計に更新してから着手する

## 設計方針

1. IANA が Track / Object Property ID を割り当てたら定数を追加する
2. encode / get helper、同一 track での Track + Object 併用 MUST NOT 検証を実装する
3. publisher 圧縮オプションと subscriber の `DecompressionStream("gzip")` 自動展開を実装する
4. Catalog / Media Timeline / Event Timeline の圧縮経路を統一する

## 完了条件

- Track / Object 双方の MSF_COMPRESSION Property ID が仕様どおり定義されている
- 無圧縮と GZIP の双方を送受信できる
- Track + Object 併用で reject する
- `vp run test` / `vp run build` が pass する

## pending 理由

draft-ietf-moq-msf-02 §14.3 で MSF_COMPRESSION の Property ID が TBD。仮値を実装すると将来の正式 ID と衝突するため、IANA 割り当て確定まで pending とする。

## 関連

- `#0316` (closed) gzip API 撤廃と Algorithm 定数準備
- `#0345` Catalog delta / Joining FETCH（圧縮は本 issue へ分離済み）
