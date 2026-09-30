# README の moqt-devtools の説明に表示モード (Publisher / Subscriber) を追記する

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/update-readme-devtools-mode
- Polished: 2026-09-30

## 目的

moqt-devtools に URL クエリ `mode` で Publisher だけ / Subscriber だけを表示する機能を追加したが、README の moqt-devtools の機能一覧の表示モードの項目には、URL クエリ `mode` で切り替えることと、ヘッダーの副題のリンクから他のモードのページを今の接続設定のまま新しいタブで開けることが書かれていない。オンライン版を開いた利用者が、片方だけのページを接続設定ごと開いて別のマシンへ渡せることに気づけない。

## 現状

- README.md の `### moqt-devtools` の機能一覧には「Publisher / Subscriber 両方の動作確認」「設定を URL クエリパラメータで共有」がある
- 機能一覧の末尾付近に「表示モード (Publisher のみ / Subscriber のみ)」は既にあるが、URL クエリ `mode` で切り替えることと、ヘッダーの副題のリンクから他のモードのページを今の接続設定のまま新しいタブで開けることが書かれていない
- その項目は「Publisher / Subscriber 両方の動作確認」の近くではなく、一覧の末尾付近にある

## 設計方針

- README.md の `### moqt-devtools` の機能一覧の「表示モード (Publisher のみ / Subscriber のみ)」を、次の 2 点が分かるように書き換える
  - URL クエリ `mode` で Publisher だけ / Subscriber だけを表示できること
  - ヘッダーの副題のリンクから他のモードのページを今の接続設定のまま新しいタブで開けること
- 並びは既存の「Publisher / Subscriber 両方の動作確認」の近くにする

## 完了条件

- README.md の moqt-devtools の機能一覧の表示モードの項目に、URL クエリ `mode` で切り替えることと、ヘッダーの副題のリンクから他のモードのページを今の接続設定のまま新しいタブで開けることが書かれている
- その項目が「Publisher / Subscriber 両方の動作確認」の近くにある
