# C4M claim label の旧ベクタ固定値を最新の暫定値運用へ移す

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-c4m-provisional-claim-labels
- Polished: {YYYY-MM-DD}

## 目的

C4M 02 は moqt / moqt-reval の claim key を本文では引き続き TBD とし、付録 A の検証用には Private Use の -65537 / -65538 を使うと明示した。旧付録由来の 327 / 328 を固定すると最新の検証用トークンを解釈できない。

## 現状

- `src/c4m/moqt.ts` の `CLAIM_MOQT = 327` / `CLAIM_MOQT_REVAL = 328` は C4M 01 付録 A の値を採用する
- `src/c4m/cat.ts` の `isTypedClaimKey` / `decodeCatClaimsCore` / `encodeCatClaims` と builder がこの固定値に依存する
- 未知の claim は raw として保持されるため、-65537 を受けても moqt の認可スコープとして解釈されない

## 設計方針

- 実験用 claim label を確定した IANA 割当値として扱わない。codec / builder / verifier が同じ label 設定を使えるようにする
- C4M 02 の付録 A を検証する設定は moqt=-65537、moqt-reval=-65538 とし、運用の暫定値は peer と合意した設定として明示する
- signed CBOR integer で正しく表現し、key の衝突や同じ意味の claim の二重指定を拒否する
- 327 / 328 と Private Use の値を無条件に同時認識して曖昧な認可結果を作らない。旧値を標準値とする説明を除く
- `src/msf/c4mAuthorization.ts` の外部トークンを復号せずそのまま運ぶ経路は維持する。外部発行済みトークンの中身を書き換えない

## 完了条件

- 最新付録の Private Use label で moqt / moqt-reval を encode / decode できる
- label 設定の共有、衝突、不正型、他の claim との区別を検証する
- CBOR で負数の label を正確に保持する
- IANA 未割当と相互接続上の事前合意が API 文書から分かる

## 参照

- `refs/moq/draft-ietf-moq-c4m-02.txt` §2.1 / §2.2 / §8 / Appendix A 導入
- `src/c4m/moqt.ts`、`src/c4m/cat.ts`、`src/c4m/cbor.ts`、`src/msf/c4mAuthorization.ts`
- 0917 の map schema、0920 の付録検証と組み合わせる

## 解決方法

{未着手}
