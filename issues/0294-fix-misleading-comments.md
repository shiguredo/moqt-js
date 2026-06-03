# 誤解を招くコメントを修正する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

以下の誤解を招くコメントを修正する:

1. `src/session.ts:1940`: コメント「仕様上 PUBLISH は SUBSCRIBE_TRACKS 応答に属する」は誤り。PUBLISH は仕様上「新しい双方向ストリーム」で到着する（draft-ietf-moq-transport-18 §10.10）
2. `src/session.ts:3333`: "expected odd" → "expected even" (クライアント受信時。詳細は #0273 と #0286 を参照)
3. `src/message/session.ts:36`: GOAWAY JSDoc の Request ID 説明を修正（#0288 と重複するため #0288 の対応時に合わせて修正）
4. `src/properties.ts:686`: 末尾コメント (`break; // 不完全な...`) を削除 (AGENTS.md:122 違反)
5. `src/session/bidi.ts:558`: `bidiReadTrackStatusResponse` GOAWAY コメントの理由説明を修正

## 優先度根拠

誤ったコメントは将来のバグの原因になる。コーディング規約違反を含む。

## 設計方針

- 各コメントを正しい内容に修正する
- 末尾コメントは行コメントに変更するか削除する

## 完了条件

- 全コメントが正確で規約に準拠している
