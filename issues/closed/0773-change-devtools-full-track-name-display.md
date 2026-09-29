# moqt-devtools の track 表示を Full Track Name に整理し、ステータスを接続状態にする

- Created: 2026-09-29
- Completed: 2026-09-29
- Branch: feature/change-devtools-full-track-name-display
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools は直近の対応で `Publishing:` / `Subscribed:` のステータスメッセージに Full Track Name (draft-ietf-moq-transport-21 §8.8 の形式) を出すようになったが、表示の役割が整理できていない。

- ステータスメッセージにトラックの一覧と接続の段階が混ざっている。トラックの一覧は Catalog パネルで確認できるため、ステータスは接続の段階 (`Connecting...` / `Publishing` / `Subscribed` / `Disconnected` など) を示す場所にする
- Catalog パネルはトラックを種別ごとに分けずに並べ、namespace も出していない。メディアとデータを分け、各トラックを Full Track Name で特定できるようにする
- Catalog パネルが映像の下にあり、トラックの一覧を確認するには映像までスクロールする必要がある。パネルの並びを Catalog → Audio → Video → Messages → Statistics にして、Catalog を映像の上に出す
- DebugPanel のログ行には track の情報が出ず、展開した Data でも `Track Namespace: [room, 123]` と `Track Name: video` に分かれている。catalog の OBJECT ログは `(catalog)` だけで namespace が無い

根拠:

- 利用者からの報告: ステータスのトラック一覧は Catalog パネルと重複し、ステータスには接続状態を出してほしい。Catalog 情報は Catalog パネルを整備して見やすくする
- draft-ietf-moq-transport-21 §8.8 (Representing Namespace and Track Names) は、ログ等のために namespace のフィールドを `-` で並べ、track name を `--` でつなぎ、`[A-Za-z0-9_]` 以外のバイトを `.` + 小文字 16 進 2 桁でエスケープする形式を RECOMMENDED とする
- draft-ietf-moq-msf-01 §5.2.4 (Table 3): `loc` はメディアを運ぶパッケージングで、`mediatimeline` / `eventtimeline` / `moqlog` / `moqmetrics` はデータを運ぶ

## 現状

- `devtools/src/utils/trackStatusMessage.ts` の `buildMediaTrackStatusMessage` は、audio / video の Full Track Name を `Publishing: room-123--audio, room-123--video` の 1 行にまとめ、`usePublisher.ts` の `startPublishing` と `useSubscriber.ts` の各箇所がステータスメッセージに設定する。接続の段階を示すメッセージとトラックの一覧が同じ欄に混ざっている
- `devtools/src/components/CatalogTracks.tsx` は catalog の Track を種別で分けずに並べ、`name` だけで namespace を出さない
- `devtools/src/hooks/debugMessageLog.ts` の `logDebugMessage` は行を `[publisher] [SEND] PUBLISH` の形式で作る。decoded の `trackNamespace` / `trackName` は展開した Data にだけ出る
- `devtools/src/utils/logFormatters.ts` の `formatMessageData` は、`trackNamespace` (string[]) を `Track Namespace: [room, 123]`、`trackName` を `Track Name: video` と生の形で出す
- catalog の OBJECT ログは `usePublisher.ts` と `useSubscriber.ts` が `(${CATALOG_TRACK_NAME})` をメッセージ文字列へ直書きしていて、namespace が無い
- `src/fullTrackName.ts` の `formatFullTrackName` は Track Namespace と Track Name の組だけを扱い、namespace 単体の表記を持たない

## 設計方針

- ステータスメッセージは接続の段階だけを示す。`usePublisher.ts` / `useSubscriber.ts` からトラックの一覧を外し、確立後は `Publishing` / `Subscribed` にする。`buildMediaTrackStatusMessage` とそのテストは削除する
- Catalog パネル (`CatalogTracks`) はトラックを media (`packaging: "loc"`) と data (それ以外) に分けて見出しを付け、各行の先頭に Full Track Name を出す。track の `namespace` (§5.2.2) があるときはそちらを使う
- パネルの並びを Catalog → Audio → Video → Messages → Statistics にし、Catalog を映像の上に出す。Publisher と Subscriber で同じ並びにする (`panelLayout.ts` の配置のコメントも更新する)
- DebugPanel のログ行は、decoded に `trackNamespace` (string[]) と `trackName` (string) が揃っているメッセージに行末の Full Track Name を付ける。catalog の OBJECT ログは呼び出し側で `formatFullTrackName(namespace, CATALOG_TRACK_NAME)` を使う
- `formatMessageData` は、`trackNamespace` + `trackName` の組を `Full Track Name: room-123--video` の 1 行にまとめる。namespace 単体と `trackNamespacePrefix` は §8.8 の namespace 表記にする。組み立てに失敗する (空の namespace フィールド等) ときは生の値のままにする (表示を壊さない)
- `src/fullTrackName.ts` に namespace 単体の表記を組み立てる関数 (`formatTrackNamespace`) を足す。各フィールドを §8.8 の規則でエスケープし `-` で並べる。`formatFullTrackName` はこの関数を使って組み立てる

## 完了条件

- publisher / subscriber のステータスが接続の段階だけを示し、トラックの一覧を出さない (`Publishing` / `Subscribed`)
- Catalog パネルが Media / Data の 2 グループで並び、各トラックの行の先頭に Full Track Name が出る
- パネルの並びが Catalog → Audio → Video → Messages → Statistics になり、Catalog が映像の上に出る (Publisher / Subscriber で揃う)
- DebugPanel で、track を持つメッセージ (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS / PUBLISH_NAMESPACE など) の行に Full Track Name が出る
- 展開した Data の `Track Namespace` / `Track Name` が `Full Track Name` 1 行にまとまる。catalog の OBJECT ログにも Full Track Name が出る
- `formatTrackNamespace` と `formatMessageData` のテストが通り、`vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- ステータスメッセージのトラック一覧をやめ、接続の段階だけを示すようにした。`devtools/src/utils/trackStatusMessage.ts` とそのテストを削除し、`usePublisher.ts` は確立後に `Publishing`、`useSubscriber.ts` は `Subscribed` を設定する。ステータス欄は 1 行のまま (`truncate`、全文は `title`)
- `CatalogTracks` を書き換え、トラックを Media (`packaging: "loc"`) と Data (それ以外) に分けて見出しを付け、各行の先頭に `formatFullTrackName` の Full Track Name を出した。track name 単体は Full Track Name に含まれるため出さない。track の `namespace` (§5.2.2) があるときはそちらを使う
- パネルの並びを Catalog → Audio → Video → Messages → Statistics にし、Catalog を映像の上に出した。`panelLayout.ts` の配置のコメントも新しい並びに更新した
- `devtools/src/utils/logFormatters.ts` に `formatTrackNameSuffix` を追加し、`logDebugMessage` は decoded に trackNamespace (string[]) と trackName があるメッセージの行末に Full Track Name を付けるようにした
- `formatMessageData` は trackNamespace + trackName を `Full Track Name` の 1 行にまとめ、namespace 単体と trackNamespacePrefix は `-` 区切りの表記にした。§8.8 の表記にできない値 (バイト列や空の Track Namespace Field) と空の namespace は生の値のまま出す
- catalog の OBJECT ログ (`usePublisher.ts` の送信 3 か所 / `useSubscriber.ts` の受信 1 か所) は `formatFullTrackName(namespace, CATALOG_TRACK_NAME)` を使うようにした
- `src/fullTrackName.ts` に `formatTrackNamespace(trackNamespace)` を追加し、`formatFullTrackName` はこれを使って組み立てるようにした。namespace 単体をログ等へ出すときに使う (§8.8 のエスケープ規則は同じ)
- `signals/connectionSettings.ts` に `namespaceArray` (namespace 設定を `/` で分解した computed) を追加し、接続処理と画面表示 (Full Track Name の組み立て) が同じ分解を使うようにした
- テスト: `src/fullTrackName.test.ts` に `formatTrackNamespace` の単体テスト、`src/fullTrackName.prop.ts` に `parseMsfFragmentValue` との round-trip を追加した。`devtools/src/utils/logFormatters.test.ts` に Full Track Name の 1 行化と `formatTrackNameSuffix`、`devtools/src/hooks/debugMessageLog.test.ts` に行末の Full Track Name のテストを追加した。`devtools/src/signals/snapshotCoverage.test.ts` の除外表に `namespaceArray` を足した
