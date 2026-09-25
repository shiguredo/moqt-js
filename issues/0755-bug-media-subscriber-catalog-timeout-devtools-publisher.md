# createMediaSubscriber が moqt-devtools の publisher の catalog を受け取れず catalog receive timeout になる

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-catalog-timeout
- Polished: {YYYY-MM-DD}

## 目的

`examples/high-level-api` の受信 (`createMediaSubscriber`) で、手元の sora-moq の relay に moqt-devtools の publisher が配信しているトラックを購読すると、「catalog receive timeout」で止まる。moqt-devtools の publisher は、Forward State が 1 になったときに catalog を新しい Group で送り直す (closed の `0624`)。そのため、ライブラリの publisher が catalog を送り直さない件 (open の `0683`) とは別の理由で止まっている。高レベル API で受信できないと、利用者のアプリが moqt-devtools の配信を視聴できない。

## 現状

- 再現 (2026-09-25、手元の sora-moq の relay、Namespace `example`、トラック `video` / `audio`)
  1. moqt-devtools の publisher で、Namespace を `example` にして配信する (ダミー映像、ダミー音声)
  2. `examples/high-level-api` の Start Subscribe で購読する
  3. 5 秒後に「error: catalog receive timeout」になり、購読をやめる
- 同じ relay で moqt-devtools の subscriber は同じ配信を購読でき、catalog を受け取る
- `examples/high-level-api` 自身の `createMediaPublisher` で配信しても同じく止まる (こちらは `0683` で説明がつく)
- `src/createMediaSubscriber.ts` の `subscribeCatalog` は catalog トラックを Next Object の Location Filter で SUBSCRIBE し、`catalogFetchFilter` の範囲で FETCH する。moqt-devtools の subscriber (`devtools/src/hooks/useSubscriber.ts`) は同じ組み合わせに加えて `rendezvousTimeout` を渡す。違いはまだ確かめていない

## 設計方針

- relay とライブラリの両方のログで、catalog の SUBSCRIBE / FETCH と、publisher の catalog の送り直し (Forward State の変化) の順を追い、どこで catalog が届かなくなるかを確かめる
- 原因がライブラリにあれば直し、relay にあれば sora-moq の issue にする

## 完了条件

- 上の再現手順で、`createMediaSubscriber` が catalog を受け取り、映像と音声の購読を始める
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る
