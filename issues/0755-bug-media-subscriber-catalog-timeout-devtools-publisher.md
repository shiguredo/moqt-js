# createMediaSubscriber が moqt-devtools の publisher の catalog を受け取れず catalog receive timeout になる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-catalog-timeout
- Polished: 2026-09-28

## 目的

`examples/high-level-api` の受信 (`createMediaSubscriber`) で、手元の sora-moq の relay に moqt-devtools の publisher が配信しているトラックを購読すると、「catalog receive timeout」で止まる。高レベル API で受信できないと、利用者のアプリが moqt-devtools の配信を視聴できない。

moqt-devtools の publisher は、Forward State が 1 になったときに catalog を新しい Group で送り直す (closed の `0624`)。一方、ライブラリの publisher は catalog を送り直さないため、配信開始後に購読を始めた相手へ catalog が届かない (open の `0683`)。今回の再現は moqt-devtools の publisher が相手であり、`0683` と同じ説明では止まらない経路の疑いがある。ただし `0683` の追記のとおり、sora-moq の relay が prewarm などで Forward State を 1 に保つ場合や別の購読者が居続ける場合は Forward State が変わらず、moqt-devtools の publisher も catalog を送り直さず、`0683` と同じ停止になり得る。どちらの場合かを切り分ける。

## 現状

- 再現 (2026-09-25、手元の sora-moq の relay、Namespace `example`、トラック `video` / `audio`)
  1. moqt-devtools の publisher で、Namespace を `example` にして配信する (ダミー映像、ダミー音声)
  2. `examples/high-level-api` の Start Subscribe で購読する
  3. 5 秒後に「error: catalog receive timeout」になり、購読をやめる
- 同じ relay で moqt-devtools の subscriber は同じ配信を購読でき、catalog を受け取る
- `examples/high-level-api` 自身の `createMediaPublisher` で配信しても同じく止まる (こちらは `0683` で説明がつく)
- `src/createMediaSubscriber.ts` の `subscribeCatalog` は catalog トラックを Next Object の Location Filter で SUBSCRIBE し、`catalogFetchFilter` の範囲で FETCH する。moqt-devtools の subscriber (`devtools/src/hooks/useSubscriber.ts` の catalog 購読) は同じ組み合わせに加えて `rendezvousTimeout` を渡す。違いはまだ確かめていない
- コード上の差は `rendezvousTimeout` 以外にもある。ライブラリは FETCH フェーズ中は `tryResolveCatalog` が早期 return し、フェーズ終了 (`finishCatalogFetchPhase`) まで catalog を resolve しないのに対し、devtools は最初の完全な catalog の適用で resolve する。また、SUBSCRIBE_OK 前に REQUEST_ERROR を受けるとどちらも即時失敗になる (`src/session/requests.ts` の `requestsSubscribe`) ため、「catalog receive timeout」は SUBSCRIBE_OK を受けたうえで 5 秒以内に catalog の Object が届かなかったことを示す

## 設計方針

- relay とライブラリの両方のログで、catalog の SUBSCRIBE / FETCH と、publisher の catalog の送り直し (Forward State の変化) の順を追い、どこで catalog が届かなくなるかを確かめる
- ライブラリと devtools の catalog 購読の差 (現状の最後) が、届く / 届かないの違いと対応するかを確かめる
- 原因がライブラリにあれば直し、relay にあれば sora-moq の issue にする

## 完了条件

- 原因がライブラリ側か relay 側かが判明している。ライブラリ側なら修正し、relay 側なら sora-moq の issue を起票して、原因と確認手順を本 issue に残す
- 上の再現手順で、`createMediaSubscriber` が catalog を受け取り、映像と音声の購読を始める (relay 側が原因の場合は、sora-moq 側の修正後に同じ手順で確認してから closed にする)
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
