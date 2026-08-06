# リクエストストリーム上の重複 GOAWAY を検出できない

- Priority: Medium
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-duplicate-goaway-on-request-stream-undetected
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.4 の MUST 要件「同一リクエストストリーム上の複数 GOAWAY を受信したら PROTOCOL_VIOLATION でセッションを閉じる」を満たす。現在は GOAWAY 処理後に読み取りループを return するため、2 通目以降の GOAWAY が検出されない。

## 優先度根拠

`validateNoDuplicateGoawayOnRequestStream` は実装されているが、GOAWAY 処理後の `return` により実質デッドコードになっている。§10.4 の MUST 要件を満たしておらず、重複 GOAWAY を送る不正ピアを検出できない。Medium。

## 現状

- `src/session/bidi.ts:782-807` の GOAWAY ケースは、重複検出ヘルパーを呼んだ後に `return` してループを終了する。同一ストリーム上の 2 通目以降の GOAWAY は読み取りが停止しているため検出されない。
- 同じ問題が `src/session.ts:3195-3208` (受信 PUBLISH ストリーム) と `src/session/namespaceLoops.ts:44-64` にも存在する。
- さらに GOAWAY 受信時に旧リクエストストリームを閉じない (§10.4 の「close the old request stream using the appropriate mechanism」は SHOULD だが未達)。

## 設計方針

- GOAWAY 処理後に return せず、リクエストストリームの読み取りを継続するか、ストリームを適切に閉じたうえで重複 GOAWAY を検出可能にする。
- GOAWAY 受信時は当該リクエストのコールバックを呼び、旧ストリームを FIN / reset / PUBLISH_DONE のいずれかで閉じる (§10.4 SHOULD)。
- 制御ストリーム上の GOAWAY 重複検出 (`session.ts:2825-2870`) は既に実装済みのため対象外。

## 完了条件

- 同一リクエストストリーム上で 2 通目の GOAWAY を受信した場合、PROTOCOL_VIOLATION でセッションが閉じること。
- GOAWAY 受信時に旧リクエストストリームが適切に閉じられること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.4 (GOAWAY)
- draft-ietf-moq-transport-19 §3.6 (Session Migration)

## 解決方法

未着手。
