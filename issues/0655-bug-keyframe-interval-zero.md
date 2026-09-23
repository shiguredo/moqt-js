# keyframeInterval の値域が検証されず 0 でキーフレームを要求しなくなる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-keyframe-interval-zero
- Polished: 2026-09-21

## 目的

`src/createMediaPublisher.ts` の `shouldSendKeyFrame` はフレーム番号の剰余でキーフレームを判定するため、`keyframeInterval: 0` では `frameCount % 0` が NaN になり常に false になる。周期キーフレームを一度も要求しなくなり、フレーム番号を 0 に戻すだけの `requestKeyframe()` も効かない。値域検証が無いため、負値は絶対値と同じ判定、非整数は端数の一致で true、NaN は 0 と同じく一度も true にならず、±Infinity は先頭のみ true という意図しない挙動になる。

壊れるのはキーフレームの要求側である。WebCodecs の `keyFrame: false` は「キーフレームにするかどうかは UA が判断する」意味なので、実際にキーフレームが出るかは断定できない。

再現は `examples/high-level-api` の数値入力 (`min="1"`) を空にして発行する経路で起きる。`Number("")` が 0 になり、そのまま `keyframeInterval` として渡る。

## 現状

- `src/createMediaPublisher.ts` の `shouldSendKeyFrame` は `frameCount % keyframeInterval === 0` を返す
- `src/createMediaPublisher.ts` の `resolveKeyframeInterval` は `video?.keyframeInterval ?? framerate * 2` を返すだけで値域を検証しない。`MediaPublisherImpl` のコンストラクタから呼ばれる
- `src/createMediaPublisher.ts` の `requestKeyframe` は `videoFrameCount` を 0 に戻すだけである
- `src/createMedia/settings.ts` の `resolveVideoPublishSettings` は `keyframeInterval` を解決しない。Catalog にも載らず (draft-ietf-moq-msf-01 §5.2.24 の `maxGopDuration` はミリ秒指定で別物)、映像ループが読む正本はコンストラクタで解決した `this.keyframeInterval` だけである
- `src/codec/types.ts` の `VideoPublishOptions.keyframeInterval` にはコメントが無く、値域の記述も無い
- `docs/HIGH_LEVEL_API.md` は `keyframeInterval?: number; // default: framerate * 2` とだけ書いている
- `src/createMediaPublisher.test.ts` に `resolveKeyframeInterval` と `shouldSendKeyFrame` のテストがあるが、0 / 負値 / 非整数 / NaN / Infinity は扱っていない
- 同型の剰余が devtools に 2 箇所ある (`devtools/src/hooks/usePublisher.ts` の `shouldRequestKeyFrame` と `devtools/src/webcodecs-devtools/signals.ts` のインライン剰余)。devtools は数値入力の `Number("")` が 0 になる経路で 0 が入り得る (クエリパラメータからの復元は `if (parsed)` で 0 を弾く)

## 設計方針

- `keyframeInterval` は「1 以上の整数」だけを受理し、0 / 負値 / 非整数 / NaN / Infinity / -Infinity は Error を throw する (メッセージに受け取った値を含める)。0 に特別な意味を持たせる根拠が MSF / LOC / WebCodecs に無く、0 を「毎フレームキーフレーム」と解釈すると帯域を大きく浪費する。空入力 (`Number("")` が 0) の事故経路もある
- 解決後の値も検証する。`keyframeInterval` を指定しない場合の既定値は `framerate * 2` なので、1 未満または非有限 (`framerate: 0` / 負値 / `NaN` / `±Infinity`) なら throw する。整数であることは求めない (`framerate: 29.97` の 59.94 は有効な間隔)
- 検証は `resolveKeyframeInterval` に置く。`MediaPublisherImpl` のコンストラクタから呼ばれるため `createMediaPublisher()` の時点で reject する。`resolveVideoPublishSettings` は触らない (`start()` の途中で throw すると `onError` が呼ばれない位置になる)
- `shouldSendKeyFrame` の実装は変えず、JSDoc に前提 (`keyframeInterval` は 1 以上) を書く。`requestKeyframe()` も変えない (間隔が 1 以上のときは `videoFrameCount` を 0 に戻すことで次のフレームがキーフレームになる)
- `src/codec/types.ts` の `VideoPublishOptions.keyframeInterval` に、同ファイルの他のフィールドと同じ `//` 形式のコメントで値域 (1 以上の整数)、既定値 (`framerate * 2`、既定 framerate は 30)、無効値は `createMediaPublisher()` が throw することを書く
- `docs/HIGH_LEVEL_API.md` の該当行も同じ内容に更新する
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)
- 対象は `src` と `docs` と `CHANGES.md` とする。devtools の同型 2 箇所は独自の signal とクエリパラメータ由来の値で `resolveKeyframeInterval` を通らないため 0676 で扱う。`examples` も変更しない (無効値はライブラリが明示的に失敗するため)
- 対象外: `processVideoFrames` がキーフレーム判定のあとにキュー超過でフレームを破棄しても `videoFrameCount` を進めるため要求が失われる件は、0680 で扱う

## 完了条件

- 0 / -5 / 1.5 / NaN / Infinity / -Infinity を渡すと `createMediaPublisher()` が `Error` で reject し、メッセージに受け取った値が含まれる
- `keyframeInterval` を指定せず `framerate: 0` / 負値 / `NaN` / `Infinity` / `-Infinity` を渡した場合も、解決後の値が 1 未満または非有限になるため reject する
- 1 と 60 は受理される。`shouldSendKeyFrame` は 1 と 60 のどちらでも frameCount 0 で true、1 では frameCount 1 でも true、60 では frameCount 1 で false になる
- `framerate` 由来の既定値は整数を要求されず、`framerate` 未指定なら 60、`framerate: 29.97` なら 59.94 を返す
- `requestKeyframe()` が間隔 1 以上で次のフレームをキーフレームにする既存の挙動が変わらない
- `src/createMediaPublisher.test.ts` の `resolveKeyframeInterval` / `shouldSendKeyFrame` のテストが拡張され、拒否する 6 値・拒否する `framerate` の 0 / 負値 / 非有限・受理する境界値・`framerate: 29.97` が固定される
- `src/codec/types.ts` のコメント、`docs/HIGH_LEVEL_API.md` の記述が実装と一致し、`shouldSendKeyFrame` の JSDoc に前提 (`keyframeInterval` は 1 以上) が書かれている
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- WebCodecs の `VideoEncoderEncodeOptions.keyFrame` (https://w3c.github.io/webcodecs/#dom-videoencoderencodeoptions-keyframe)。false はキーフレーム禁止ではなく UA の判断に委ねる意味
- draft-ietf-moq-msf-01 §5.2.24 (`maxGopDuration`)。キーフレーム間隔そのものの定義は仕様に無い

## 解決方法

{未着手}
