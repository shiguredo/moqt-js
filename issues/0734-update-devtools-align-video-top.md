# moqt-devtools の Publisher と Subscriber の映像の上端がそろわず、並べて見づらい

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-devtools-align-video-top
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

moqt-devtools は Publisher と Subscriber のパネルを横に並べる (`lg:grid-cols-2`)。映像より上の項目の高さが 2 つのパネルで違うため、映像の上端がそろわない。利用者から「publisher subscribe の映像の並びの高さは同じにして欲しい。ずれてると見づらい」と要望があった。

## 現状

- `devtools/src/components/PublisherPanel.tsx` の映像より上は、状態のメッセージ、Forward State の行 (配信中だけ)、ボタンの順に並ぶ
- `devtools/src/components/SubscriberPanel.tsx` の映像より上は、状態のメッセージ、NEW_GROUP_REQUEST の行、ボタンの順に並ぶ。NEW_GROUP_REQUEST の行と Forward State の行は高さが違う

実測 (2026-09-25、横幅 1440 px、Subscriber の映像の枠の上端 - Publisher の映像の枠の上端):

| 状態                  | ずれ                    |
| --------------------- | ----------------------- |
| 何もしていない        | 36 px (Subscriber が下) |
| 配信中 (購読の前と後) | -16 px (Publisher が下) |

## 設計方針

- 両パネルの映像より上を同じ構成にする。状態のメッセージの行、1 行の項目の行 (Publisher は Forward State、Subscriber は NEW_GROUP_REQUEST)、ボタンの行を、同じ高さにそろえる
- 1 行の項目の行は同じ高さの枠 (同じクラス) で描く
- 見出し (パネル名とバッジ、Subscriber の削除のボタン) の高さもそろえる
- 状態によって項目が出たり消えたりしないことは 0732 で直す。この issue は 0732 の後に行う

## 完了条件

- Playwright の E2E で、Publisher と Subscriber の映像の枠の上端の位置が一致することを確かめる (Subscriber を 2 つにして削除のボタンが出た状態も含む)
- 実リレーを使う確認として、手元の relay で配信と購読をした状態でも一致することを確かめる
- `vp check` / `tsc --noEmit` / `vp test run` / Playwright の E2E が通る
