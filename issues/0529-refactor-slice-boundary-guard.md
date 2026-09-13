# Length 宣言境界ガードの共通ヘルパー化

- Created: 2026-09-07
- Completed: 2026-09-14
- Branch: feature/refactor-slice-boundary-guard
- Polished: YYYY-MM-DD

## 目的

同一形の境界ガードが 21 箇所に複製され、抜け落ちの再発温床になっている。共通ヘルパーに集約する必要がある。

## 現状

- `src/message` 配下と `src/properties.ts` の Length 宣言 slice 箇所に `offset + totalConsumed + Number(length) > data.length` 形の検査が文言だけ変えて複製されている。
- 形式が 3 系統に分かれ、各所で `Number()` を反復評価している。

## 設計方針

1. 残量検査を共通ヘルパーに集約する（メッセージと期待値・実際値を引数で受ける）。

## 完了条件

- 重複が除去され、既存テストが全て通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §10

## 解決方法

実装した。

### 共通ヘルパー

`src/length.ts` を新設し、2 つの関数に集約した。

- `isLengthWithinData(declared, start, dataLength)`: 宣言 Length の Value が残りバイト数に収まるかを返す述語。`Number()` による数値化と `start + declared <= dataLength` の比較を 1 箇所に閉じる
- `assertLengthWithinData(label, declared, start, dataLength)`: 収まらない場合に `ProtocolViolationError` を `${label} length exceeds remaining data: ${宣言値} > ${残りバイト数}` の文言で投げる

切り詰めを拒否する理由 (短い slice / subarray を返すと後続フィールドの解釈がずれる) と §8.3 の引用はヘルパーの JSDoc に置き、各呼び出し箇所に複製していた 2 行コメントは削除した。

### 置き換えた箇所

- `assertLengthWithinData` へ置換 (15 箇所): `src/message/publish.ts` (2)、`src/message/parameter.ts` (5)、`src/message/session.ts` (4)、`src/message/trackstatus.ts` / `src/message/subscribe.ts` / `src/message/fetch.ts` / `src/message/namespace.ts` (各 1)
- `isLengthWithinData` へ置換 (6 箇所): `src/properties.ts` の 6 箇所。うち 4 箇所は `throwLengthOverrunError` (既知 Type の特別扱いを持つ専用の thrower) をそのまま使うため述語だけを共有し、残り 2 箇所は寛容打ち切り (complete: false) と既知 Type 分岐の条件として述語を使う

### 置き換えなかった箇所

`src/message/parameter.ts` の `decodeLocationFilter` は `end` を後段でも使うため事前計算した値をそのまま比較しており、`IncompleteDataError` を投げる点も他と意味が異なる (ストリーミング途中の呼び出しで「まだ届いていない」を表す) ため対象外とした。

### 文言の変更

`uint8 parameter value exceeds remaining data: 1 > N` は他の 14 箇所と違い `length` を含まない形だったため、`uint8 parameter value length exceeds remaining data: 1 > N` に統一した。これに合わせて `src/message/parameter.test.ts` の期待値 1 件を更新した。他の文言は完全に同一である。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,126 テスト全通過
- `src/length.ts` のカバレッジは Statements / Branches / Functions / Lines すべて 100%
- `rg "> data\.length" src/message/*.ts src/properties.ts` の一致が 1 件 (上記の対象外箇所) のみであること
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した (内部リファクタで機能に影響しないため)
