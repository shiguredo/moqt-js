# catalog 取得を fill fetch として解釈できるようにする

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-33 を実装する。§5 は catalog の取得に Joining FETCH (offset = 0) を MUST とする。draft-23 に Joining FETCH は無いため fill fetch stream として解釈する。

## 現状

- 実装は SUBSCRIBE (Next Object) + FETCH (絶対開始) の 2 リクエスト
- FILL_PARAMETERS を扱う経路が無い

## 設計方針

- transport の SUBSCRIBE が FILL_PARAMETERS を扱えるかを確認する
- 扱えない場合、本 issue は「現行の 2 リクエストを仕様上の代替とする」決定を記録し、JSDoc と docs に明記する

## 完了条件

- transport の対応可否を確認し、結論を記録する
- 可能なら実装し、不可なら決定と代替を docs に書く
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
