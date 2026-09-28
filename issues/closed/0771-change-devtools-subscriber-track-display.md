# moqt-devtools の subscriber の Subscribed 表示を publisher と同じ Full Track Name の規則に揃える

- Created: 2026-09-29
- Completed: 2026-09-29
- Branch: feature/fix-devtools-track-status-display
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools の subscriber の `Subscribed:` 表示は、映像と音声の購読が確立していても映像トラックの名前しか出さず、音声トラックの購読が確立したことを表示から確認できない。また、namespace と track name を `/` で連結しているため、表示からは namespace のフィールド境界と track name の境界が読めない。publisher の `Publishing:` 表示 (`0770-bug-devtools-publisher-track-display.md` で対応) と同じく、確立したメディアトラックをすべて §8.8 の形式で出すようにする。

根拠:

- 利用者からの報告: 配信側の `Publishing:` 表示と同じ `/` 連結の表記が subscriber にもある
- draft-ietf-moq-transport-21 §8.8 (Representing Namespace and Track Names) が RECOMMENDED とする表記、およびそれを namespace-name 文字列として使う draft-ietf-moq-msf-01 §11.1.2

## 現状

- `devtools/src/hooks/useSubscriber.ts` の `subscribeAudioOnly` と `startSubscribing` が `Subscribed: ${namespaceArray.join("/")}/${...}` を `instance.statusMessage` に設定する (音声のみの購読、映像トラックの確立、音声トラックの確立後、音声の購読失敗時の 4 か所)
- 映像 + 音声の購読では、音声トラックの購読が確立した後も映像トラックの名前 (`actualTrackName`) のままで、音声トラックの名前が出ない
- 音声のみの購読 (`subscribeAudioOnly`) は音声トラックの名前を出すが、表記は `/` 連結のまま

## 設計方針

- `0770` で追加する `src/fullTrackName.ts` の `formatFullTrackName` と、`devtools/src/utils/` のステータスメッセージを組み立てる純関数 (`Subscribed` ラベルにも使える形にする) を使う
- `subscribeAudioOnly` は音声トラックの Full Track Name だけを並べる
- `startSubscribing` は、映像トラックの確立時点では映像トラックだけ、音声トラックの確立後は audio → video の順で両方、音声の購読に失敗したときは映像トラックだけを並べる (Catalog と Tracks カードの並びに揃える)
- ステータスメッセージの文言以外 (status / isStarting / 後始末) は変えない

## 完了条件

- 映像 + 音声の購読で、ステータスが `Subscribed: room-123--audio, room-123--video` のように audio と video の両方の Full Track Name を示す
- 音声のみの購読では音声トラックだけ、映像のみの購読と音声の購読失敗時は映像トラックだけを示す
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

- `devtools/src/hooks/useSubscriber.ts` の `Subscribed:` の設定 4 か所を、`devtools/src/utils/trackStatusMessage.ts` の `buildMediaTrackStatusMessage` に置き換えた。表記は publisher と同じ draft-ietf-moq-transport-21 §8.8 の形式になる
- `subscribeAudioOnly` は音声トラックだけ、`startSubscribing` は映像トラックの確立時と音声の購読に失敗したときに映像トラックだけ、音声の購読が確立したら audio → video の順で両方を並べる
