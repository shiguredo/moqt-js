# `startSubscribing` に `AbortController` ベースの中断機構を導入する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts:startSubscribing` の中断検知は現在「`instance.session.value === null` か否か」で行っているが、`cleanupSubscriber` が session を null 化する副作用に相乗りした暗黙キャンセル信号となっており、意味論が混線している。さらに本来 1 種類の中断シグナルで済むはずが、各 await ポイントごとに散らした個別チェックを必要とする。

恒久的な解決として `AbortController` を導入し、`cleanupSubscriber` で `abort()` を呼ぶ設計に置き換える。

## 根拠

- `useSubscriber.ts:303` 付近 (Catalog 取得 await 後) のみ残った `instance.session.value === null` チェックは「session の意味」と「中断フラグの意味」が混線したまま
- `await connect()` / `await decoder.configure()` / `await session.subscribe()` のそれぞれで「中断後の処理続行を防ぐ」必要があるが、現状は session null チェックだけでは不十分 (connect 後の即時切断で session 代入と null 化のタイミングが衝突する経路)
- `isStopping` フラグは stop の二重実行防止にしか使われておらず、startSubscribing からの中断検知には使えない

## 修正方針

1. `useSubscriber` フックの直上 (もしくは `startSubscribing` 冒頭) で `AbortController` を生成して保持する
2. `cleanupSubscriber` で `abortController.abort()` を呼ぶ
3. 各 `await` の後に `signal.aborted` を確認して中断時は早期 return
4. `connect()` / `subscribe()` の API が AbortSignal を受け取れる場合は直接渡し、connect 自体を中断可能にする
5. 既存の `instance.session.value === null` チェックを撤去する

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` の `startSubscribing` / `cleanupSubscriber`
- `moqt-js` 側の `connect()` / `Session.subscribe()` シグネチャに AbortSignal を受け付ける拡張余地があれば追加検討 (本 issue のスコープ外)

## テスト戦略

- `vp run test` で全テストがパスすること
- `devtools/src/hooks/useSubscriber.test.ts` に「`startSubscribing` 中に AbortController.abort() を呼ぶと後続の await が走らない」テストを追加する
- 手動: 接続中にサーバを切断 → status が "Failed" に上書きされず "Disconnected" のまま留まることを確認

## CHANGES.md 記載方針

- `## develop` 直下に `[CHANGE]` で記載する (中断機構の設計変更)

## 完了条件

- `AbortController` が `useSubscriber` 内で生成・破棄される
- `cleanupSubscriber` が `abort()` を呼ぶ
- 各 await 後の中断チェックが `signal.aborted` ベースに統一される
- 既存の session null チェックが撤去される
- 全テストパス
