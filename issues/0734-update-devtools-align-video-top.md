# moqt-devtools の Publisher と Subscriber の映像の上端がそろわず、並べて見づらい

- Created: 2026-09-25
- Completed: 2026-09-25
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

## 解決方法

- `devtools/src/components/panelLayout.ts` に、映像より上の 1 行の項目の枠のクラス (`PANEL_OPTION_ROW_CLASS`、高さ `h-9` で固定) を置いた。Publisher の Forward State の行と Subscriber の NEW_GROUP_REQUEST の行は、この枠で描く
- 見出しの高さは、Subscriber を 2 つにして削除のボタンが出た状態でも変わらないことを実測で確かめたため、変えていない
- 完了条件に書いた UI の E2E は、利用者の指示 (UI 系の E2E テストは一旦不要) により足していない。手元の relay と devtools で実測した (横幅 1440 px、Subscriber の映像の枠の上端 - Publisher の映像の枠の上端)

| 状態                              | 修正前 | 修正後 |
| --------------------------------- | ------ | ------ |
| 何もしていない                    | 36 px  | 0 px   |
| 配信中                            | -16 px | 0 px   |
| 配信と購読の最中                  | -16 px | 0 px   |
| Subscriber を 2 つにした (1 つ目) | 36 px  | 0 px   |

- `vp check` / `tsc --noEmit` / Playwright の E2E (40 件) が通った
