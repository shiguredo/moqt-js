# MSF を draft-02 に追従する (追跡 issue)

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

`refs/moq/draft-ietf-moq-msf-02.txt` (2026 年 11 月発行) に MSF 実装を追従させる。現行実装は draft-01 に準拠しており、draft-02 の catalog を 1 件も受理できない。差分の全体像は `docs/investigations/msf-draft-02-diff/README.md` に整理した。

draft-01 との互換性は維持しない。catalog の `version` は `"draft-02"` のみを受理し、`"draft-01"` と `"1"` は拒否する。draft-01 の wire 表現を受理する移行措置は入れない。

本 issue は追跡用である。実装は下の「対応項目」の各 issue で行い、すべて完了したら本 issue を closed にする。

## 現状

- `MSF_VERSION` は `"draft-01"` を返し、decode は `"draft-01"` と `"1"` だけを受理する (`src/msf/version.ts`、`src/msf/catalogValidation.ts`)
- delta update は `add` / `remove` / `clone` のみを扱い、`update` operation と `generatedAt` 必須化に対応していない (`src/msf/catalogCodec.ts`、`src/msf/catalogDelta.ts`)
- track フィールドの条件付き MUST が draft-01 のままである (`src/msf/catalogTrackValidation.ts`)
- `depends` が `string[]` 固定で renderGroup 参照を受け付けない (`src/msf/types.ts`)
- Event Timeline の index key が小文字 `t` / `l` / `m` のままである (`src/msf/timeline.ts`)
- catalog の `namespace` を `/` 区切りの文字列として検証せず、購読にも使っていない (`src/msf/catalogTrackValidation.ts`、`src/createMediaSubscriber.ts`)
- 予約 fragment パラメータが `c4m` のままで、`cat` を受け付けない (`src/msf/c4m.ts`)
- `MSF_COMPRESSION` (0x78)、`MSF_EVENT_TIMELINE_HEADER` (0x7B)、`packagingMetadata`、`accessibleWindowTime`、`keyframeSpacing` が未実装である
- 実測した差分は 53 件 (P0 12 件、P1 26 件、P2 15 件)。再現スクリプトは `docs/investigations/msf-draft-02-diff/verify.mjs`

## 対応項目

draft-02 固有の作業を issue 化した。既存 issue で扱えるものは既存 issue を draft-02 の内容に更新して対応する。

| issue | 目的                                                                       | 主な差分 ID                  |
| ----- | -------------------------------------------------------------------------- | ---------------------------- |
| 0969  | catalog の version と delta update の骨格を draft-02 にする                | D-01, D-02, D-03, D-13, D-14 |
| 0970  | `depends` の renderGroup 参照と timeline の catalog 要件を draft-02 にする | D-04, D-05, D-06, D-51       |
| 0971  | Event Timeline の index key を大文字にし、header property を実装する       | D-07, D-30                   |
| 0972  | catalog の namespace を `/` 区切りにし、名前マッピングを実装する           | D-09, D-19                   |
| 0973  | `connectionURI` へ改名し、track-level の `token` を削除する                | D-08, D-27                   |
| 0974  | 変数置換の文字制約を draft-02 に合わせる                                   | D-11                         |
| 0975  | 予約 fragment パラメータを `cat` にする                                    | D-10                         |
| 0976  | `packagingMetadata` と `streamMapping` を実装し、`object` モードを受信する | D-20, D-21                   |
| 0977  | `keyframeSpacing` と multi-variant の publisher packaging を実装する       | D-22, D-23                   |
| 0978  | Multi-Variant Fast Track Switching を実装する                              | D-24                         |
| 0979  | `accessibleWindowTime` を実装する                                          | D-25                         |
| 0980  | log / metrics の catalog namespace を `/` 区切りにする                     | D-31                         |
| 0981  | catalog を参照する catalog と catalog object の規則を実装する              | D-15, D-16, D-42             |
| 0982  | docs とコメントの draft-02 参照と節番号を更新する                          | D-39, D-40, D-41             |

既存 issue で対応するもの:

| 既存 issue                   | draft-02 での扱い                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0355 (pending)               | `MSF_COMPRESSION` の Property ID が 0x78 に確定したため、未割当を理由にした保留は解消した。draft-02 の §12.1 に合わせて reopened にする (D-12) |
| 0354 (pending)               | 暗号化の実装。draft-02 で `cipherSuite` の必須条件が `moq-secure-objects` のときに限定された点だけ追記する (D-26)                              |
| 0865                         | catalog 取得の fill fetch 化。draft-02 §5 でも MUST の文面は変わらない (D-33)                                                                  |
| 0864                         | `PRIOR_GROUP_ID_GAP` の送出。draft-02 §6.1 で Extension header から property に用語が変わった (D-34)                                           |
| 0850                         | `moqlog` / `moqmetrics` の配置検証。draft-02 でも §9.4 / §10.4 の MUST は維持されている (D-38)                                                 |
| 0853, 0854, 0855, 0856, 0857 | 変数置換の配線と再検証。draft-02 §13.5 で置換後の検証が MUST になった (D-18)                                                                   |
| 0703                         | `c4m` から取り込んだ CAT の相互接続試験。パラメータ名が `cat` に変わるため前提を更新する (D-10)                                                |

## 完了条件

- 上表の 13 issue が closed になっている
- 既存 issue のうち本追従で扱うものの前提が draft-02 に更新されている
- `docs/investigations/msf-draft-02-diff/verify.mjs` の 21 ケースがすべて draft-02 の期待と一致する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
- `docs/MSF.md`、`docs/IMPLEMENTATION_STATUS.md`、`README.md` の対応版が draft-02 になっている

## 解決方法

{各 issue の完了後に追記する}
