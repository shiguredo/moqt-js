# moqt-devtools の publisher で、配信を始めている途中でも Publish と Preview を押せる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-publisher-buttons-while-starting
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の publisher は、Publish を押してから映像トラックの PUBLISH が確立するまでの間 (接続、catalog の publish、映像ストリームの取得、映像トラックの publish)、Publish と Preview のボタンを押せる。Publish を重ねて押すと `startPublishing` が並行して走り、session が 2 つ作られる。Preview を押すと、プレビュー中なら配信が流用しようとしている映像ストリームを解放して表示を「Ready to publish」に戻し、プレビュー中でなければ開始の途中にプレビューを始める。

closed の `0730-bug-devtools-settings-enabled-while-starting.md` で、配信を始めている途中を表す `pub.isStarting` ができたので、これを使ってボタンを押せなくする。

## 現状

- `devtools/src/components/PublisherPanel.tsx` のボタンの判定
  - `isPublishing = pub.publisher.value !== null`
  - `previewBtnDisabled = isPublishing || isStopping`
  - `publishBtnDisabled = isPublishing || isStopping`
  - `stopBtnDisabled = !isPublishing || isStopping`
- `devtools/src/hooks/usePublisher.ts` の `startPublishing` は、最初に `pub.isStarting` を立て、映像トラックの `session.publish` が返ったとき (`markVideoPublisherEstablished` で `pub.publisher` を設定する) に下ろす。その間 `pub.publisher` は null なので、Publish と Preview は押せ、Stop は押せない
- `startPublishing` には、開始の途中に再び呼ばれたときの防ぎが無い。2 回目の呼び出しは新しい `connect` を始め、`pub.pubSession` を上書きする。先の回の session は閉じられずに残る
- `togglePreview` は、プレビュー中なら `stopPreview` を、そうでなければ `startPreview` を呼ぶ。開始の途中でも呼べる
  - `stopPreview` は映像ストリーム (`pub.mediaStream`) を解放し、表示を「Ready to publish」に、`pubStatus` を `disconnected` にする。`startPublishing` は、映像ストリームを取る時点で `pub.isPreviewActive` が立っていれば、プレビューの映像を流用する (`hadPreview`)。プレビューを止めるのはその後 (`pub.isPreviewActive = false`) である
  - `startPreview` は映像ストリームを取って `pub.mediaStream` を上書きし、表示を「Preview: ...」にする
- Subscriber 側は closed の `0727-bug-devtools-subscriber-stop-disabled-while-connecting.md` で、確立を待っている間は購読中として扱い、Start Subscribing を押せなくした (`devtools/src/utils/subscriberControls.ts` の `subscriberControlState`)

## 再現手順

コードの経路で確かめた。実際の relay での再現はまだ行っていない。

1. Publisher の Publish を押す
2. 映像トラックの PUBLISH が確立する前 (表示が「Connecting...」や「Connected, publishing catalog...」の間) に、もう一度 Publish を押す
3. `startPublishing` が 2 回走り、2 つ目の `connect` が `pub.pubSession` を上書きする。1 つ目の session は閉じられない
4. 別の経路: プレビュー中に Publish を押し、確立する前に Preview を押す。プレビューが止まって映像ストリームが解放され、表示が「Ready to publish」に戻る。プレビュー中でなければ、Preview で開始の途中にプレビューが始まる

## 設計方針

- Publisher のボタンの可否を、Subscriber 側の `subscriberControlState` と同じく純粋な関数にまとめる
  - 配信中は、確立済み (`pub.publisher` が null でない) か、配信を始めている途中 (`pub.isStarting`) とする
  - 配信中と停止処理の間は、Publish と Preview を押せない
  - Stop は、確立済みのときだけ押せる (開始の途中の Stop は扱わない。対象外)
- `startPublishing` の冒頭で、開始の途中なら何もしないで戻る防ぎも入れる (ボタンを押せなくしても、テスト用 API などの別の経路から呼ばれうるため)
- 判定の関数は単体テストで入力の組み合わせを固定する
- 対象外
  - 開始の途中の Stop (接続待ちを止める)。止める処理が `startPublishing` の途中の中断を扱っていないため、別の issue で扱う
  - 停止した配信のコールバックが次の配信を後始末する問題 (`0738`)

## 完了条件

- 配信を始めている途中は、Publish と Preview を押せない
- 開始の途中に `startPublishing` を呼んでも、2 つ目の開始は走らない
- ボタンの可否の関数の入力の組み合わせを単体テストで固定する
- `CHANGES.md` の `## develop` に `[FIX]` で載る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- closed の `0727-bug-devtools-subscriber-stop-disabled-while-connecting.md` (Subscriber 側のボタンの可否)
- closed の `0730-bug-devtools-settings-enabled-while-starting.md` (`pub.isStarting` を足した)
- `devtools/src/components/PublisherPanel.tsx` のボタンの判定
- `devtools/src/hooks/usePublisher.ts` の `startPublishing` / `togglePreview` / `stopPreview`
- `devtools/src/utils/subscriberControls.ts` の `subscriberControlState`

## 解決方法

{未着手}
