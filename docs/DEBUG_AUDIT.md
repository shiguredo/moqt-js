# moqt-devtools の debug 現状監査 (2026-10-18)

「moqt-devtools の debug を整備し直す」の着手前に、現在の実装を読んで把握した結果をまとめる。
コードは変更していない。debug 関連の単体テスト (9 ファイル 89 件) が通ることは確認した。
このメモの作成後、ブランチ `feature/add-devtools-debug-panel-usability` で UI の整備を
開始した。対応内容は末尾の「10. このブランチで行った整備」を参照。

## 結論

- debug は 1 つの機能ではなく、3 系統の観測出力 (デバッグパネル、ブラウザ console、画面の status / 統計) に分かれている。整備の本体はこの分断の解消にある。
- デバッグパネル自体は 0764 / 0766 / 0765 で作り直されており、追記コスト・保持・認可トークンの扱いはかなり詰めてある。作り直すより、意味付け (種別・重要度・接続元) と入口の統一を足す方が効く。
- ライブラリの `ConnectCallbacks.debug` は「MOQT メッセージの記録」と「内部イベントの記録」を同じ型で流している。受信応答の `decoded` 欠落、`type: 0` の濫用、例外隔離の非対称があり、公開 API としての契約が固まっていない。
- 未解決の性能 issue は 0767 (表示中の行数に比例する追記コスト) の 1 件だけ。ただし「パネルを閉じている間も記録し続ける」「console にしか出ないエラーがある」は issue 化されていない。

## 調査対象

- ライブラリ側: `ConnectCallbacks.debug` / `DebugMessage` と `src/` 内の記録箇所
- devtools 側: ログの蓄積、デバッグパネル、Copy for LLM、表示状態、アプリ内イベントログ
- 関連する issue、テスト、ドキュメント

## 1. 全体構成

```
MOQT プロトコル (src/)
  send / recv の制御メッセージ ──┐
  内部イベント (エラー等) ────────┤
                                  ▼
                       ConnectCallbacks.debug(DebugMessage)
                                  │
devtools (hooks)
  usePublisher.debug: handleDebugMessage ──> logDebugMessage("[publisher]", msg)
  useSubscriber.debug: handleDebugMessage ──> logDebugMessage("[subscriber-N]", msg)
                                  │
                                  ▼
                     signals/debugLog.ts  addLog()
                     LogEntry のリングバッファ (MAX_LOGS = 1000)
                                  │
          ┌───────────────────────┼────────────────────────┐
          ▼                       ▼                        ▼
  DebugPanel / DebugLogList   Copy for LLM            Debug ボタンのバッジ
  (表示・展開・行コピー)      (debugExport)           (件数のみ)

別系統:
  アプリ内イベント (48 箇所の addLog) ──> 同じリングバッファへ直接
  エラー・デコード失敗など (47 箇所の console.*) ──> ブラウザ console のみ
```

デバッグパネルのログは「ライブラリが流す MOQT メッセージの記録」と「devtools が自分で `addLog` するアプリイベント」が同じバッファに混在する。前者は `[publisher] [SEND] SUBSCRIBE` のような行、後者は `[subscriber-1] video stream ended` のような行になる。

## 2. ライブラリ側

### 2.1 公開 API

- `ConnectCallbacks.debug?: (message: DebugMessage) => void` (`src/session/publicTypes.ts:104-115`)
- `DebugMessage` は `direction` / `type` / `typeName` / `payload` / `decoded?` / `timestamp` (`src/session/publicTypes.ts:79-99`)
- `moqt-js` の公開 API からは `DebugMessage` 型のみ公開される。`getMessageTypeName` は公開されず、devtools はソースを相対 import して使っている (`src/message/index.ts:19`、`devtools/src/hooks/debugMessageLog.ts:2`)

### 2.2 記録の生成

- 通常の送受信メッセージ: `sessionEmitDebug` (`src/session/lifecycle.ts:497-516`) が `DebugMessage` を組み立てる。`typeName` は `getMessageTypeName(type)` で決まる。
  - 送信: 12 箇所 (bidi / connection / publish の 9 箇所と namespace 送信の 3 箇所)
  - 受信: 15 箇所 (`emitDebug` 6 箇所と、エラー記録・namespace 受信などの直書き 9 箇所)
  - 合計 27 箇所
- 内部イベント: `type: 0`、`payload: new Uint8Array(0)`、`typeName` に自由文字列を入れて流す。9 種類ある。
  - `STREAM_LOOP_ERROR` / `DATAGRAM_LOOP_ERROR`
  - `DATA_STREAM_ERROR`
  - `DATAGRAM_DECODE_ERROR` / `DATAGRAM_CALLBACK_ERROR` / `SUBGROUP_CALLBACK_ERROR`
  - `REQUEST_CALLBACK_ERROR`
  - `FILL_CALLBACK_ERROR` / `FILL_ERROR_CALLBACK_ERROR`
- 内部イベントの生成は helper 2 つ (`sessionEmitCallbackErrorDebug` / `sessionEmitDataStreamErrorDebug`) と直書き 6 箇所に分かれている。
- ドキュメント `docs/LOW_LEVEL_API.md:555-560` は内部イベントを 4 種類しか挙げておらず、実装と一致していない。

### 2.3 `decoded` の有無

- 送信は主要リクエスト (SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / REQUEST_UPDATE など) で `decoded` が付く。
- 受信は初回 PUBLISH (`src/session/incomingPublish.ts:625-630`) や SETUP 応答には付くが、双方向ストリームの応答 (`REQUEST_OK` / `REQUEST_ERROR` / `SUBSCRIBE_OK` / `FETCH_OK` / `PUBLISH_DONE` など) は `session.emitDebug("recv", msg.type, msg.payload)` だけで `decoded` が無い (`src/session/bidi.ts:876` / `:2629`)。パネル上は種別名しか読めない。
- 内部イベントは `decoded.error` (と一部 `requestId`) だけを持つ。

### 2.4 例外の扱い

- debug コールバックの throw は経路によって扱いが違う。
  - 受信側・コールバックエラー記録: 内側の try/catch で握り潰す (`src/session/incoming.ts:375-389` など)。「観測がプロトコルを壊さない」方針。
  - 送信側: `sessionEmitDebug` 自体は try/catch を持たず、`connectionSendControlMessage` などではそのまま reject に伝播する。PUBLISH_DONE 送信だけは明示的に隔離している (`src/session/publish.ts:785-795`)。テストも「debug コールバックの throw で送信前失敗を起こす」挙動を前提にしている (`src/session.test.ts:9444` 周辺)。
- つまり「debug callback はアプリの観測用で、throw してもプロトコルを壊さない」という一貫した契約になっていない。

### 2.5 型の実態と契約

- `DebugMessage.type` は通常メッセージでは `MessageType` の値だが、内部イベントでは `0` (実在しない型) になる。消費側は `typeName` の文字列でしか内部イベントを判別できない。
- `DebugMessage.payload` の JSDoc は「内部バッファと独立」「コールバックを超えて保持してよい」「同一インスタンスが内部から参照されうる」と書かれており、独立と共有が同居している (`src/session/publicTypes.ts:86-94`)。devtools は契約を信用せず独立コピーしている (`devtools/src/hooks/debugMessageLog.ts:77-85`)。
- `decoded` は `Record<string, unknown>` で、メッセージ種別ごとの形は型で保証されない。devtools はキー名のヒューリスティックで整形している (`devtools/src/utils/logFormatters.ts` の `isParameter` など)。

## 3. devtools 側

### 3.1 取り込みと蓄積

- `logDebugMessage(prefix, message)` (`devtools/src/hooks/debugMessageLog.ts:61-87`)
  - `[prefix] [SEND|RECV] TYPE <Full Track Name>` の行を作る
  - `data` に `type` / `payloadSize` / `decoded` を平坦化して入れる
  - payload は認可トークンを載せうる 9 型ではコピーしない。4,096 バイト超もコピーしない
  - 重要度は常に `info`
- `addLog(level, message, data?, payload?)` (`devtools/src/signals/debugLog.ts:85-117`)
  - `LogEntry` は `id` / `timestamp` / `level` / `message` / `formattedTimestamp` / `formattedElapsed` / `formattedDelta` / `data?` / `payload?`
  - 時刻は追加時に 1 回だけ整形する
  - 上限 1,000 件。超過分は先頭から捨てる
  - 配列は signal にせず、`logSequence` の連番で追加・クリアを通知する
- アプリ内イベントは各 hook から直接 `addLog` する (48 箇所)。主なものは配信開始・停止、カタログ送受信、購読の確立・終了、前提警告、音声メーターの失敗など。

### 3.2 表示

- `DebugPanel` (`devtools/src/components/DebugPanel.tsx`): 開閉、件数、Auto Scroll、Expand All / Collapse All、Clear、Copy for LLM のボタン群。ログの連番を購読しないため、ログ追加では再描画されない。
- `DebugLogList` (`devtools/src/components/DebugLogList.tsx`): 連番を購読し、新しい順に並べる。行の vnode を連番でキャッシュし、追記時に作り直さない。上限で捨てた行は枝刈りする。
- `DebugLogRow` (`devtools/src/components/DebugLogRow.tsx`): 重要度の色、時刻・経過時間・差分、メッセージ、行コピー、展開時の Data / Binary タブ。
- `DebugLogCount` / `DebugLogBadge`: 件数だけを購読する小さなコンポーネント。
- 展開状態と表示モードは配列の添字ではなくログの連番で持つ (`devtools/src/utils/logRowState.ts`)。
- パネルの開閉状態は `devtools/src/signals/debug.ts`。URL の `debug=1` と連動する (`devtools/src/signals/connectionSettings.ts:886-888` / `:1343-1346`)。

### 3.3 Copy for LLM

- `devtools/src/signals/debugExport.ts` が現在の値を集め、`devtools/src/utils/debugExportText.ts` が純関数で整形する。
- 本文は `=== Connection Settings ===` / `=== Publisher Statistics ===` / `=== Subscriber Statistics (id) ===` / `=== Debug Logs ===` の節からなる。
- 設定と統計はスナップショットのキーから自動で出す (`devtools/src/signals/connectionSettingsSnapshot.ts` / `statsSnapshot.ts`)。ログは `message` の部分一致で接続ごとに絞る。
- 本文全体に `maskC4mValue` をかけ、c4m を `<redacted>` にする (`devtools/src/signals/debugExport.ts:38-47`)。認可トークンの値はスナップショットにも payload にも載せない。
- ログ 1 件のテキストは `formatLogEntryText` (`devtools/src/utils/debugExportText.ts:152-162`)。絶対時刻・重要度・本文・data を出す (経過時間は含まない)。

### 3.4 観測出力の分断

- デバッグパネル: 48 箇所の `addLog` とライブラリの debug callback
- console: 47 箇所の `console.error` / `console.warn` (主に `useSubscriber` 21、`usePublisher` 16、`DecoderWrapper` 5)。デコード失敗やセッションエラーなど、パネルに出ないものが多い。
- 画面: `statusMessage`、統計、前提警告 (`preconditionWarnings`)
- 同じ事象が複数の出力に別々に出ることもある (例: PUBLISH_DONE はライブラリの `[RECV] PUBLISH_DONE` とアプリの `video stream ended` の 2 行)。

## 4. 現在の設計意図 (経緯)

- 0167: ログ蓄積を signal のフルコピーから破壊的追記へ変え、autoScroll の再発火を直した。「パネル閉時のログ蓄積停止」は機能変更として先送りされたまま。
- 0175: `DebugMessage.payload` の寿命契約を JSDoc に書き、devtools 側は防御コピーする方針にした。
- 0596: アプリコールバックの throw を内部イベント (`REQUEST_CALLBACK_ERROR` など) として記録する方針にした。
- 0764: `DebugPanel` を分割し、ログ蓄積を signals、コピー整形を utils へ移した。設定・統計のスナップショットを作り、Copy for LLM の項目漏れを無くした。
- 0765: Copy for LLM の認可トークン漏れを塞いだ。payload の非保持と c4m の伏せ字。
- 0766: 行の vnode をキャッシュし、1 件追記で描画される行を 1 件にした。残るコストは 0767 へ。
- 0767 (open): 表示中の行数に比例する追記コスト。仮想化か表示件数制限かを決める必要がある。

## 5. 整備の論点

| #   | 論点                                                        | 根拠                                                                                                                                |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A   | 観測出力が 3 系統に分断されている                           | パネル 48 箇所 + console 47 箇所。デコード失敗やセッションエラーはパネルに出ない                                                    |
| B   | 内部イベントの表現が MOQT メッセージの型を濫用している      | `type: 0` / `direction: "recv"` 固定 / 空 payload / 自由文字列の typeName                                                           |
| C   | 受信応答の `decoded` が無く、パネルで詳細を読めない         | `src/session/bidi.ts:876` / `:2629` など                                                                                            |
| D   | debug callback の例外隔離が経路で非対称                     | 受信は握り潰し、送信は reject に伝播 (一部だけ隔離)                                                                                 |
| E   | payload のライフタイム契約が明確でない                      | `src/session/publicTypes.ts:86-94` の記述と実装が噛み合っていない                                                                   |
| F   | 重要度・種別・接続元が構造化されておらず、フィルタできない  | `LogEntry` は level と自由文字列だけ。UI はレベル絞り込み・検索・一時停止を持たない                                                 |
| G   | 記録が常時動く。閉じている間も payload をコピーして保持する | `debug` callback は開閉に関係なく登録される。0167 で先送りされた論点                                                                |
| H   | Copy for LLM のログ行に経過時間が無い。整形が 2 種類ある    | `formatLogEntryText` と `formatEntryLines` で表記が違う (重要度はブランチで追加)                                                    |
| I   | prefix の手書き規約が守られていない                         | `[publisher]` が付かない `NEW_GROUP_REQUEST received` (`devtools/src/hooks/usePublisher.ts:1406`) は Publisher のコピーに含まれない |
| J   | 秘密情報の防御が経路ごと                                    | Copy for LLM は c4m を伏せるが、行コピーは `maskC4mValue` を通さない                                                                |
| K   | 内部イベントの一覧がドキュメントと一致しない                | `docs/LOW_LEVEL_API.md:555-560` は 4 種類のみ                                                                                       |
| L   | 他の devtools と同じログ実装が並立している                  | `devtools/src/webtransport-devtools/messageLog.ts` (上限 200) と別実装                                                              |

## 6. 関連ファイル

| 層           | ファイル                                                          | 責務                                           |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------- |
| ライブラリ   | `src/session/publicTypes.ts`                                      | `DebugMessage` / `ConnectCallbacks.debug`      |
| ライブラリ   | `src/session/lifecycle.ts`                                        | 記録の組み立てと helper                        |
| ライブラリ   | `src/session.ts` / `src/session/*.ts`                             | emit 箇所 (約 27)                              |
| ライブラリ   | `src/message/debug.ts`                                            | `getMessageTypeName`                           |
| devtools     | `devtools/src/hooks/debugMessageLog.ts`                           | `DebugMessage` のログ化                        |
| devtools     | `devtools/src/signals/debugLog.ts`                                | リングバッファと `LogEntry`                    |
| devtools     | `devtools/src/signals/debug.ts`                                   | パネル開閉・autoScroll                         |
| devtools     | `devtools/src/signals/debugExport.ts`                             | Copy for LLM の値収集                          |
| devtools     | `devtools/src/utils/debugExportText.ts`                           | Copy for LLM の整形                            |
| devtools     | `devtools/src/utils/logFormatters.ts`                             | 表示用の整形 (共有)                            |
| devtools     | `devtools/src/utils/logRowState.ts`                               | 行の状態の枝刈り                               |
| devtools     | `devtools/src/components/DebugPanel.tsx`                          | パネル本体                                     |
| devtools     | `devtools/src/components/DebugLogList.tsx`                        | 一覧と vnode キャッシュ                        |
| devtools     | `devtools/src/components/DebugLogRow.tsx`                         | 行の表示                                       |
| devtools     | `devtools/src/components/DebugLogCount.tsx` / `DebugLogBadge.tsx` | 件数                                           |
| devtools     | `devtools/src/hooks/usePublisher.ts` / `useSubscriber.ts`         | debug callback の接続とアプリ内ログ            |
| devtools     | `devtools/src/signals/preconditionWatch.ts`                       | 前提警告のログ                                 |
| テスト       | `devtools/src/signals/debugLog.test.ts` ほか 8 ファイル           | 蓄積・整形・コピー・秘密情報                   |
| テスト       | `tests/e2e/devtools-debug-panel.spec.ts`                          | 表示・操作・コピー・描画回数・絞り込み (16 件) |
| ドキュメント | `docs/LOW_LEVEL_API.md`                                           | debug callback の説明 (内部イベント一覧が古い) |
| ドキュメント | `README.md:502` / `:505`                                          | 機能一覧                                       |

## 7. テストで固定されていること

- 単体 (整備後: debug 関連 10 ファイル 112 件)
  - 蓄積の上限・連番・整形済み時刻・経過時間の基準・クリア (`devtools/src/signals/debugLog.test.ts`)
  - Copy for LLM の節・ボタンごとの絞り込み・publisher 節の省略 (`devtools/src/signals/debugExport.test.ts`)
  - 認可トークンを載せうる型の分類と payload の非保持、4,096 バイト上限 (`devtools/src/hooks/debugMessageLog.test.ts`)
  - prefix の付与 (`devtools/src/hooks/handleDebugMessage.test.ts`)
  - コピー本文の整形とプロパティテスト (`devtools/src/utils/debugExportText.test.ts` / `.prop.ts`)
  - 行の状態の枝刈り (`devtools/src/utils/logRowState.test.ts`)
  - 前提警告のログ (`devtools/src/signals/preconditionWatch.test.ts`)
- E2E (`tests/e2e/devtools-debug-panel.spec.ts`)
  - 新しい順の表示、展開・折りたたみ、Binary タブ、Expand All / Collapse All、Clear
  - Copy for LLM の本文と、publisher / subscriber ごとの絞り込み
  - 上限で捨てたログの状態、バッジ、c4m の伏せ字
  - 1,000 件表示で 1 件追加したときに描画される行が 1 件であること
  - 行コピーの表示

## 8. 未確認

- 実リレーを起動した状態での debug ログの量とパネル操作の体感 (E2E はリレーを起動しない)
- 長時間 (数千件を超える) セッションでのメモリ使用量
- 0767 で仮想化を選んだ場合の実装コストと、E2E の描画回数テストへの影響

## 9. 参照 issue

- closed: 0138 / 0142 / 0149 / 0151 / 0167 / 0170 / 0173 / 0174 / 0175 / 0250 / 0596 / 0764 / 0765 / 0766
- open: 0767 (デバッグパネルの追記コスト)

## 10. このブランチで行った整備

対象ブランチ: `feature/add-devtools-debug-panel-usability`

### UI

- 検索欄を追加した。メッセージ本文と data の表示用整形 (Request ID など) を対象に、
  大文字小文字を区別せずに絞り込む。検索語があるときの Esc は検索語だけを消す
- 重要度 (Info / Warn / Error / Debug) のチェックボックスを追加した
- 接続元 (All Sources / Publisher / subscriber-id) の選択を追加した
- 絞り込み中は「N of M shown」を出し、Reset で検索語・重要度・接続元をまとめて戻せる
- Pause / Resume を追加した。停止中はその時点の一覧を固定し、増えた件数を「N new」で出す
- Auto Scroll は先頭を表示している間だけ追従する。先頭から離れて読んでいる間は
  新しいログで引き戻さず、「Jump to latest」ボタンで戻れるようにした
- 行に重要度の文字 (INFO / WARN / ERROR / DEBUG) を出した
- 絞り込み中・一時停止中は、画面に出ているログだけをコピーする「Visible」ボタンを出した
- パネルを flex の縦並びにし、一覧の高さを `calc(100vh - 190px)` の固定値から
  `flex-1 min-h-0` に変えた。狭い画面では全幅 (`w-full sm:w-[640px]`) にした
- パネルを開いても右上の Copy URL / Debug ボタンの位置を変えないようにした。
  デスクトップではパネルをボタン群の下 (`lg:top-20`) に開き、lg 未満では全画面に開く。
  ボタン幅は変えないよう、Debug の件数バッジはボタンの角に重ね、Copy URL は幅を固定した
- パネルを開いたときに本文を 1 列にし、十分に広い画面でのみ本文の幅を空ける
- Expand All が payload だけを持つ行も展開するようにした
- Copy for LLM と行コピーのログ行に重要度を含めた。行コピーと Visible コピーにも
  c4m の伏せ字をかけた

### 不具合修正

- Catalog は Media Timeline Template に `[bigint, bigint]` を含むため、行を展開したときの
  `JSON.stringify` が例外になっていた。bigint を文字列にして表示する
- `NEW_GROUP_REQUEST received` に `[publisher]` の prefix が無く、接続元の絞り込みと
  Publisher の Copy for LLM から漏れていた

### 実装

- 絞り込みの条件と判定は `devtools/src/utils/logFilter.ts` に純関数として置いた
- `LogEntry` に `source` (行頭の接続識別子) と `searchText` (検索用の小文字化済み文字列) を
  追加し、どちらも `addLog` の時点で 1 回だけ作る。検索用の文字列は
  `MAX_SEARCH_TEXT_LENGTH` (4,096 文字) で切り、大きい Catalog を保持しても
  メモリを圧迫しないようにした
- 一覧は `DebugLogList` が絞り込みと一時停止のスナップショットを受け取り、行の vnode の
  キャッシュは維持したまま表示する行だけを選ぶ
- テスト: `devtools/src/utils/logFilter.test.ts` を追加。`debugLog` / `logFormatters` /
  `debugExportText` の単体テストを追加・更新し、E2E に絞り込み・一時停止・最新へ戻る・
  狭い画面の 4 件を追加した

### レビューで追加した修正

- `addLog` が検索用の文字列を作るために data を整形するとき、トップレベルに循環参照が
  あると `RangeError` でログ自体が失われていた。整形に失敗したときはメッセージ本文だけを
  検索対象にして、ログを必ず残す
- Expand All が payload だけを持つ行を展開しても、data の空文字しか出なかった。
  data を持たない行は Binary を既定の表示にし、展開アイコンと Binary タブを出す
- 一時停止中に上限 (`MAX_LOGS`) を超えて増えた場合、増加件数が保持件数までしか
  数えられなかった。停止時の `logSequence` を保存し、絞り込みが無いときは追加総数を出す。
  絞り込み中は保持している一致数を出し、捨てられた分があるときは `+` を付ける
- 一時停止から再開したとき、停止中に捨てられたログの展開状態が残っていた。
  再開時に現在の一番古い連番で枝刈りする
- 空のまま停止したときの案内を「Paused with no logs.」にした
- 行頭の角括弧は小文字で始まる接続識別子だけを接続元として扱う (`[WARN]` を誤認しない)
- パネルの幅のブレークポイントを `lg` に揃え、640〜1023 px では全幅にする。
  パネルを開いているときの本文の列数は `2xl` 以上でだけ 2 列にする
- 増加件数に `aria-live` を付け、重要度ラベルの可読性を上げた
- E2E に、payload だけの行の展開、上限をまたぐ一時停止、重要度をすべて外した表示、
  中間幅 (800 px) のパネル幅、遷移中の位置を読まないための待ち、
  Debug ボタンが開閉で動かないことを追加した
