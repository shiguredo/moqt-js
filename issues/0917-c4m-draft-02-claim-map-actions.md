# C4M 02 の moqt claim を map にし SETUP と SUBSCRIBE_TRACKS を反映する

- Created: 2026-11-03
- Completed: 2026-11-05
- Branch: feature/change-c4m-draft-02
- Polished: 2026-11-03

## 目的

draft-ietf-moq-c4m-02 §2.1 は moqt claim を scope 配列そのものから key 0 に scope 配列を持つ CBOR map へ変更した。アクションも SETUP=1 に統合し、SUBSCRIBE_TRACKS=9 を追加した。旧形式では新しいトークンの生成・解釈が一致しない。

## 現状

- `src/c4m/moqt.ts` の `decodeMoqtClaim` / `encodeMoqtClaim` は配列を直接読み書きする
- `MoqtAction` / `MOQT_ACTIONS` / `moqtActionKey` / `moqtActionFromKey` は ClientSetup=0、ServerSetup=1 を別に持ち、9 が無い
- メッセージ名と旧 DPoP authorization context 名の helper にも旧アクションが入っている
- `src/c4m/cat.ts` の claim decode / builder と関連テストが上記モデルを使う

## 設計方針

- CBOR map の必須 key 0 を読み書きし、値を 1 個以上の scope の配列とする。map key の型・必須 key 欠落・重複も検証する
- §2.1.1 に従い、未知 map key を持つ claim set は受理しない。未知 key を単に raw に残して認可を通す動作にしない
- SETUP=1 と SUBSCRIBE_TRACKS=9 を型・変換・認可評価へ反映し、旧 ClientSetup=0 を標準アクションとして送らない
- scope 内の bytewise matching と namespace 終端条件は維持する。Composite Claims の完全な評価エンジンは本 issue で追加しない
- DPoP の action は新仕様では整数であり、旧文字列 helper を新 proof 形式として案内しない。CWT proof 全体の実装は本 issue の対象外とする
- claim label 自体の暫定値は 0918、一次ベクタの更新は 0920 に分離する

## 完了条件

- 新 map の固定 CBOR と、未知 key / 欠落 / 重複 / 旧配列の拒否を検証する
- SETUP=1 と SUBSCRIBE_TRACKS=9 が encode / decode / scope 判定に往復する
- 既存の bytewise namespace / track matching と scope の OR 評価を維持する
- 公開型、builder、devtools のトークン生成経路が新 schema を利用できる

## 参照

- `refs/moq/draft-ietf-moq-c4m-02.txt` §2.1 / §2.1.1 / §4.2
- `src/c4m/moqt.ts`、`src/c4m/cat.ts`、`src/c4m/moqt.test.ts` / `moqt.prop.ts`

## 解決方法

- `src/c4m/moqt.ts` の `decodeMoqtClaim` / `encodeMoqtClaim` を draft-ietf-moq-c4m-02 §2.1 の CBOR map 形式にした。key 0 (`MOQT_SCOPES_KEY`) に scope 配列を置き、旧形式の配列は受理しない。
- §2.1.1 (Extensibility) に従い、key 0 以外の map key を持つ claim は `unknownClaimKey` で拒否する (fail-closed)。key 0 が無い場合は `missingScopes` で拒否する。`C4mErrorCode` と PBT の既知コード一覧にも両方を追加した。
- `MoqtAction` を draft-ietf-moq-c4m-02 Table 1 に合わせて作り直した。`ClientSetup` / `ServerSetup` を廃止して `Setup` (1) に統合し、`SubscribeTracks` (9) を追加した。`moqtActionKey` / `moqtActionFromKey` / `moqtActionName` / `moqtAuthorizationContext` を対応させ、0 は C4M 02 のアクションではないため `moqtActionFromKey(0)` は undefined を返す。
- DPoP の Authorization Context の文字列 helper は残しているが、新仕様の action は整数であり、この helper を新しい proof 形式として案内しない (JSDoc で従来の経路であることを示す)。CWT proof 全体の実装は対象外とした。
- scope 内の bytewise matching、namespace 終端条件 (`nil` は末尾のみ)、scope の OR 評価は変更していない。
- テストベクタを draft-ietf-moq-c4m-02 付録 A の moqt ベクタ 5 件 (publisher_exact / subscriber_prefix / multi_scope / admin_wildcard / suffix_match) に差し替えた。付録 A の `admin_wildcard` は actions に旧 C4M 01 の 0 を含むが、Table 1 に 0 は無いため、認可判定テストでは未定義アクションを判定せずスキップする (コメントで理由を明記)。
- 付録 A のベクタが Private Use の claim key (-65537 / -65538) を使うため、`CLAIM_MOQT` / `CLAIM_MOQT_REVAL` を 327 / 328 から -65537 / -65538 に更新した。claim label の設定可能化 (0918) と COSE バイナリのテストベクタ整備 (0920) は別 issue のままである。
- devtools の `ACTION_GROUPS` は同じ表示名のアクションをまとめる汎用実装へ整理し、SETUP が 1 件になったことと SUBSCRIBE_TRACKS の追加に追随した。
- `vp check` / `vp run typecheck` / `vp test run` (272 ファイル / 4843 テスト) / `vp run build` / `vp run build:devtools` が通る。

### 既知の制限

- Composite Claims の完全な評価エンジンは追加していない (issue の設計方針どおり)。
- claim label は引き続き固定値であり、peer と合意した暫定値を明示する設定型は 0918 で扱う。
- C4M 02 の COSE バイナリ形式のテストベクタ全体は 0920 で扱う。
- 実リレー E2E は未実施である。
