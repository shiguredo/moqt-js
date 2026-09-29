# moqt-devtools の track 表示を Full Track Name に整理し、catalog と events も出す

- Created: 2026-09-29
- Completed: {YYYY-MM-DD}
- Branch: feature/change-devtools-full-track-name-display
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools は直近の対応で `Publishing:` / `Subscribed:` のステータスメッセージに Full Track Name (draft-ietf-moq-transport-21 §8.8 の形式) を出すようになったが、表示が 3 か所で揃っていない。

- ステータスメッセージは audio / video だけで、catalog トラックと events トラックが確立しても出ない。配信中にどのトラックを出しているかをステータスから確認できない
- DebugPanel のログ行には track の情報が出ず、展開した Data でも `Track Namespace: [room, 123]` と `Track Name: video` に分かれている。catalog の OBJECT ログは `(catalog)` だけで namespace が無い
- Catalog パネルの各トラックは `name` だけで namespace が無い

devtools 全体で Full Track Name の表記に揃え、どの表示からもトラックを特定できるようにする。

根拠:

- 利用者からの報告: ステータスには audio / video しか出ず、message (events) と catalog の track name / namespace が見えない
- draft-ietf-moq-transport-21 §8.8 (Representing Namespace and Track Names) は、ログ等のために namespace のフィールドを `-` で並べ、track name を `--` でつなぎ、`[A-Za-z0-9_]` 以外のバイトを `.` + 小文字 16 進 2 桁でエスケープする形式を RECOMMENDED とする

## 現状

- `devtools/src/utils/trackStatusMessage.ts` の `buildMediaTrackStatusMessage` は、audio / video の 2 トラックだけを `Publishing: room-123--audio, room-123--video` の 1 行で組み立てる
- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は、catalog トラック (`CATALOG_TRACK_NAME`) と events トラック (`EVENT_TRACK_NAME`) を確立してもステータスメッセージに含めない。`useSubscriber.ts` の `Subscribed:` を設定する各箇所も audio / video だけを渡す
- ステータスメッセージは `PublisherPanel.tsx` / `SubscriberPanel.tsx` の `truncate` の 1 行 div で描き、全文は `title` に持つ (折り返すと下の映像の位置が動くため)
- `devtools/src/hooks/debugMessageLog.ts` の `logDebugMessage` は行を `[publisher] [SEND] PUBLISH` の形式で作る。decoded の `trackNamespace` / `trackName` は展開した Data にだけ出る
- `devtools/src/utils/logFormatters.ts` の `formatMessageData` は、`trackNamespace` (string[]) を `Track Namespace: [room, 123]`、`trackName` を `Track Name: video` と生の形で出す
- catalog の OBJECT ログは `usePublisher.ts` と `useSubscriber.ts` が `(${CATALOG_TRACK_NAME})` をメッセージ文字列へ直書きしていて、namespace が無い
- `devtools/src/components/CatalogTracks.tsx` は catalog の Track のキーと値だけを並べ、namespace を出さない
- `src/fullTrackName.ts` の `formatFullTrackName` は Track Namespace と Track Name の組だけを扱い、namespace 単体の表記を持たない

## 設計方針

- ステータスメッセージを 2 行にする。1 行目はメディアトラック (`Publishing: room-123--audio, room-123--video`)、2 行目はデータトラック (`Data: room-123--catalog, room-123--events`) とする
  - 確立したトラックだけを並べ、トラックが 1 つも無い行は出さない
  - publisher は catalog → audio / video → events の確立順に合わせ、catalog が確立したらデータ行に catalog を、events が確立したら events を足す。events の publish は失敗しても警告に留める経路のため、確立できたときだけ含める
  - subscriber も同じ規則にし、catalog の購読 (SUBSCRIBE / FETCH) と events の購読の成立を反映する
  - 各トラックの確立時にその時点の確立済みトラックから組み立て直し、確立順に依存した焼き込みをしない
- ステータス欄は 2 行を描けるようにし、行ごとに truncate、全文は `title` に持つ。2 行分の高さを常に確保し、行数で下の映像の位置が動かないようにする (Publisher / Subscriber で揃える)
- `src/fullTrackName.ts` に namespace 単体の表記を組み立てる関数 (`formatTrackNamespace`) を足す。各フィールドを §8.8 の規則でエスケープし `-` で並べる。`formatFullTrackName` はこの関数を使って組み立てる
- DebugPanel のログ行は、decoded に `trackNamespace` (string[]) と `trackName` (string) が揃っているメッセージに行末の Full Track Name を付ける。catalog の OBJECT ログは呼び出し側で `formatFullTrackName(namespace, CATALOG_TRACK_NAME)` を使う
- `formatMessageData` は、`trackNamespace` + `trackName` の組を `Full Track Name: room-123--video` の 1 行にまとめる。namespace 単体と `trackNamespacePrefix` は §8.8 の namespace 表記にする。組み立てに失敗する (空の namespace フィールド等) ときは生の値のままにする (表示を壊さない)
- `CatalogTracks` に track namespace を渡し、各トラックの行に Full Track Name (例: `room-123--video`) を出す。catalog の Track はすべて同じ namespace に属する

## 完了条件

- publisher の `Publishing:` が 2 行になり、1 行目に確立した audio / video、2 行目に catalog と (確立できていれば) events の Full Track Name が出る
- subscriber の `Subscribed:` も同じ規則で出る
- DebugPanel で、track を持つメッセージ (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE など) の行に Full Track Name が出る
- 展開した Data の `Track Namespace` / `Track Name` が `Full Track Name` 1 行にまとまる。catalog の OBJECT ログにも Full Track Name が出る
- Catalog パネルの各トラックの行に Full Track Name が出る
- `buildMediaTrackStatusMessage` と `formatMessageData` のテストが通り、`vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- {実装後に記載する}
