# moqt-devtools が Publisher と Subscriber を常に両方表示し、片方だけのページを開けない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-mode
- Polished: 2026-09-25
- Updated: 2026-09-25

## 目的

moqt-devtools (`devtools/index.html`) は Publisher と Subscriber を 1 画面に常に両方表示する。別のマシンで Publisher と Subscriber を開く使い方 (時計のずれを含む遅延の計測、他の実装との相互運用の確認) では、各マシンで使わない側のパネルと設定が並び、どちらの役割のページなのかが画面から分からない。

URL クエリ `mode` で Publisher だけ / Subscriber だけを表示できるようにする。ヘッダーの副題に 3 つのモードを並べ、今のモードを示すとともに、他のモードのページを今の接続設定のまま新しいタブで開けるようにする。`mode` 付きで開いたページでは Copy URL が `mode` を保ち、同じ役割と接続設定のページを開き直したり、別のマシンへ渡したりできるようにする。

同じ接続設定のページを URL で再現するため、今は Copy URL に載らない `catalogSubscriptionTimeout` (Catalog Timeout) と `useDedicatedWorker` (Use Dedicated Worker) も URL に載せる。載らないままだと、Subscriber 用の URL を渡した先でこの 2 つが既定値に戻る。

## 現状

- `devtools/src/App.tsx` の `App` は `PublisherPanel` 1 つと `SubscriberPanel` N 個を `grid grid-cols-1 lg:grid-cols-2` のグリッドに常に並べ、その下に Add Subscriber ボタンを置く。ヘッダーの副題は「Media over QUIC Transport - Publisher & Subscriber」で固定である
- `devtools/src/main.tsx` は起動時に `initFromUrl` で URL クエリを読み、`sub.subscriberIds` が空なら `sub.addSubscriber()` で Subscriber を 1 つ作る
- Publisher と Subscriber はそれぞれ別の Session を持ち、互いの状態に依存しない。共有するのは接続設定の signal (`devtools/src/signals/connectionSettings.ts`) と `settingsDisabled` だけである (`devtools/src/hooks/usePublisher.ts` は後始末の `cleanupPublisher` で `sub.hasActiveSubscriber` を、`devtools/src/hooks/useSubscriber.ts` は `resetSubscriberState` で `sub.hasActiveSubscriber` と `pub.hasActivePublisher` を見て `settingsDisabled` を戻す。どちらも開始の途中 (`isStarting`) を使っているものとして数える)
- 接続設定の参照先は、`usePublisher.ts` と `useSubscriber.ts` が読む `settings.*` で次のように分かれる
  - 共通: `url` / `fragment` / `certificateHash` / Authorization Token (`buildConnectUrl` / `buildConnectOptions` 経由) / `namespace` / `useDedicatedWorker`
  - Publisher だけ: `trackName` / `codec` / Video Settings (`videoSource` / `selectedCameraDeviceId` / `resolution` / `framerate` / `bitrate` / `keyframeInterval`) / Audio Settings (`audioSource` / `selectedMicrophoneDeviceId` / `audioEchoCancellation` / `audioNoiseSuppression` / `audioAutoGainControl` / `audioCodec` / `audioBitrate` / `audioSampleRate` / `audioChannels`) / Publish Settings (`maxCacheDuration`)
  - Subscriber だけ: Subscribe Settings (`catalogSubscriptionTimeout`) / `jitterBufferEnabled`
  - Subscriber は catalog に載った Track 名で購読し (`useSubscriber.ts` の `resolveCatalogMediaTracks`)、`trackName` を読まない
- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` はこれらを 1 枚のカードに並べる。Codec の `<select>` は Namespace / Track Name と同じ行にあり、Video Settings / Audio Settings / Publish Settings / Subscribe Settings / WebCodecs Settings / Authorization Token は見出し (`<h3>`) つきの節に分かれている。WebCodecs Settings の節には共通の Use Dedicated Worker と Subscriber だけが使う Jitter Buffer (`data-testid="settings-jitter-buffer"`) が同居する
  - カードの見出しの行 (`data-testid="connection-settings-toggle"`) で設定の欄を開け閉めできる。開け閉めの状態は `devtools/src/signals/layout.ts` の `isConnectionSettingsOpen` が持ち、localStorage に覚える (既定は開く)。閉じている間は設定の節 (`data-testid="connection-settings-content"`) を `hidden` にする
  - 閉じている間は、`buildConnectionSummary` で作った要約を 1 行で出す (`data-testid="connection-settings-summary"`)。項目は Server URL / Namespace / Track (`trackName`) / Video (`videoSource` / `codec` / `resolution` / `framerate`) / Audio (`audioSource` / `audioCodec`) で、Track / Video / Audio は Publisher だけが使う設定である
- `devtools/src/hooks/useCopyUrlButton.ts` の `useCopyUrlButton` は `buildQueryString()` の結果で `history.replaceState` によりアドレスバーの URL を書き換えてからクリップボードへ書き込む。`buildQueryString` に載らない値は Copy URL を押した時点でアドレスバーからも消える
- `buildQueryString` と `initFromUrl` は `catalogSubscriptionTimeout` と `useDedicatedWorker` を扱わない。`ConnectionSettings` の設定のうち、値にかかわらず URL に載らないのはこの 2 つだけで、Copy URL で得た URL や再読み込みでは既定値 (5000 と true) に戻る
  - Authorization Token の Alias Type / Token Type / Token Alias は、Token Value があるときだけ載る
  - `ConnectionSettings` の外にある Subscriber ごとの設定も URL に載らない。`SubscriberPanel` の NEW_GROUP_REQUEST のチェック (`SubscriberInstance.newGroupRequestEnabled`) と、音声の再生のトグル (`SubscriberInstance.audioPlaybackEnabled`) である
  - Catalog Timeout の `<select>` の選択肢 (3000 / 5000 / 10000 / 30000 / 60000 / 120000 / 300000) は `ConnectionSettings` に直書きされている
  - 同じ真偽値の `jitterBufferEnabled` は、既定値 (true) のときは載せず、無効のときだけ `jitterBuffer=0` を載せる。読み込みでは `0` / `1` だけを受け付ける
- `devtools/src/components/DebugPanel.tsx` の `DebugPanel` は Copy for LLM の行に All / Publisher のボタンと、`subscriberIds` から作る Subscriber ごとのボタンを並べる。Publisher のボタンは常に出る。LLM 用のテキストの先頭に付ける `generateSettingsText` は、Codec から Jitter Buffer までの設定を常にすべて出力する

## 設計方針

- URL クエリ `mode` を足す。値は `publisher` (Publisher だけ) / `subscriber` (Subscriber だけ) / `both` (両方) とし、省略時は `both` とする
  - 許可リストの定数 (例: `MODES`) と判定関数を `devtools/src/signals/connectionSettings.ts` に置く。`AUDIO_SOURCES` / `isAudioSourceType` と同じ形にする
  - 許可リストに無い値は無視して `both` のままにする
  - `buildQueryString` は `both` のときに `mode` を載せない (`jitterBuffer` を既定値で載せないのと同じ扱い)。`publisher` / `subscriber` のときは載せ、Copy URL でアドレスバーから `mode` が消えないようにする
  - 型は `devtools/src/types.ts` に `DevtoolsMode = "both" | "publisher" | "subscriber"` のように置く (名前は実装時に決める)
- モードは起動時の `initFromUrl` で 1 回だけ決める。ページの中でモードを切り替える UI は置かず、別のモードのページは副題のリンクから新しいタブで開く
  - 1 つのページの中で役割が変わらないため、接続したまま役割が変わる状態は起きない。切り替えを押せなくする処理、切り替えで Subscriber を作り直す処理、隠したパネルが裏で動き続ける状態への対処はいずれも不要になる
  - 新しいタブで開くため、リンクを押しても今のページの接続は切れない。1 台のマシンで Publisher と Subscriber を別のタブで開くこともできる
- publisher モードで隠すもの
  - `SubscriberPanel` と Add Subscriber ボタン
  - Subscribe Settings の節と Jitter Buffer のチェックボックス (WebCodecs Settings の節と Use Dedicated Worker は残す)
  - `main.tsx` は publisher モードでは最初の Subscriber を作らない
- subscriber モードで隠すもの
  - `PublisherPanel`
  - Track Name の欄と Codec の `<select>` (Namespace と同じ行にあり、隠すとその行は Namespace だけになる)
  - Video Settings / Audio Settings / Publish Settings の節
  - 接続設定の欄を閉じたときの要約の Track / Video / Audio の項目。subscriber モードの要約は Server URL / Namespace だけになる。publisher モードと `both` の要約は今のまま変えない (Subscriber だけの設定は要約に無い)
- 共通の設定 (Server URL / Certificate Hash / URI Fragment / Namespace / Use Dedicated Worker / Authorization Token) はどのモードでも表示する
- 隠した設定の signal と URL クエリの読み書きは、モードによって変えない。subscriber モードの Copy URL と副題のリンク先にも Publisher の設定が載り、`mode` を外して開き直せば元の設定で両方を表示できる
- `catalogSubscriptionTimeout` と `useDedicatedWorker` を `buildQueryString` / `initFromUrl` で扱う。どちらもモードに関係なく載せる
  - `catalogSubscriptionTimeout`: 他の数値の設定 (`maxCacheDuration` など) と同じく常に載せる。読み込みでは Catalog Timeout の `<select>` と同じ許可リストで検証し、許可リストに無い値は無視する。選択肢は定数 (例: `CATALOG_SUBSCRIPTION_TIMEOUTS`) として `connectionSettings.ts` に置き、`<select>` もこの定数から作る (`AUDIO_BITRATES` と同じ形。選択肢に無い値を受け入れると `<select>` の表示が空になり、表示と実際の設定が食い違うため)。表示のラベル (3 sec から 5 min まで) は今のまま変えない
  - `useDedicatedWorker`: 既定が有効なので、無効のときだけ `useDedicatedWorker=0` を載せる。読み込みでは `0` / `1` だけを受け付ける (`jitterBuffer` と同じ扱い)
- レイアウトは既存の 2 列グリッドのまま変えず、左の列から詰めて並べる。将来 Publisher を複数並べることも想定し、1 列で中央に寄せるような単独表示用のレイアウトは作らない
- ヘッダーの副題は「Media over QUIC Transport - 」に続けて、3 つのモードを `|` で区切って並べる
  - 並びはどのモードでも同じで、`Publisher & Subscriber` (`both`) / `Publisher` (`publisher`) / `Subscriber` (`subscriber`) の順にする
  - 今のモードは太字にし、リンクにしない。ページの中に切り替えの UI を置かないため、この太字が今のモードを知る唯一の表示になる
  - 他の 2 つは新しいタブで開くリンク (`target="_blank"` / `rel="noopener noreferrer"`) にする。リンク先は、今の接続設定で `buildQueryString` と同じクエリを作り、`mode` だけをそのモードに差し替えた URL とする (`both` なら `mode` を載せない)。今の設定から、指定したモードのクエリを作る関数を `connectionSettings.ts` に置き (名前は実装時に決める)、`buildQueryString` と組み立てを共有する
  - リンク先は今の設定に追従させる。画面で設定を変えたら、押す前にリンク先へ反映されている状態にする (リンクのアドレスをブラウザのメニューでコピーして別のマシンへ渡せるように、押した時点で作るのではなく `href` に持たせる)
  - リンクを押してもアドレスバーの URL は書き換えない (Copy URL と違い `history.replaceState` を呼ばない)
  - 例 (`*...*` は太字の今のモード、`[...]` はリンク)
    - `both`: `Media over QUIC Transport - *Publisher & Subscriber* | [Publisher] | [Subscriber]`
    - `publisher`: `Media over QUIC Transport - [Publisher & Subscriber] | *Publisher* | [Subscriber]`
    - `subscriber`: `Media over QUIC Transport - [Publisher & Subscriber] | [Publisher] | *Subscriber*`
- `devtools/src/testApi.ts` (`window.moqtDevTools`) は変えない。publisher モードでは Subscriber が 0 個になり、Subscriber の統計は空の配列を返す
- `DebugPanel` は、subscriber モードでは Copy for LLM の Publisher のボタンを隠す。publisher モードでは Subscriber が 0 個なので、Subscriber ごとのボタンは手を入れなくても出ない。All のボタンと `generateSettingsText` の出力は変えない (診断用の出力であり、隠した設定の signal を変えない方針とそろえる)
- テストの分担
  - `connectionSettings.test.ts`: signal と URL の往復、許可リストに無い値の無視、既定値を URL に載せないこと、指定したモードのクエリが今の設定を保ったまま `mode` だけを差し替えること
  - 画面の振る舞い (モードごとの表示の有無、閉じた欄の要約の項目、副題の今のモードとリンク先、リンクを押すと新しいタブがそのモードで開くこと、Copy URL から開き直すまでの往復) は手元のブラウザで確かめる。表示の有無は接続設定の欄を開いた状態で確かめ (欄を閉じると設定の節が一律に隠れ、モードで隠したのかを区別できないため)、要約は欄を閉じてから確かめる
- 対象外
  - UI の E2E を足すこと。UI 系の E2E は当面足さない方針のため、画面の振る舞いは手元のブラウザで確かめる
  - 役割ごとの URL をクリップボードへコピーする専用のボタン (副題のリンクのアドレスはブラウザのメニューでコピーできる)
  - Subscriber ごとの設定 (NEW_GROUP_REQUEST のチェックと音声の再生のトグル) を URL に載せること。Subscriber ごとに持つ状態で、複数の Subscriber があると URL の 1 つのパラメータに対応しないため
  - Authorization Token の Alias Type / Token Type / Token Alias を、Token Value が無いときにも載せること
  - ページのタイトル (`<title>`) をモードに合わせて変えること

## 完了条件

手元のブラウザで次が確かめられる。

- `?mode=publisher` で Publisher のパネルと Publisher が使う設定だけが表示され、Subscriber は 1 つも作られない
- `?mode=subscriber` で Subscriber のパネル、Add Subscriber ボタン、Subscriber が使う設定だけが表示され、Track Name の欄と `DebugPanel` の Publisher のボタンも出ない。接続設定の欄を閉じたときの要約は Server URL / Namespace だけになる
- `mode` が無い URL と許可リストに無い値 (例: `?mode=foo`) では従来どおり両方が表示される
- どのモードでも共通の設定が表示される
- どのモードでもヘッダーの副題に 3 つのモードが同じ順で並び、今のモードだけが太字でリンクになっていない
- 副題の他の 2 つのモードのリンクは、今の接続設定とそのモードの `mode` を載せた URL (`both` では `mode` 無し) を新しいタブで開く。画面で設定を変えるとリンク先に反映され、押すと新しいタブがそのモードで表示される
- Copy URL で `publisher` / `subscriber` の `mode` が保たれ、`both` では `mode` が載らない。開き直すと同じモードで表示される
- Copy URL に `catalogSubscriptionTimeout` が常に載り、`useDedicatedWorker` は無効のときだけ `useDedicatedWorker=0` で載る。その URL を開き直すと、Catalog Timeout の `<select>` の値と Use Dedicated Worker のチェックが戻る
- 選択肢に無い `catalogSubscriptionTimeout` を URL で渡しても、Catalog Timeout の `<select>` は既定の 5000 を表示する

テストと検証では次が満たされる。

- `devtools/src/signals/connectionSettings.test.ts` で次が確かめられる
  - `mode` / `catalogSubscriptionTimeout` / `useDedicatedWorker` の `initFromUrl` と `buildQueryString` の往復
  - 許可リストに無い値の無視 (`mode=foo`、選択肢に無い `catalogSubscriptionTimeout`、`0` / `1` 以外の `useDedicatedWorker`)
  - `both` と `useDedicatedWorker` の既定値 (有効) を URL に載せないこと
  - 指定したモードのクエリが、今の設定を保ったまま `mode` だけを差し替え、`both` では `mode` を載せないこと
- `CHANGES.md` の `## develop` に、moqt-devtools の `mode` の追加 (副題のリンクから各モードのページを新しいタブで開けることを含む) と、Catalog Timeout / Use Dedicated Worker を URL に載せることが `[ADD]` で載る
- `npx vp check` / `npx vp test --run` / 既存の E2E (`npx vp run e2e-test`) が通る

## 参照

- `devtools/src/App.tsx` の `App` / `devtools/src/main.tsx`
- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` / `buildConnectionSummary`
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` / `buildQueryString` / `AUDIO_SOURCES` / `isAudioSourceType` / `AUDIO_BITRATES` / `initAudioSettingsFromUrl`
- `devtools/src/signals/connectionSettings.test.ts` の `jitterBuffer` の往復のテスト (真偽値の設定を URL で扱う既存のテスト)
- `devtools/src/signals/layout.ts` の `isConnectionSettingsOpen` (接続設定の欄の開け閉め)
- `devtools/src/hooks/useCopyUrlButton.ts` の `useCopyUrlButton`
- `devtools/src/components/DebugPanel.tsx` の `DebugPanel` / `generateSettingsText`
- `devtools/src/components/SubscriberPanel.tsx` / `devtools/src/signals/subscriber.ts` の `SubscriberInstance` (`newGroupRequestEnabled` / `audioPlaybackEnabled`。URL に載せない Subscriber ごとの設定)

## 解決方法

{未着手}
