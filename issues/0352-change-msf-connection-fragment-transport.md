# MSF URI fragment の connection による transport 選択を適用する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-msf-connection-fragment-transport
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §11.1.1 の `connection=q|wt` は Native QUIC / WebTransport の選択を示す。`getConnectionParameter` は実装済みだが、接続 API への強制適用は未配線である (`#0316` / `#0345` で helper まで)。

## 優先度根拠

fragment で `connection=wt` と指定しても無視されると、想定外の transport で接続し失敗し得る。helper はあるので適用配線の欠落が実害になるため Medium。

## 現状

- `parseMsfFragmentValue` / `getConnectionParameter` (`src/msf.ts:2352`) は `"q"` / `"wt"` を返す
- 高レベル API の connect は WebTransport 前提で、`connection` 値を見て分岐・拒否しない
- `#0345` は reserved key helper 追加までを担当し、本適用は別 issue とした

## 設計方針

1. `#0345` の fragment helper 整備と並行または直後に着手する
2. `connection=wt` は現行 WebTransport 接続を許可、`connection=q` は未サポートなら明確にエラーとする (Native QUIC 実装が無い前提をドキュメント化)
3. `connection` 欠如時は現状どおり (デフォルト WebTransport)
4. URL 構築側 (devtools / 利用例) があれば整合を取る

## 完了条件

- fragment の `connection` が接続開始前に解釈される
- 未サポート値 / `q` (Native QUIC 未実装時) で失敗理由が分かる
- テストがある
- `vp run test` / `vp run build` が pass する

## 関連

- `#0345` MSF draft-01 残項目 (helper 側)
