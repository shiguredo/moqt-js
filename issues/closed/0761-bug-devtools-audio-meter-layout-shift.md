# moqt-devtools の音声レベルメーターの見出し行が、値の桁数と voice activity で動く

- Created: 2026-09-25
- Completed: 2026-09-26
- Branch: feature/fix-devtools-audio-meter-layout-shift
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の音声レベルメーターは、音声を受けると peak / RMS (dBFS) と LOC Audio Level (-dBov)、voice activity を出す。この 4 つの値は Object ごとに変わり、そのたびに値の文字数が変わる。文字数が変わると、右寄せで並べた見出し行の項目がすべて左右に動き、幅によっては行の折り返しも変わってメーターの高さまで変わる。話している間ずっと値が変わるため、メーターの下の項目 (Catalog や Statistics) も含めて画面が揺れ続ける。

利用者から「Audio のところが voice の on/off で動いて気持ち悪い、ちゃんと固定して」と指摘されている。`0747-bug-devtools-device-field-height-shift.md` と同じく、状態で項目の位置が動かないようにする。

## 現状

- `devtools/src/components/AudioMeter.tsx` の `AudioMeter` の見出し行は、外側を `flex flex-wrap items-center justify-between`、値の並びを `flex flex-wrap items-center gap-3` で描く。値は幅を持たないため、文字数が変わると並び全体の幅が変わる
- 値の並びは外側の `justify-between` で右端に寄せるため、幅が変わると並び全体の左端が動き、その左にある項目 (peak / rms / LOC Audio Level のラベルと値) も一緒に動く
- voice activity は `voice: off` (10 文字) と `voice: on` (9 文字) で 1 文字分 (実測 7.2 px) 変わる。切り替わるたびに並び全体が 7.2 px 動く
- 実測 (2026-09-25、Chromium、横幅 1440 px、subscriber のメーター。値の signal を書き換えて測った)
  - `voice: off` のときの値の左端: peak 871 px / rms 980 px / LOC Audio Level 1169 px
  - `voice: on` にすると peak 878 px / rms 987 px / LOC Audio Level 1176 px (すべて +7 px 動く)
  - peak / rms を `-6.0 dBFS` (9 文字) から `-100.0 dBFS` (11 文字) にすると、peak は 900 px から 849 px へ 51 px 動く
- 値が無いときの文字列も長い。`not measured` (12 文字) と `not reported` (12 文字) は `-100.0 dBFS` (11 文字) より長く、これらが出ると見出し行が折り返す
  - 実測 (同じ条件): 値がすべて `-` のときの見出し行は 16 px、`-127 dBov` などが入っても 16 px、`not measured` / `not reported` になると 40 px になり、メーター全体が 146 px から 170 px へ 24 px 伸びる
  - 折り返しの位置は幅だけで決まるため、値の文字数が変わると折り返しの位置も変わる (横幅 390 px では 68 px まで伸びた)
- ラベルと値も別々の flex の項目であるため、折り返すと `LOC Audio Level` とその値が別の行に分かれる

## 再現手順

1. devtools を開く (Publisher と Subscriber の両方を表示する既定のモード)
2. `window.moqtDevTools` ではなく画面を見ながら、音声を配信して subscriber で受ける (実リレーが必要)。または Playwright で `subscriberInstances` の signal (`audioPeakDbfs` / `audioRmsDbfs` / `audioLastLevel`) を書き換える
3. voice activity が on と off で切り替わると、Audio の行の項目が左右に動く
4. `not reported` (LOC Audio Level が載っていない Object) や `not measured` になると、行が折り返してメーターが縦に伸び、下の Catalog と Statistics が下へ動く

## 設計方針

- 見出し行の項目を、値の文字数によらず幅が一定になるようにする
  - ラベルと値を 1 つの flex の項目にまとめ、`whitespace-nowrap` で分かれないようにする
  - 値は `font-mono` の桁数 (`ch`) で固定の幅にし、`tabular-nums` を付ける。値が変わっても項目の幅は変わらない
  - 幅は、実際に出うる最も長い文字列に合わせる (`-100.0 dBFS` は 11 ch、`not reported` は 12 ch、`voice: off` は 10 ch、無いときの `-` は 1 ch)
- 値の文字列を短くする。位置を固定するには、最も長い文字列に幅を合わせる必要がある。`0627-add-devtools-audio-visualization.md` が定めた `not reported` (LOC Audio Level が載っていない Object) は残し、次の 2 つを見直す
  - peak / RMS の `not measured` は `-` にする。音を受けているがまだ復号していない間の表示であり、音を受けていない間の `-` と同じ意味である
  - voice activity の `not reported` は `-` にする。LOC Audio Level が載っていないことは同じ行の LOC Audio Level の欄が `not reported` と出すため、同じ状態を 2 度出さない (`voice` の欄は値が `on` / `off` の 3 ch に収まる)
- voice activity のラベルを値から分ける (表示は今と同じ `voice` + `on` / `off`)。値を 3 ch に収め、行が 546 px の幅に 1 行で収まるようにする
- 横幅が足りないときの折り返しは `flex-wrap` に任せる。項目の幅が一定になるため、折り返しの位置も値によらず一定になる

## 完了条件

- voice activity を on と off で切り替えても、peak / RMS / LOC Audio Level / voice の項目の位置が変わらない
- peak / RMS の値が `-100.0 dBFS` と `-6.0 dBFS`、LOC Audio Level が `-127 dBov` と `not reported` の間で変わっても、項目の位置とメーターの高さが変わらない
- 横幅 1440 px で、Audio の見出し行が今と同じ 1 行に収まる
- `tests/e2e/devtools-audio-meter.spec.ts` に、値の変化で項目の位置とメーターの高さが変わらないことを確かめるテストを足す
- `npx vp check` / `npx vp test --run` / 既存の E2E (`npx vp run e2e-test`) が通る

## 参照

- `devtools/src/components/AudioMeter.tsx` の `AudioMeter` (見出し行の値とラベル)
- `devtools/src/utils/audioLevel.ts` の `formatDbfs` / `formatAudioLevel` / `formatVoiceActivity`
- draft-ietf-moq-loc-04 §2.3.3.2 (Audio Level: RFC 6464 §3 の -dBov と voice activity を vi64 の最下位 8 bit に符号化する)
- RFC 6464 §3 (level は -dBov で、0〜127 が 0〜-127 dBov。デジタル無音は 127。V ビットが voice activity)

## 解決方法

- `devtools/src/components/AudioMeter.tsx` の `AudioMeter` で、ラベルと値を `METER_FIELD_CLASS` (`whitespace-nowrap`) の 1 項目にし、値は `font-mono` と `tabular-nums` で幅を固定した。peak / RMS は 11 ch (`-100.0 dBFS`)、LOC Audio Level は 12 ch (`not reported`)、voice は 3 ch (`off`)
- `devtools/src/utils/audioLevel.ts` の `formatDbfs` は数値を `-100.0` の幅まで左に空白で埋め、小数点の位置を固定する。`formatAudioLevel` の数値も同じように埋める。peak / RMS の未計測と voice の未報告は `-` にし、LOC Audio Level が載っていない object は `not reported` のままにする。voice の `on` は末尾を空白にして `off` と同じ 3 文字にする
- 見出しの値は 11 px にする。12 px のままでは、UI フォントが Inter より広い環境で見出し行が折り返し、下の Catalog と Statistics が動く
- `tests/e2e/devtools-audio-meter.spec.ts` で、voice の on / off、`-100.0 dBFS` と `0.0 dBFS`、`-127 dBov` と `not reported` の間で項目の位置とメーターの高さが変わらないことを確かめた。CI の e2e が通った
