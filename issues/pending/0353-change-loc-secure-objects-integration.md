# LOC の Secure Objects 統合を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-loc-secure-objects-integration
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-loc-04 §3 は [SecureObjects] (`draft-ietf-moq-secure-objects`) によるエンドツーエンド暗号化連携を定義する。Key ID immutable、Private Properties、cipher suite MUST、AAD 構築などが未実装である。

## 優先度根拠

暗号化配信の相互運用に必要だが、平文 LOC だけでは再生できる。依存ドラフトが `refs/` に未取得のため着手不能に近く、Medium + pending。

## 現状

- loc-04 §3.1 (refs L481-575): Secure Objects Integration
- `refs/moq/` に `draft-ietf-moq-secure-objects` が無い (loc-04 は `-01` を参照)
- `#0344` は暗号化実処理を範囲外としている
- `#0346` が Private Properties フレーミングを担当

## 設計方針

1. 先に `refs/moq/` へ Secure Objects ドラフトを取得する (`/update-refs` 等)
2. `#0344` / `#0346` 完了後に、Key ID immutable・Private Properties 暗号化・AES_128_GCM_SHA256_128 MUST を実装する
3. MSF 側の暗号化実行 (`#0354`) とモジュールを共有できるなら共通化する

## 完了条件

- `refs/` に Secure Objects 一次資料がある
- LOC + Secure Objects の暗号化 / 復号パスがテスト可能である
- cipher suite MUST 要件を満たす
- `vp run test` / `vp run build` が pass する

## pending 理由

依存仕様 `draft-ietf-moq-secure-objects` が `refs/moq/` に未取得のため、実装根拠を固定できない。取得後に open (reopened) して着手する。

## 関連

- `#0344` Property ID 追従
- `#0346` Private Properties フレーミング
- `#0354` MSF Secure Objects 暗号化
