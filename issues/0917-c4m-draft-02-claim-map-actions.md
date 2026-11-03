# C4M 02 の moqt claim を map にし SETUP と SUBSCRIBE_TRACKS を反映する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-c4m-claim-map-actions
- Polished: {YYYY-MM-DD}

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

{未着手}
