# C4M claim label の旧ベクタ固定値を最新の暫定値運用へ移す

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-c4m-provisional-claim-labels
- Polished: 2026-11-03

## 目的

C4M 02 は moqt / moqt-reval の claim key を本文では引き続き TBD とし、付録 A の検証用には Private Use の -65537 / -65538 を使うと明示した。旧付録由来の 327 / 328 を固定すると最新の検証用トークンを解釈できない。

## 現状

- `src/c4m/moqt.ts` の `CLAIM_MOQT = 327` / `CLAIM_MOQT_REVAL = 328` は C4M 01 付録 A の値を採用する
- `src/c4m/cat.ts` の `isTypedClaimKey` / `decodeCatClaimsCore` / `encodeCatClaims` と builder がこの固定値に依存する
- 未知の claim は raw として保持されるため、-65537 を受けても moqt の認可スコープとして解釈されない

## 設計方針

- 実験用 claim label を確定した IANA 割当値として扱わない。共有の読み取り専用設定型 C4mClaimLabels を `{ moqt: number, moqtReval: number }` として定義し、両値を安全な整数に制限する。暗黙の既定値は置かず、設定の未指定・不正型・範囲外・既知 claim との衝突は処理開始時に拒否する
- decodeCatClaims / encodeCatClaims は label 設定を必須引数とし、CatToken の decode / decodeCompact / decodeCose / decodeMoqtAuthToken の各入口と CatTokenBuilderOptions には必須の claimLabels 設定を渡す。内部の encode / decode 呼出しへ同じ設定を伝搬し、Token / builder は設定をコピーして保持する。verify は同じ設定でデコード済みの claims を検証し、別の label 設定で再解釈しない
- C4M 02 の付録 A 用に C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS を公開し、moqt=-65537、moqtReval=-65538 とする。テストと devtools もこの preset を明示して使い、運用では peer と合意した暫定値を明示する
- signed CBOR integer で正しく表現し、key の衝突や同じ意味の claim の二重指定を拒否する
- 327 / 328 と Private Use の値を無条件に同時認識して曖昧な認可結果を作らない。旧値を標準値とする説明を除く
- `src/msf/c4mAuthorization.ts` の外部トークンを復号せずそのまま運ぶ経路は維持する。外部発行済みトークンの中身を書き換えない

## 完了条件

- 最新付録の Private Use label で moqt / moqt-reval を encode / decode できる
- label 設定の共有、衝突、不正型、他の claim との区別を検証する
- compact / COSE / MOQT Auth Token の全入口と builder で設定が伝搬し、未設定で拒否され、設定元を後から変更しても Token / builder の解釈が変わらない
- CBOR で負数の label を正確に保持する
- IANA 未割当と相互接続上の事前合意が API 文書から分かる

## 参照

- `refs/moq/draft-ietf-moq-c4m-02.txt` §2.1 / §2.2 / §8 / Appendix A 導入
- `src/c4m/moqt.ts`、`src/c4m/cat.ts`、`src/c4m/cbor.ts`、`src/msf/c4mAuthorization.ts`
- [IANA CWT Claims](https://www.iana.org/assignments/cwt)（2026-11-03 確認。moqt / moqt-reval は未掲載、327 / 328 は未割当範囲、-65536 未満は Private Use）
- 0917 の map schema、0920 の付録検証と組み合わせる

## 解決方法

{未着手}
