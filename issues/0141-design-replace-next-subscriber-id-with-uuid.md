# `nextSubscriberId` カウンタを `crypto.randomUUID()` ベースの ID 生成に変更する

Created: 2026-05-10
Model: Opus 4.7

## 概要

`devtools/src/signals/subscriber.ts` の 110 行目で `let nextSubscriberId = 1` と定義されたモジュールスコープのミュータブルカウンタを `addSubscriber` (115-122 行目) でインクリメントして `subscriber-${n}` の ID を生成している。

## 根拠

- モジュールスコープのミュータブル変数は HMR と相性が悪い。開発時に signal だけリセットされて `nextSubscriberId` が引き継がれることで ID 衝突や歯抜け番号が発生し得る。
- ID は内部識別子として使われ、UI に直接表示されている箇所は DebugPanel のコピーボタンラベル (645 行目) くらい。短い人間可読 ID にする必要は薄い。
- グローバル状態を減らす方向で整理する。

## 確認済み事項

- `subscriber-N` 形式の ID にコードとして依存している箇所は `subscriber.ts` の生成箇所のみ。DebugPanel は ID を透過的に扱っている。
- `crypto.randomUUID()` はブラウザ環境で利用可能 (Chrome 92+, Firefox 95+, Safari 15.4+)。e2e テスト (`tests/e2e/pubsub.spec.ts:25`) で既に使用済み。
- `crypto.randomUUID()` は Secure Context (HTTPS) が必要だが、devtools は開発環境で `localhost` からも利用されるため、`crypto.randomUUID()` が利用できない環境でのフォールバックは不要 (WebTransport 自体が HTTPS を要求するため)。

## 修正方針

1. 110 行目の `let nextSubscriberId = 1` と該当のインクリメントを削除する。
2. `addSubscriber` 内で `id = \`subscriber-${crypto.randomUUID().slice(0, 8)}\`` のように短縮した UUID を生成する。
   - UUID v4 の先頭 8 文字はバージョン情報を含むため、エントロピーは完全ではないが、devtools の内部 ID としての衝突リスクは十分低い。
   - そのまま `crypto.randomUUID()` でもよいが、UI に表示されるラベルとしては長すぎるため先頭 8 文字程度に切り詰める。
3. 既存の `subscriber-N` 形式に依存しているテストやログ整形がないことを確認する。

## 影響範囲

- `devtools/src/signals/subscriber.ts` のみ (DebugPanel のラベル表示は ID をそのまま使うので追従不要)

## テスト戦略

- `vp run build` でビルドが通ることを確認する
- devtools にテストがない場合はテスト追加不要

## CHANGES.md 記載方針

- `### misc` サブセクションに `[CHANGE]` で記載する (他 issue 群とまとめて 1 エントリにまとめる)。

## 完了条件

- `nextSubscriberId` カウンタが削除されている
- `addSubscriber` が UUID ベースの ID を生成する
- `vp run build` が成功する
