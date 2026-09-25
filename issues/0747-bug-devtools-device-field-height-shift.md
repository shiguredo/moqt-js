# moqt-devtools の接続設定で、デバイスの一覧を取ると設定の並びが 1 px 動く

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-devtools-device-field-height-shift
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の接続設定の Camera Device と Audio Device の欄は、一覧を取る前は Fetch Devices のボタン、取った後は select を描く。ボタンと select の高さが違うため、Fetch Devices を押すと Video Settings と Audio Settings の行の高さが変わり、下の項目 (Publisher と Subscriber のパネルを含む) の位置が動く。利用者から、状態で項目の位置が動くのは使いづらいと指摘されている (「動きがあるのキモい」)。closed の `0742-update-devtools-camera-device-always-visible.md` の設計方針 (ボタンと select を同じ高さで描く) も満たせていなかった。

## 現状

- `devtools/src/components/ConnectionSettings.tsx` の Camera Device と Audio Device の欄は、一覧が無いときは `button` (`px-3 py-2 text-sm border`)、あるときは `select` (同じ padding と border) を描く
- 実測 (2026-09-25、Chromium、横幅 1440 px): ボタンは 38 px、select は 37 px。同じ行の他の select (Resolution など) も 37 px。Fetch Devices を押すと Video Settings と Audio Settings の grid がそれぞれ 131 px から 130 px になる

## 再現手順

1. `?videoSource=camera&audioSource=microphone` で devtools を開く (一覧はまだ取っていない)
2. Camera Device と Audio Device の Fetch Devices を押す
3. ボタンが select に替わり、2 つの grid がそれぞれ 1 px 縮んで、下の項目が上へ動く

## 設計方針

- デバイスの欄を縦の flex にし、ボタンと select を行の高さいっぱいに伸ばす (`flex-1`)。ボタンと select 自身の高さは行の高さに加えない (flex-basis 0)。同じ行の他の select が行の高さを決める
- 行に他の項目が無くなっても潰れないよう、最小の高さ (`min-h-9`) を付ける

## 完了条件

- Fetch Devices を押す前と後で、Video Settings と Audio Settings の grid の高さが変わらず、ボタンと select の高さが同じ行の他の select と同じになる
- `vp check` / `tsc --noEmit` / `vp test run` / 既存の Playwright の E2E が通る

## 解決方法

- `devtools/src/components/ConnectionSettings.tsx` の Camera Device と Audio Device の欄を縦の flex (`flex flex-col`) にし、Fetch Devices のボタンと select に `DEVICE_CONTROL_SIZE_CLASS` (`flex-1 basis-0 min-h-9`) を付けた。ボタンと select は行の高さいっぱいに伸び、自身の高さは行の高さに加えない。行の高さは同じ行の他の select が決める
  - Tailwind の `flex-1` の flex-basis は 0% で、高さの決まっていない列の flex では中身の高さとして扱われ得るため、`basis-0` で 0 にする
- 手元の devtools (Chromium の偽のデバイス) で、Fetch Devices を押す前と後の grid の高さとボタン / select の高さを測った

| 横幅    | grid (押す前 / 後)                 | ボタン / select                | 同じ行の select |
| ------- | ---------------------------------- | ------------------------------ | --------------- |
| 1440 px | 130 px / 130 px (変更前 131 / 130) | 37 px / 37 px (変更前 38 / 37) | 37 px           |
| 390 px  | 203 px / 203 px                    | 37 px / 37 px                  | 37 px           |

- `vp check` / `tsc --noEmit` / `vp test run` (2807 件) / 既存の Playwright の E2E (40 件) が通った
