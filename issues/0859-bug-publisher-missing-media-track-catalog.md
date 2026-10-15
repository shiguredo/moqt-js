# audio / video を指定しても MediaStream にトラックが無いと catalog に宣言だけが残る

- Created: 2026-10-14
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publisher-missing-media-track-catalog

## 目的

`createMediaPublisher` に `audio` / `video` を指定したのに、`start()` へ渡す `MediaStream` にそのトラックが含まれていない場合、`start()` は成功して `"publishing"` になり、catalog にはそのトラックが宣言されるが Object は 1 件も送られない。購読側は宣言だけを見てトラックを購読し、音声 / 映像が届くのを待ち続ける (受信タイムアウトまで気付けない)。宣言と実際に流れるトラックを一致させる。

## 現状

- `src/createMediaPublisher.ts` の `prepareAudioFrameSource` は、`MediaStream.getAudioTracks()[0]` が無い場合に何もせず早期 return する (音声トラックが無いことは失敗として扱わない)
- `src/createMediaPublisher.ts` の `createCatalogTracks` は、`resolvedAudio` が非 null なら音声トラックを宣言する (トラックの有無を見ない)。映像は `resolvedVideo` と `this.mediaStream` だけを見て宣言し、映像トラックの有無は見ない
- `src/createMediaPublisher.ts` の `setupEncoders` は、音声は読み出しの reader が無いためエンコーダーを作らず、映像もトラックが無ければ作らない。そのため Object を送る経路が無いまま `"publishing"` に進む
- `docs/HIGH_LEVEL_API.md` には「`audio` / `video` を指定した場合、そのトラックを含む `MediaStream` を `start()` に渡すこと。含まれないトラックは catalog に宣言されるが Object は送られない」と、この挙動を契約として明記している (0858 の修正で追記した)
- devtools の `prepareAudioForPublishing` は逆の判断で、音声を取れない場合は catalog に音声トラックを載せず映像だけを配信する (「Catalog だけ音声トラックを広告すると、購読側は object が来ないまま待ち続ける」と明記している)
- 映像にも同じ形の穴がある (`createCatalogTracks` の映像トラックの宣言はトラックの有無を見ない)

## 設計方針

宣言と実際の配信を一致させる。どちらを採るかは実装時に決める。

- start を失敗させる: `prepareAudioFrameSource` のトラック無し分岐 (映像は `setupEncoders` の相当箇所) で throw し、catalog を送る前に `start()` を失敗させる。0858 で入れた「音声トラックを宣言した catalog を送った後に object が出せない状態を作らない」という方針と揃う
- catalog に載せない: `createCatalogTracks` が実際のトラックの有無を見て、無いトラックは宣言しない。devtools と同じ判断になる。`publishCatalog` を直接駆動する既存の単体テストは `mediaStream` を持たないため、こちらの案はテストの前提も見直す

いずれの場合も `docs/HIGH_LEVEL_API.md` の契約の記述を実装に合わせる。呼び出し側がトラックを外した場合 (start の途中の `removeTrack`) の扱いも決める。

## 完了条件

- `audio` / `video` を指定して該当トラックの無い `MediaStream` を渡したとき、catalog に宣言だけが残る状態にならないこと (start が catalog を送る前に失敗する、または宣言されない)
- 上記を固定する単体テストが `src/createMediaPublisher.test.ts` にあること
- `docs/HIGH_LEVEL_API.md` の記述と実装が一致すること
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 参照

- `src/createMediaPublisher.ts` の `MediaPublisherImpl.start` / `prepareAudioFrameSource` / `createCatalogTracks` / `setupEncoders`
- `docs/HIGH_LEVEL_API.md` の `audio` / `video` の契約の段落
- `devtools/src/hooks/usePublisher.ts` の `prepareAudioForPublishing`
- `issues/closed/0858-bug-publisher-audio-capture-format.md` (この穴を残した判断の記録)
