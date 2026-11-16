# docs とコメントの draft-02 参照と節番号を更新する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 で節番号が全体的に 1 つ繰り下がり、`draft-ietf-moq-msf-01` を引く記述がリポジトリに大量に残っている。`refs/moq/draft-ietf-moq-msf-01.txt` は削除済みのため、docs のリンクも壊れている。仕様の引用が誤った節を指すと、実装の根拠を追えなくなる。

## 現状

- `src/` と `devtools/src/` で `draft-ietf-moq-msf-01` を引く行が 375 行ある (テストを含む)。リポジトリ全体では issues を除いて 418 行、187 ファイル
- `docs/MSF.md` の正本リンクが `refs/moq/draft-ietf-moq-msf-01.txt` を指しており、存在しないファイルへの相対リンクになっている。公開版のリンクも `-01` のままである
- `docs/IMPLEMENTATION_STATUS.md` の MSF 節が draft-01 の実装状況として書かれている
- `docs/HIGH_LEVEL_API.md`、`docs/MEDIA_PLAYOUT.md`、`docs/PLAYOUT.md`、`docs/PLAYOUT_DELAY.md`、`docs/ARCHITECTURE.md` が `targetLatency` や `renderGroup` を draft-01 の節番号で引いている
- `docs/proposals/FETCH_GAP_RECOVERY.md` と `docs/proposals/AUDIO_FEC.md` が `refs/moq/draft-ietf-moq-msf-01.txt` を参照している
- `src/msf/tracks.ts` の JSDoc が、draft-01 にも draft-02 にも存在しない文を §6.1 の引用として書いている。また仕様が SHOULD とする箇所を MUST と書いている
- 節番号の対応は次にずれる。`eventType` は §5.2.5 から §5.2.6、`renderGroup` は §5.2.11 から §5.2.12、`initRef` は §5.2.13 から §5.2.14、`depends` は §5.2.14 から §5.2.15、`template` は §5.2.15 から §5.2.16、`targetLatency` は §5.2.8 から §5.2.9、`buffers` は §5.2.9 から §5.2.10、`trackDuration` は §5.2.35 から §5.2.36、認可の提示は §11.4.3 から §11.5.3、生放送の終了は §11.3 から §11.4
- `targetLatency` の定義が「符号化後」から「エンコーダーに入った時刻」に変わった。実装の時刻源は新しい定義と一致しているが、docs とコメントの文言が古い

## 設計方針

- `draft-ietf-moq-msf-01` を `draft-ietf-moq-msf-02` に置き換える。ファイルパスの参照は `refs/moq/draft-ietf-moq-msf-02.txt` にする
- 節番号の引用を上記の対応表に従って直す。一括置換ではなく、1 箇所ずつ節の内容と突き合わせる。番号だけを機械的に +1 すると、節の再編で対応しない箇所 (認可と生放送の終了など) を誤る
- `src/msf/tracks.ts` の、仕様に存在しない引用と MUST / SHOULD の取り違えを直す。引用は仕様の文面に合わせる
- `targetLatency` の説明を「エンコーダーに入った時刻から表示までの wallclock の差」に統一する。`src/codec/types.ts`、`src/playout/timeline.ts`、`src/mediaSubscriber/catalogSubscription.ts`、`src/msf/tracks.ts`、docs の該当箇所を揃える
- `docs/MSF.md` の正本リンクと公開版リンクを `-02` にする
- `docs/IMPLEMENTATION_STATUS.md` の MSF 節を draft-02 の対応状況として書き直す。本追従で未実装のまま残る項目 (`object` モード、multi-variant の切替、暗号化、log / metrics の payload 契約) を未対応として明記する
- `README.md` の対応版を draft-02 にする
- 節番号の一括更新は、コードのコメントと docs で 1 コミットにまとめる。仕様の解釈が変わる修正 (MUST / SHOULD の取り違え、存在しない引用) は別コミットにする

## 完了条件

- `rg "draft-ietf-moq-msf-01"` の結果が 0 件になる (issues を除く)
- `refs/moq/draft-ietf-moq-msf-01.txt` へのリンクが残っていない
- 節番号の引用が draft-02 の実際の節と一致する。少なくとも §5.2 の番号、§11.4 / §11.5、§12、§14 について全件を突き合わせる
- `src/msf/tracks.ts` の引用が仕様の文面と一致し、MUST / SHOULD の区別が正しい
- `README.md`、`docs/MSF.md`、`docs/IMPLEMENTATION_STATUS.md` の対応版が draft-02 である
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/`、`devtools/src/`、`tests/` の `draft-ietf-moq-msf-01` への参照を `draft-ietf-moq-msf-02` に置き換えた (89 ファイル)
- draft-01 を明示するコメントブロック内の `§5.2.5`〜`§5.2.36` を 1 つ繰り下げた。draft-02 で `Packaging metadata` が §5.2.5 に入り、`Token` (§5.2.37) が廃止されたためである
- msf の `§11.4.x` を `§11.5.x` に置き換えた (27 ファイル)
- draft 名を持たない 1 行コメントの節番号は機械的に判別できないため、一次資料との全数監査を別 issue に切り出した。実装済みフィールドの番号は draft-02 の値で書かれている
- docs/investigations/msf-draft-02-diff/ の調査資料は draft-01 との差分を論じる文書であり、対応する draft-01 の記述への言及を残した
