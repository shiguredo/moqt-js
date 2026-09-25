# moqt-devtools が Publisher と Subscriber を常に両方表示し、片方だけのページを開けない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-mode
- Polished: 2026-09-25

## 目的

moqt-devtools (`devtools/index.html`) は Publisher と Subscriber を 1 画面に常に両方表示する。別のマシンで Publisher と Subscriber を開く使い方 (時計のずれを含む遅延の計測、他の実装との相互運用の確認) では、各マシンで使わない側のパネルと設定が並び、どちらの役割のページなのかが画面から分からない。

URL クエリ `mode` で Publisher だけ / Subscriber だけを表示できるようにする。`mode` 付きで開いたページでは Copy URL が `mode` を保ち、同じ役割と接続設定のページを開き直したり、別のマシンへ渡したりできるようにする。

同じ接続設定のページを URL で再現するため、今は Copy URL に載らない `catalogSubscriptionTimeout` (Catalog Timeout) と `useDedicatedWorker` (Use Dedicated Worker) も URL に載せる。載らないままだと、Subscriber 用の URL を渡した先でこの 2 つが既定値に戻る。

## 現状

- `devtools/src/App.tsx` の `App` は `PublisherPanel` 1 つと `SubscriberPanel` N 個を `grid grid-cols-1 lg:grid-cols-2` のグリッドに常に並べ、その下に Add Subscriber ボタンを置く。ヘッダーの副題は「Media over QUIC Transport - Publisher & Subscriber」で固定である
- `devtools/src/main.tsx` は起動時に `initFromUrl` で URL クエリを読み、`sub.subscriberIds` が空なら `sub.addSubscriber()` で Subscriber を 1 つ作る
- Publisher と Subscriber はそれぞれ別の Session を持ち、互いの状態に依存しない。共有するのは接続設定の signal (`devtools/src/signals/connectionSettings.ts`) と `settingsDisabled` だけである (`devtools/src/hooks/usePublisher.ts` は停止時に `sub.hasActiveSubscriber` を、`devtools/src/hooks/useSubscriber.ts` は `pub.pubSession` を見て `settingsDisabled` を戻す)
- 接続設定の参照先は、`usePublisher.ts` と `useSubscriber.ts` が読む `settings.*` で次のように分かれる
  - 共通: `url` / `fragment` / `certificateHash` / Authorization Token (`buildConnectUrl` / `buildConnectOptions` 経由) / `namespace` / `trackName` / `useDedicatedWorker`
  - Publisher だけ: `codec` / Video Settings (`videoSource` / `selectedCameraDeviceId` / `resolution` / `framerate` / `bitrate` / `keyframeInterval`) / Audio Settings (`audioSource` / `audioCodec` / `audioBitrate` / `audioSampleRate` / `audioChannels`) / Publish Settings (`maxCacheDuration`)
  - Subscriber だけ: Subscribe Settings (`catalogSubscriptionTimeout`) / `jitterBufferEnabled`
- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings` はこれらを 1 枚のカードに並べる。Codec の `<select>` は Namespace / Track Name と同じ行にあり、Video Settings / Audio Settings / Publish Settings / Subscribe Settings / WebCodecs Settings / Authorization Token は見出し (`<h3>`) つきの節に分かれている。WebCodecs Settings の節には共通の Use Dedicated Worker と Subscriber だけが使う Jitter Buffer (`data-testid="settings-jitter-buffer"`) が同居する
- `devtools/src/hooks/useCopyUrlButton.ts` の `useCopyUrlButton` は `buildQueryString()` の結果で `history.replaceState` によりアドレスバーの URL を書き換えてからクリップボードへ書き込む。`buildQueryString` に載らない値は Copy URL を押した時点でアドレスバーからも消える
- `buildQueryString` と `initFromUrl` は `catalogSubscriptionTimeout` と `useDedicatedWorker` を扱わない。`ConnectionSettings` の設定のうち、値にかかわらず URL に載らないのはこの 2 つだけで、Copy URL で得た URL や再読み込みでは既定値 (5000 と true) に戻る
  - Authorization Token の Alias Type / Token Type / Token Alias は、Token Value があるときだけ載る
  - `ConnectionSettings` の外にある Subscriber ごとの設定も URL に載らない。`SubscriberPanel` の NEW_GROUP_REQUEST のチェック (`SubscriberInstance.newGroupRequestEnabled`) と、音声の再生のトグル (`SubscriberInstance.audioPlaybackEnabled`) である
  - Catalog Timeout の `<select>` の選択肢 (3000 / 5000 / 10000 / 30000 / 60000 / 120000 / 300000) は `ConnectionSettings` に直書きされている。E2E から指す `data-testid` は無く、`id="catalogSubscriptionTimeout"` / `id="useDedicatedWorker"` だけがある
  - 同じ真偽値の `jitterBufferEnabled` は、既定値 (true) のときは載せず、無効のときだけ `jitterBuffer=0` を載せる。読み込みでは `0` / `1` だけを受け付ける
- `devtools/src/components/DebugPanel.tsx` の `DebugPanel` は Copy for LLM の行に All / Publisher のボタンと、`subscriberIds` から作る Subscriber ごとのボタンを並べる。Publisher のボタンは常に出る。LLM 用のテキストの先頭に付ける `generateSettingsText` は、Codec から Jitter Buffer までの設定を常にすべて出力する

## 設計方針

- URL クエリ `mode` を足す。値は `publisher` (Publisher だけ) / `subscriber` (Subscriber だけ) / `both` (両方) とし、省略時は `both` とする
  - 許可リストの定数 (例: `MODES`) と判定関数を `devtools/src/signals/connectionSettings.ts` に置く。`AUDIO_SOURCES` / `isAudioSourceType` と同じ形にする
  - 許可リストに無い値は無視して `both` のままにする
  - `buildQueryString` は `both` のときに `mode` を載せない (`jitterBuffer` を既定値で載せないのと同じ扱い)。`publisher` / `subscriber` のときは載せ、Copy URL でアドレスバーから `mode` が消えないようにする
  - 型は `devtools/src/types.ts` に `DevtoolsMode = "both" | "publisher" | "subscriber"` のように置く (名前は実装時に決める)
- モードは起動時の `initFromUrl` で 1 回だけ決め、画面上に切り替えの UI は置かない
  - URL を書き換えるとページが読み直されるため、接続したまま役割が変わる状態は起きない。切り替えを押せなくする処理、切り替えで Subscriber を作り直す処理、隠したパネルが裏で動き続ける状態への対処はいずれも不要になる
- publisher モードで隠すもの
  - `SubscriberPanel` と Add Subscriber ボタン
  - Subscribe Settings の節と Jitter Buffer のチェックボックス (WebCodecs Settings の節と Use Dedicated Worker は残す)
  - `main.tsx` は publisher モードでは最初の Subscriber を作らない
- subscriber モードで隠すもの
  - `PublisherPanel`
  - Codec の `<select>`、Video Settings / Audio Settings / Publish Settings の節
- 共通の設定 (Server URL / Certificate Hash / URI Fragment / Namespace / Track Name / Use Dedicated Worker / Authorization Token) はどのモードでも表示する
- 隠した設定の signal と URL クエリの読み書きは、モードによって変えない。subscriber モードの Copy URL にも Publisher の設定が載り、`mode` を外して開き直せば元の設定で両方を表示できる
- `catalogSubscriptionTimeout` と `useDedicatedWorker` を `buildQueryString` / `initFromUrl` で扱う。どちらもモードに関係なく載せる
  - `catalogSubscriptionTimeout`: 他の数値の設定 (`maxCacheDuration` など) と同じく常に載せる。読み込みでは Catalog Timeout の `<select>` と同じ許可リストで検証し、許可リストに無い値は無視する。選択肢は定数 (例: `CATALOG_SUBSCRIPTION_TIMEOUTS`) として `connectionSettings.ts` に置き、`<select>` もこの定数から作る (`AUDIO_BITRATES` と同じ形。選択肢に無い値を受け入れると `<select>` の表示が空になり、表示と実際の設定が食い違うため)。表示のラベル (3 sec から 5 min まで) は今のまま変えない
  - `useDedicatedWorker`: 既定が有効なので、無効のときだけ `useDedicatedWorker=0` を載せる。読み込みでは `0` / `1` だけを受け付ける (`jitterBuffer` と同じ扱い)
- 相手の役割のページの URL は、Copy URL で得た URL の `mode` を書き換えて作る (例: `mode=publisher` を `mode=subscriber` にする。`both` のページの URL には `mode=subscriber` を足す)。役割ごとの URL を作る UI は置かない
- レイアウトは既存の 2 列グリッドのまま変えず、左の列から詰めて並べる。将来 Publisher を複数並べることも想定し、1 列で中央に寄せるような単独表示用のレイアウトは作らない
- ヘッダーの副題をモードに合わせて次の文字列にする。切り替えの UI を置かないため、副題が今のモードを知る唯一の表示になる
  - `both`: 「Media over QUIC Transport - Publisher & Subscriber」 (従来どおり)
  - `publisher`: 「Media over QUIC Transport - Publisher」
  - `subscriber`: 「Media over QUIC Transport - Subscriber」
- `devtools/src/testApi.ts` (`window.moqtDevTools`) は変えない。publisher モードでは Subscriber が 0 個になり、Subscriber の統計は空の配列を返す
- `DebugPanel` は、subscriber モードでは Copy for LLM の Publisher のボタンを隠す。publisher モードでは Subscriber が 0 個なので、Subscriber ごとのボタンは手を入れなくても出ない。All のボタンと `generateSettingsText` の出力は変えない (診断用の出力であり、隠した設定の signal を変えない方針とそろえる)
- E2E で表示の有無と URL の往復を確かめるため、次に `data-testid` を足す (名前は既存の `settings-jitter-buffer` / `audio-bitrate` / `publisher-publish-button` などに合わせる)
  - `PublisherPanel` / `SubscriberPanel` のルート、Add Subscriber ボタン、ヘッダーの副題、`DebugPanel` の Publisher のボタン
  - Codec の `<select>`、Video Settings / Audio Settings / Publish Settings / Subscribe Settings の各節
  - Catalog Timeout の `<select>` と Use Dedicated Worker のチェックボックス
- テストの分担
  - `connectionSettings.test.ts`: signal と URL の往復、許可リストに無い値の無視、既定値を URL に載せないこと
  - E2E (`tests/e2e/devtools-mode.spec.ts`): モードごとの表示の有無と副題の文字列、および Copy URL から開き直すまでの往復。往復は `tests/e2e/devtools-audio.spec.ts` と同じ流れ (画面で値を変える → `copy-url` を押す → `toHaveURL` で確かめる → `page.goto(page.url())` で開き直す → 画面の値を確かめる) にする。実リレーは使わない
- 対象外
  - 役割ごとの URL をコピーするボタンなど、今のページと別の役割の URL を作る UI
  - Subscriber ごとの設定 (NEW_GROUP_REQUEST のチェックと音声の再生のトグル) を URL に載せること。Subscriber ごとに持つ状態で、複数の Subscriber があると URL の 1 つのパラメータに対応しないため
  - Authorization Token の Alias Type / Token Type / Token Alias を、Token Value が無いときにも載せること
  - ページのタイトル (`<title>`) をモードに合わせて変えること

## 完了条件

- `?mode=publisher` で Publisher のパネルと Publisher が使う設定だけが表示され、Subscriber は 1 つも作られない
- `?mode=subscriber` で Subscriber のパネル、Add Subscriber ボタン、Subscriber が使う設定だけが表示され、`DebugPanel` の Publisher のボタンも出ない
- `mode` が無い URL と許可リストに無い値 (例: `?mode=foo`) では従来どおり両方が表示される
- どのモードでも共通の設定が表示され、ヘッダーの副題が設計方針に書いた文字列になる (E2E で文字列を確かめる)
- Copy URL で `publisher` / `subscriber` の `mode` が保たれ、`both` では `mode` が載らない。開き直すと同じモードで表示される (E2E で確かめる)
- Copy URL に `catalogSubscriptionTimeout` が常に載り、`useDedicatedWorker` は無効のときだけ `useDedicatedWorker=0` で載る。その URL を開き直すと、Catalog Timeout の `<select>` の値と Use Dedicated Worker のチェックが戻る (E2E で確かめる)
- 選択肢に無い `catalogSubscriptionTimeout` を URL で渡しても、Catalog Timeout の `<select>` は既定の 5000 を表示する (E2E で確かめる)
- `devtools/src/signals/connectionSettings.test.ts` で次が確かめられる
  - `mode` / `catalogSubscriptionTimeout` / `useDedicatedWorker` の `initFromUrl` と `buildQueryString` の往復
  - 許可リストに無い値の無視 (`mode=foo`、選択肢に無い `catalogSubscriptionTimeout`、`0` / `1` 以外の `useDedicatedWorker`)
  - `both` と `useDedicatedWorker` の既定値 (有効) を URL に載せないこと
- E2E (`tests/e2e/devtools-mode.spec.ts`) でモードごとの表示の有無と副題の文字列が確かめられる。実リレーは使わない UI テストとする
- `CHANGES.md` の `## develop` に、moqt-devtools の `mode` の追加と、Catalog Timeout / Use Dedicated Worker を URL に載せることが `[ADD]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/App.tsx` の `App` / `devtools/src/main.tsx`
- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings`
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` / `buildQueryString` / `AUDIO_SOURCES` / `isAudioSourceType` / `AUDIO_BITRATES` / `initAudioSettingsFromUrl`
- `devtools/src/signals/connectionSettings.test.ts` の `jitterBuffer` の往復のテスト (真偽値の設定を URL で扱う既存のテスト)
- `devtools/src/hooks/useCopyUrlButton.ts` の `useCopyUrlButton`
- `devtools/src/components/DebugPanel.tsx` の `DebugPanel` / `generateSettingsText`
- `tests/e2e/devtools-audio.spec.ts` (URL クエリの往復を UI で確かめる既存の E2E。Copy URL の往復の E2E はこの流れにそろえる)
- `devtools/src/components/SubscriberPanel.tsx` / `devtools/src/signals/subscriber.ts` の `SubscriberInstance` (`newGroupRequestEnabled` / `audioPlaybackEnabled`。URL に載せない Subscriber ごとの設定)

## 解決方法

{未着手}
