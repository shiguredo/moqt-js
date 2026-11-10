# audio / video を指定しても MediaStream にトラックが無いと catalog に宣言だけが残る

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-missing-media-track-catalog
- Polished: 2026-11-10

## 目的

`createMediaPublisher` に `audio` / `video` を指定したのに、`start()` へ渡す `MediaStream` にそのトラックが含まれていない場合、`start()` は成功して `"publishing"` になり、catalog にはそのトラックが宣言されるが Object は 1 件も送られない。購読側は宣言だけを見てトラックを購読し、音声 / 映像が届くのを待ち続ける (高レベル購読には media Object の受信タイムアウトが無く、待ちは終わらない)。指定した機能を黙って落とさず、宣言と実際に流れるトラックを一致させる。

## 現状

- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` は、接続 (`connectToServer`) → `assertAudioDeliverySupported` (reliable-only の判定) → `createPublishers` (`resolvedAudio` / `resolvedVideo` があれば PUBLISH する) → (`announceNamespace`) → `prepareAudioFrameSource` → `publishCatalog` → `setupEncoders` の順に進む
- `prepareAudioFrameSource` は、`MediaStream.getAudioTracks()[0]` が無い場合に何もせず早期 return する (音声トラックが無いことは失敗として扱わない)
- `createCatalogTracks` は、`resolvedAudio` が非 null なら音声トラックを宣言する (トラックの有無を見ない)。映像は `resolvedVideo` と `this.mediaStream` だけを見て宣言し、映像トラックの有無は見ない
- `setupEncoders` は、音声は読み出しの reader が無いためエンコーダーを作らず、映像は `this.mediaStream.getVideoTracks()[0]` を読み直し、トラックが無ければ作らない。そのため Object を送る経路が無いまま `"publishing"` に進む。映像トラックは入口の `resolveVideoPublishSettings(this.options.video, this.mediaStream.getVideoTracks()[0])` と `setupEncoders` の 2 回読んでおり、その間に呼び出し側が `removeTrack` すると、映像を宣言済みのまま映像エンコーダーが作られない
- この穴を「別に扱う」と明記した箇所が次にある (b8a1e863 で追加)
  - `assertAudioDeliverySupported` のトラック無しの分岐 (`if (this.mediaStream?.getAudioTracks().length === 0) { return; }`) とコメント「(catalog の宣言だけが残る既存の穴は別に扱う)」
  - `src/codec/types.ts` の `AudioDelivery` のコメント「音声トラックが無い場合はカタログの宣言だけが残る既知の穴は別に扱う。」
  - `docs/HIGH_LEVEL_API.md` の `delivery` オプションのコメント「ただし音声トラックを渡していない場合は拒否しない (catalog の宣言だけが残る既知の穴は別に扱う)」と、メソッド表の `start()` 行「音声トラックが無い場合は拒否しない。」
  - `src/createMediaPublisher.test.ts` のテスト「start: 音声トラックが無ければ reliable-only でも既定 datagram を拒否しない」(穴の挙動を `"publishing"` で固定している)
- `docs/HIGH_LEVEL_API.md` の `audio` / `video` の契約の段落は「`audio` / `video` を指定した場合、そのトラックを含む `MediaStream` を `start()` に渡すこと。含まれないトラックは catalog に宣言されるが Object は送られない (購読側は待ち続ける)。」と、この挙動を契約として明記している (0858 の修正で追記した)
- 高レベル API の既存コードは「指定した機能を黙って落とさない」で一貫している (`start` の告知のコメント「告知の失敗は start() の失敗にする (指定した機能を黙って落とさない)」、`prepareAudioFrameSource` のコメント「取り出し経路が無いブラウザでは音声を黙って諦めない」、`assertAudioDeliverySupported` の JSDoc「指定されたら明示的に拒否する」)。入口での拒否の先例として、`start` の空 namespace の検査 (「入口の拒否は onError を通知せず、mediaStream も保持しない」) がある
- devtools の `prepareAudioForPublishing` は、自分で取得したマイクの音声を取れない場合に音声トラックを PUBLISH も宣言もせず映像だけを配信する (アプリとしての判断)。符号化の確認に失敗した場合は配信開始を失敗させる。利用者からストリームを受け取るライブラリとは立場が違う
- 映像にも同じ形の穴がある (`createCatalogTracks` の映像トラックの宣言はトラックの有無を見ない)

## 設計方針

`start()` の入口で検査して失敗させる。catalog から外す案は採らない (`createPublishers` が先に PUBLISH するため、catalog から外しても Object の来ない PUBLISH が残るうえ、指定した機能を黙って落とすことになるため)。

- 検査の位置: `MediaPublisherImpl.start` の入口 (空 namespace の検査の後、`this.mediaStream = stream` と接続より前)。`options.audio` を指定していて `stream.getAudioTracks()[0]` が無い場合と、`options.video` を指定していて `stream.getVideoTracks()[0]` が無い場合に、欠けたトラックの種別を含む英語のメッセージで throw する。接続も PUBLISH もせず、state を変えず、onError も通知せず、mediaStream も保持しない (空 namespace の検査と同じ扱い)。トラックの有無の判定にセッションは要らないので、接続より前に置く
- トラックの参照の保持: 入口で取得した音声 / 映像のトラックの参照を保持し、`resolveVideoPublishSettings` / `prepareAudioFrameSource` / `setupEncoders` はその参照を使う (`this.mediaStream` から読み直さない)。入口より後の `removeTrack` / `addTrack` は配信に反映しない (`MediaStream.removeTrack` はトラックをストリームの集合から外すだけで終了させないため、保持した参照から読み続けられる)。保持した参照は `disposeAllResources` で `mediaStream` と同じ位置で切り離し、各関数の `mediaStream` の null ガード (解放の先行を検知して、それ以上リソースを作らない役目) は残す。差し替えるのはトラックの取得元だけである
- 入口の検査は接続より前に行うため、音声トラックが無い場合のエラーは reliable-only の判定 (`assertAudioDeliverySupported`) より先に出る。`assertAudioDeliverySupported` のトラック無しの分岐は削除し、コメントの「別に扱う」も削除する。入口の検査とトラック参照の保持により、音声を指定した配信は常に保持した音声トラックから送るため、トラック無しを理由に配送方式の判定を省く根拠が無くなる。この分岐は接続の後に `this.mediaStream` を読み直しており、残すと入口より後の `removeTrack` で reliable-only の判定を飛ばすことになる
- 0858 で入れた「音声トラックを宣言した catalog を送った後に object が出せない状態を作らない」方針と揃う

### 対象外

- devtools の挙動 (自分で取得したストリームについてのアプリの判断であり、変更しない)
- open の 0831 は同じ `assertAudioDeliverySupported` のコメントと、docs の `delivery` / `start()` 行を変更対象にしている (0831 の undefined の単体テストと、`AudioDelivery` / docs の `delivery` にある undefined の説明は b8a1e863 で入っている)。先に入った方に合わせて、もう一方の文言を調整する

## 完了条件

- `audio` / `video` を指定して該当トラックの無い `MediaStream` を渡すと、`start()` が接続の前に失敗し、catalog も PUBLISH も送らず、state は変わらず、onError も通知しないこと (音声だけ欠ける場合、映像だけ欠ける場合のそれぞれ)。上記を固定する単体テストが `src/createMediaPublisher.test.ts` にあること
- 入口より後に `removeTrack` されても、入口で保持したトラックで配信が進むこと (映像を宣言したまま映像エンコーダーが作られない状態にならないこと)
- 既存のテスト「start: 音声トラックが無ければ reliable-only でも既定 datagram を拒否しない」を、音声トラックが無ければ接続前に `start()` が失敗するテストに置き換えること
- `docs/HIGH_LEVEL_API.md` の `audio` / `video` の契約の段落、`delivery` オプションのコメント、メソッド表の `start()` 行と、`src/codec/types.ts` の `AudioDelivery` のコメント、`src/createMediaPublisher.ts` の `assertAudioDeliverySupported` のコメントが、新しい挙動と一致すること (「宣言だけが残る」「拒否しない」「別に扱う」の記述を残さない)
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` / `createPublishers` / `prepareAudioFrameSource` / `createCatalogTracks` / `setupEncoders` / `assertAudioDeliverySupported` / `resolveVideoPublishSettings`
- `src/codec/types.ts` の `AudioDelivery` / `MediaPublisher.start`
- `src/createMediaPublisher.test.ts` の「start: 音声トラックが無ければ reliable-only でも既定 datagram を拒否しない」と、`createStartConnectHarness` / `createAudioMediaStream` / `createVideoMediaStream`
- `docs/HIGH_LEVEL_API.md` の `audio` / `video` の契約の段落、`delivery` オプション、メソッド表の `start()` 行
- `devtools/src/hooks/usePublisher.ts` の `prepareAudioForPublishing`
- `issues/closed/0858-bug-publisher-audio-capture-format.md` (この穴を残した判断の記録)
- open の `issues/0831-change-datagram-unknown-reliability.md` (同じ箇所を変更する)
