# README の moqt-devtools の説明に表示モード (Publisher / Subscriber) を追記する

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-readme-devtools-mode
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools に URL クエリ `mode` で Publisher だけ / Subscriber だけを表示する機能を追加したが、README の moqt-devtools の機能一覧に表示モードの記載が無い。オンライン版を開いた利用者が、片方だけのページを接続設定ごと開いて別のマシンへ渡せることに気づけない。

## 現状

- README.md の `### moqt-devtools` の機能一覧には「Publisher / Subscriber 両方の動作確認」「設定を URL クエリパラメータで共有」がある
- `mode` による表示モードの切り替えと、ヘッダーの副題のリンクから他のモードのページを今の接続設定のまま新しいタブで開けることが書かれていない

## 設計方針

- README.md の `### moqt-devtools` の機能一覧に、表示モードの項目を追加する
  - URL クエリ `mode` で Publisher だけ / Subscriber だけを表示できること
  - ヘッダーの副題のリンクから他のモードのページを今の接続設定のまま新しいタブで開けること
- 並びは既存の「Publisher / Subscriber 両方の動作確認」の近くにする

## 完了条件

- README.md の moqt-devtools の機能一覧に表示モードの記載がある
