# moqt-devtools が Publisher と Subscriber を常に両方表示し、片方だけのページを開けない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-mode
- Polished: 2026-09-25

## 目的

moqt-devtools (`devtools/index.html`) は Publisher と Subscriber を 1 画面に常に両方表示する。別のマシンで Publisher と Subscriber を開く使い方 (時計のずれを含む遅延の計測、他の実装との相互運用の確認) では、各マシンで使わない側のパネルと設定が並び、どちらの役割のページなのかが画面から分からない。

URL クエリ `mode` で Publisher だけ / Subscriber だけを表示できるようにする。`mode` 付きで開いたページでは Copy URL が `mode` を保ち、同じ役割と設定のページを開き直したり、別のマシンへ渡したりできるようにする。

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
- 隠した設定の signal と URL クエリの読み書きは変えない。subscriber モードの Copy URL にも Publisher の設定が載り、`mode` を外して開き直せば元の設定で両方を表示できる
- 相手の役割のページの URL は、Copy URL で得た URL の `mode` を書き換えて作る (例: `mode=publisher` を `mode=subscriber` にする。`both` のページの URL には `mode=subscriber` を足す)。役割ごとの URL を作る UI は置かない
- レイアウトは既存の 2 列グリッドのまま変えず、左の列から詰めて並べる。将来 Publisher を複数並べることも想定し、1 列で中央に寄せるような単独表示用のレイアウトは作らない
- ヘッダーの副題をモードに合わせて次の文字列にする。切り替えの UI を置かないため、副題が今のモードを知る唯一の表示になる
  - `both`: 「Media over QUIC Transport - Publisher & Subscriber」 (従来どおり)
  - `publisher`: 「Media over QUIC Transport - Publisher」
  - `subscriber`: 「Media over QUIC Transport - Subscriber」
- `devtools/src/testApi.ts` (`window.moqtDevTools`) は変えない。publisher モードでは Subscriber が 0 個になり、Subscriber の統計は空の配列を返す
- `DebugPanel` は、subscriber モードでは Copy for LLM の Publisher のボタンを隠す。publisher モードでは Subscriber が 0 個なので、Subscriber ごとのボタンは手を入れなくても出ない。All のボタンと `generateSettingsText` の出力は変えない (診断用の出力であり、隠した設定の signal を変えない方針とそろえる)
- E2E で表示の有無を確かめるため、`PublisherPanel` / `SubscriberPanel` のルート、Add Subscriber ボタン、Codec の `<select>`、Video Settings / Audio Settings / Publish Settings / Subscribe Settings の各節、ヘッダーの副題、`DebugPanel` の Publisher のボタンに `data-testid` を足す (名前は既存の `settings-jitter-buffer` / `publisher-publish-button` などに合わせる)
- 対象外
  - 役割ごとの URL をコピーするボタンなど、今のページと別の役割の URL を作る UI
  - `catalogSubscriptionTimeout` と `useDedicatedWorker` が `buildQueryString` に載らず、Copy URL や再読み込みで消える件 (このモードの有無と関係なく起きる既存の抜けのため、別の issue で扱う)
  - ページのタイトル (`<title>`) をモードに合わせて変えること

## 完了条件

- `?mode=publisher` で Publisher のパネルと Publisher が使う設定だけが表示され、Subscriber は 1 つも作られない
- `?mode=subscriber` で Subscriber のパネル、Add Subscriber ボタン、Subscriber が使う設定だけが表示され、`DebugPanel` の Publisher のボタンも出ない
- `mode` が無い URL と許可リストに無い値 (例: `?mode=foo`) では従来どおり両方が表示される
- どのモードでも共通の設定が表示され、ヘッダーの副題が設計方針に書いた文字列になる (E2E で文字列を確かめる)
- Copy URL で `publisher` / `subscriber` の `mode` が保たれ、`both` では `mode` が載らない
- `devtools/src/signals/connectionSettings.test.ts` で `initFromUrl` と `buildQueryString` の往復、許可リストに無い値の無視、`both` を URL に載せないことが確かめられる
- E2E (`tests/e2e/devtools-mode.spec.ts` を想定) でモードごとの表示の有無が確かめられる。実リレーは使わない UI テストとする
- `CHANGES.md` の `## develop` に moqt-devtools の `mode` の追加が `[ADD]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- `devtools/src/App.tsx` の `App` / `devtools/src/main.tsx`
- `devtools/src/components/ConnectionSettings.tsx` の `ConnectionSettings`
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` / `buildQueryString` / `AUDIO_SOURCES` / `isAudioSourceType`
- `devtools/src/hooks/useCopyUrlButton.ts` の `useCopyUrlButton`
- `devtools/src/components/DebugPanel.tsx` の `DebugPanel` / `generateSettingsText`
- `tests/e2e/devtools-audio.spec.ts` (URL クエリの往復を UI で確かめる既存の E2E)

## 解決方法

{未着手}
