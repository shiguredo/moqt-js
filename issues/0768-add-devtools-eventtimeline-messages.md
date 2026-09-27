# moqt-devtools に eventtimeline のメッセージ送受信を追加する

- Created: 2026-09-27
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-eventtimeline-messages
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools は audio / video の publish / subscribe しか扱えず、MSF が audio / video 以外のトラックとして定める event timeline (draft-ietf-moq-msf-01 §8) を実地で確認できない。event timeline は publisher が決めた任意の JSON データ (チャットのメッセージなど) を運べる枠であり、devtools から送受信できるようにして動作確認の幅を広げる。

## 現状

- `buildPublisherCatalog` (`devtools/src/hooks/usePublisher.ts`) は packaging が `loc` の audio / video トラックのみを catalog に載せる
- subscriber は `resolveCatalogMediaTracks` (`devtools/src/hooks/useSubscriber.ts`) で role が `video` / `audio` のトラックだけを選び、それ以外のトラックは購読しない
- `encodeEventTimeline` / `decodeEventTimeline` (`src/msf/timeline.ts`) は moqt-js の公開 API から利用できるが、devtools では使われていない
- catalog の eventtimeline 検証 (`src/msf/catalogTrackValidation.ts` の `validatePackagingSpecificRules`) は実装済みで、`eventType` / `depends` / `mimeType` の MUST を強制する

## 設計方針

- publisher の catalog に eventtimeline トラックを 1 本追加する
  - name は `events`、packaging は `eventtimeline`、eventType は `com.shiguredo.moqtdevtools.chat`、mimeType は `application/json`、role は `eventtimeline`、isLive は true とする
  - depends は同時に publish する audio / video のトラック名の配列とする (§8.2)
  - targetLatency / renderGroup は載せない (メディアを描画するトラックではないため)
- メッセージの payload は entry `{ t: Date.now(), data: { text: string } }` の配列を `encodeEventTimeline` で JSON 化したものとする
- メッセージごとに Group ID を進め、Group の先頭 Object (Object ID 0) にその時点の履歴を載せる。直近 100 件を上限とし、それより古い記録は publisher が保持しない (§8.3 の "all event timeline records accumulated and accessible" を満たす)
- PublisherPanel にメッセージの入力欄と Send ボタンのカードを追加する。送信は publisher が active のときだけ行える
- subscriber は catalog から packaging が `eventtimeline` のトラックを探して購読し、`decodeEventTimeline` の結果をタイムスタンプ付きで表示する。data が `{ text }` でない場合は JSON 文字列として表示する
- 高レベル API (`createMediaPublisher` / `createMediaSubscriber`) は変更せず、devtools 内の実装に閉じる
- event timeline トラックだけの catalog (audio / video なし) は対象外とし、既存の「audio / video が無ければエラー」の挙動は変えない
- 履歴管理などの純関数は `devtools/src/utils/` に置き、単体テストを付ける

## 完了条件

- devtools の publisher が catalog に eventtimeline トラックを載せ、UI からテキストを送信できる
- devtools の subscriber が eventtimeline トラックを購読し、受信したメッセージを表示できる
- `buildPublisherCatalog` と新規純関数の単体テスト、メッセージ UI の Playwright E2E が通る
- `CHANGES.md` の `## develop` に `[ADD]` で載る
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
