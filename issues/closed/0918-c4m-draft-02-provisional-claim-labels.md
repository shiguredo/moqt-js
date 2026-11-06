# C4M claim label の旧ベクタ固定値を最新の暫定値運用へ移す

- Created: 2026-11-03
- Completed: 2026-11-05
- Branch: feature/change-c4m-draft-02
- Polished: 2026-11-03

## 目的

C4M 02 は moqt / moqt-reval の claim key を本文では引き続き TBD とし、付録 A の検証用には Private Use の -65537 / -65538 を使うと明示した。旧付録由来の 327 / 328 を固定すると最新の検証用トークンを解釈できない。

## 現状

- `src/c4m/moqt.ts` の `CLAIM_MOQT = 327` / `CLAIM_MOQT_REVAL = 328` は C4M 01 付録 A の値を採用する
- `src/c4m/cat.ts` の `isTypedClaimKey` / `decodeCatClaimsCore` / `encodeCatClaims` と builder がこの固定値に依存する
- 未知の claim は raw として保持されるため、-65537 を受けても moqt の認可スコープとして解釈されない

## 設計方針

- 実験用 claim label を確定した IANA 割当値として扱わない。共有の読み取り専用設定型 C4mClaimLabels を `{ moqt: number, moqtReval: number }` として定義し、両値を安全な整数に制限する。暗黙の既定値は置かず、設定の未指定・不正型・範囲外・既知 claim との衝突は処理開始時に拒否する
- decodeCatClaims / encodeCatClaims は label 設定を必須引数とし、CatToken の decode / decodeCompact / decodeCose / decodeMoqtAuthToken の各入口と CatTokenBuilderOptions には必須の claimLabels 設定を渡す。内部の encode / decode 呼出しへ同じ設定を伝搬し、Token / builder は設定をコピーして保持する。verify は署名 / MAC を検証し、expectedAlgorithm / expectedType を指定した場合にだけ alg / typ を検証する。claims の値の検証は validateCatClaims が行う。デコード時の label 設定を別に受け取って claims を再解釈する経路は持たない
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

- `src/c4m/moqt.ts` の固定値 `CLAIM_MOQT` / `CLAIM_MOQT_REVAL` を削除し、読み取り専用の設定型 `C4mClaimLabels` (`{ readonly moqt: number, readonly moqtReval: number }`) と、付録 A 用の preset `C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS` (moqt=-65537 / moqtReval=-65538、`Object.freeze`) を公開した。暗黙の既定値は無く、preset を自動で使う経路も無い。
- `decodeCatClaims` / `encodeCatClaims` を claim label 設定の必須引数にした。`CatToken.decode` / `decodeCompact` / `decodeCose` / `decodeMoqtAuthToken` と `CatTokenBuilderOptions` にも必須の `claimLabels` を追加し、内部の decode / encode 呼出しへ同じ設定を伝搬した。
- 設定の検証は処理開始時に行う。未指定、object 以外、`Number.isSafeInteger` でない値、`moqt` と `moqtReval` が同じ値、IANA CWT Claims レジストリに登録済みの 76 件 (`IANA_CWT_CLAIM_KEYS`) との重複は、`CatError` の新コード `invalidClaimLabels` で拒否する。IANA が `moqt` / `moqt-reval` に割り当てた値は、claim 別の対応表 (`MOQT_CLAIM_LABEL_KEYS`) に従って同じ claim の label としてだけ許可し、他方の claim へ取り違えない。負の label は既知 claim と衝突しないため受理する。
- Token / builder は検証済みの設定を `Object.freeze` したコピーとして保持する。呼び出し元が設定元のオブジェクトを後から変更しても、解釈と発行結果は変わらない。`CatToken.claimLabels()` でデコードに使った設定を参照できる。
- `CatToken.verify` は署名 / MAC を検証し、`expectedAlgorithm` / `expectedType` を指定した場合にだけ `alg` / `typ` を検証する。claims の値 (`exp` / `nbf` / `iss` / `aud`) の検証は `validateCatClaims` が行う。`verify` は label 設定を受け取って別の設定で再解釈する経路を持たない。
- 負の label は `cborInteger` の major type 1 で表現する。-65537 / -65538 が CBOR で `3a00010000` / `3a00010001` になること、CBOR のバイト列を経由しても claims が一致することをテストで固定した。
- 327 / 328 は preset では `moqt` / `moqt-reval` として解釈せず raw に残す (既存テストを維持)。`claimLabels` に明示した場合だけその値を使う。
- `src/msf/c4mAuthorization.ts` の外部トークンを復号せずに運ぶ経路は変更していない。
- テストと devtools は `C4M_DRAFT_02_EXAMPLE_CLAIM_LABELS` を明示して使うよう更新した。
- README / `docs/LOW_LEVEL_API.md` に、両 claim の key が IANA 未割当であること、相互接続では peer と事前に合意した暫定値を明示すること、preset は検証用であること、拒否条件を記載した。
- 追加テストは、Private Use label の CBOR 表現と往復、全入口と builder への設定の伝搬、未指定・不正型・範囲外・衝突の拒否、設定のコピー、設定違いによる解釈の区別、設定した label を raw に置いた場合の二重指定拒否、任意の label 設定に対する PBT である。`@ts-expect-error` を付けた必須引数なしの呼び出しは、tsconfig がテストを除外しているためコンパイル時には検証されず、実行時に `invalidClaimLabels` で拒否されることだけを固定している。
- `vp check` / `vp exec tsc --noEmit` / `vp test run` (272 ファイル / 4909 テスト) / `vp run build` / `vp run build:devtools` が通る。

### 既知の制限

- claim label を設定する UI は devtools に無く、devtools は付録 A の preset を固定で使う。
- 実リレー E2E は未実施である。
- C4M 02 の COSE バイナリ形式のテストベクタ全体の更新は 0920 で扱う。
