# MSF の Secure Objects 暗号化を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-secure-objects-encryption
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §4.3 は catalog の `encryptionScheme` / `cipherSuite` / `keyId` / `trackBaseKey` で暗号化をシグナリングし、`moq-secure-objects` を RECOMMENDED とする。型・MUST 検証は `#0316` で済んでいるが、ペイロードの暗号化 / 復号の実行は未実装である。

## 優先度根拠

catalog で暗号化を宣言しても復号できないと再生不能。ただし平文トラックは従来どおり動く。Secure Objects ドラフトが `refs/` 未取得のため Medium + pending。

## 現状

- catalog field の型・`encryptionScheme` 指定時の `cipherSuite` MUST 検証は実装済み
- 高レベル API は暗号化 / 復号を行わない
- `#0316` 範囲外: 暗号化の実処理
- 依存: [SecureObjects] (`draft-ietf-moq-secure-objects`)、LOC 側 `#0353`

## 設計方針

1. `refs/` に Secure Objects を取得する
2. `#0353` (LOC 統合) と共通の暗号コアを使う
3. subscriber は `encryptionScheme` 存在時に MUST で復号してから LOC / WebCodecs へ渡す (§4.3.1)
4. 鍵取得 (MLS 等) はアウトオブバンド注入にし、本 issue では `keyId` / `trackBaseKey` を受け取って復号できるところまで

## 完了条件

- `encryptionScheme: "moq-secure-objects"` トラックの暗号化 publish / 復号 subscribe が動く
- catalog MUST field 欠落時は既存検証どおり reject
- テストがある
- `vp run test` / `vp run build` が pass する

## pending 理由

依存仕様 `draft-ietf-moq-secure-objects` が `refs/moq/` に未取得のため、実装根拠を固定できない。取得後に open (reopened) して着手する。LOC 側 `#0353` と同時期に進める。

## 関連

- `#0316` (closed) catalog シグナリング
- `#0353` LOC Secure Objects 統合
