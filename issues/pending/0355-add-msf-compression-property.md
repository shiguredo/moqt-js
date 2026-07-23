# MSF_COMPRESSION Property を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-compression-property
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §12 / §5.5 / §7.1 / §8.1 は Catalog / Timeline 等のペイロード圧縮を MSF_COMPRESSION Track / Object Property でシグナリングし、GZIP を MUST サポートとする。`#0316` で `options.gzip` を撤廃した代替経路が無く、Algorithm 定数のみ存在する。

## 優先度根拠

§12 は GZIP MUST だが、Property ID が §14.3 で TBD のため仮 ID を打つと誤ったワイヤ互換を生む。実装は ID 確定待ち。Medium + pending。

## 現状

- `MsfCompressionAlgorithm = { NONE: 0n, GZIP: 1n }` (`src/properties.ts:33-36`)
- Property ID 定数は未定義 (コメントで TBD と明記)
- Timeline encode / decode は無圧縮 JSON のみ (`src/msf.ts:1836` 付近)
- `#0316` / `#0345` で「ID 確定後に別 issue」とされていた本項目

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

draft-ietf-moq-msf-01 §14.3 で MSF_COMPRESSION の Property ID が TBD。仮値を実装すると将来の正式 ID と衝突するため、IANA 割り当て確定まで pending とする。

## 関連

- `#0316` (closed) gzip API 撤廃と Algorithm 定数準備
- `#0345` 残項目 (圧縮は本 issue へ分離)
