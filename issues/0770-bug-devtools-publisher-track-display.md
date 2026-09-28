# moqt-devtools の publisher の Publishing 表示が音声トラックを出さず、Full Track Name の表記も仕様の形式でない

- Created: 2026-09-29
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-track-status-display
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の publisher の `Publishing:` ステータス表示は、映像と音声を配信していても映像トラックの名前しか出さず、配信中に何を送っているのかを伝えられない。また、namespace と track name を `/` で連結しているため、表示からは namespace のフィールド境界と track name の境界が読めない。確立したメディアトラックをすべて、MOQT が推奨する Full Track Name の表記で出すようにする。

根拠:

- 利用者からの報告: 映像 + 音声の配信で `Publishing: shiguredo/vvv/video` とだけ表示され、音声トラックが出ない
- draft-ietf-moq-transport-21 §8.8 (Representing Namespace and Track Names) は、ログ等のために namespace のフィールドを `-` で並べ、track name を `--` でつなぎ、`[A-Za-z0-9_]` 以外のバイトを `.` + 小文字 16 進 2 桁でエスケープする形式を RECOMMENDED とする。仕様の例は `customer-livestream-123--catalog`
- draft-ietf-moq-msf-01 §11.1.2 は同じ形式を MSF fragment の namespace-name 文字列として使う

## 現状

- `devtools/src/hooks/usePublisher.ts` の `startVideoPublishing` が `Publishing: ${namespaceArray.join("/")}/${options.trackName}` を `pub.pubStatusMessage` に設定する。`startAudioPublishing` は音声トラックの PUBLISH が確立しても `pub.pubStatusMessage` を更新しない。`startPublishing` は映像を配信しないとき (`videoInput === null`) に限り、`Publishing: .../${audioTrackNameValue}` で上書きする
- このため映像 + 音声の配信では音声トラックの名前が出ない。音声トラックが実際に配信されているかは Catalog パネルを見ないと分からない
- `/` は namespace 設定 (`devtools/src/signals/connectionSettings.ts` の `namespace`。`"room/123"` を `/` で split して `["room","123"]` にする) の区切りと同じである。`src/fullTrackName.ts` の `fullTrackNameKey` の doc コメントも、`/` 連結では namespace `["a"]` + track name `"b/c"` と namespace `["a","b"]` + track name `"c"` が同じ文字列 `"a/b/c"` になることを認めている
- `src/msf/fragment.ts` の `parseMsfFragmentValue` は §8.8 / §11.1.2 の namespace-name 文字列を parse できるが、逆に組み立てる関数は無い

## 設計方針

- `src/fullTrackName.ts` に `formatFullTrackName(trackNamespace, trackName)` を追加する。§8.8 / §11.1.2 の形式 (namespace の各フィールドを `-`、track name を `--` でつなぎ、`[A-Za-z0-9_]` 以外の UTF-8 バイトを `.` + 小文字 16 進 2 桁にする) で組み立てる。仕様の節番号をコメントに書く。`parseMsfFragmentValue` と round-trip することをテストで確かめる
- 空の Track Namespace Field は区切り (ハイフン) と区別できないため Error で拒否する (draft-ietf-moq-transport-21 §8.7 が 1 バイト以上を MUST とする)。Track Name は §8.7 が空を許すため描画する
- `devtools/src/utils/` に、確立したメディアトラック (`{ audio?: string; video?: string }`) とラベル (`"Publishing"`) から `<label>: <audio>, <video>` を作る純関数を追加する。並びは audio → video で、Catalog と Tracks カードの並びに揃える
- `startPublishing` は、映像 / 音声の PUBLISH が確立した後に、確立したメディアトラックの Full Track Name を並べた `Publishing: ...` を設定する。`startVideoPublishing` / `startAudioPublishing` から `pub.pubStatusMessage` への書き込みを外す
- event timeline は publish に失敗しても警告に留めて配信を続けるデータトラックのため、`Publishing:` には含めない (Catalog パネルに全トラックが出る)

## 完了条件

- 映像 + 音声の配信で、ステータスが `Publishing: room-123--audio, room-123--video` のように audio と video の両方の Full Track Name を示す
- 映像のみ、音声のみの配信でも同じ形式で出る
- `formatFullTrackName` の単体テストと、`parseMsfFragmentValue` との round-trip の PBT が通る
- ステータスメッセージを組み立てる純関数の単体テストが通る
- `vp check` / `tsc --noEmit` / `vp test run` が通る
