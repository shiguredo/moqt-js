# 接続時に広告するプロトコル識別子を draft-22 に合わせるかを決める

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-alpn-draft22
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §6.2 (Version Negotiation) は、IETF ドラフトを識別する ALPN を「"moqt-" にドラフト番号を付けたもの」と定める。

> ALPNs used to identify IETF drafts are created by appending the draft number to "moqt-". For example, draft-ietf-moq-transport-13 would be identified as "moqt-13".

0796〜0812 でライブラリのコメントとドキュメントを draft-22 に追随させたが、**接続時に広告するプロトコル識別子は `moqt-21` のまま**である。実装が draft-22 に準拠するのであれば `moqt-22` を広告する必要があり、この不一致を放置すると「コメントは v22、ワイヤは draft-21」という読み手を誤らせる状態が残る。

## 現状

- `src/connect.ts` は WebTransport の `protocols` に `["moqt-21"]` を設定する。直前のコメントは draft-22 §6.2 / §6.2.1 を引用しつつ「draft 版の ALPN は "moqt-" + draft 番号であり、draft-21 は "moqt-21"」と説明しており、引用した節と広告値が食い違っている
- `src/session.test.ts` の `connect: WebTransport に protocols ['moqt-21'] を渡す` が現行値を固定している
- 実リレー (sora-moq) は draft-21 であり、`tests/e2e/relay/*` はその実リレーへ接続する。e2e-test ワークフローは draft-21 の実リレーを前提として停止したままである
- `sora-moq` が複数の draft を同時に受け付けるかは本リポジトリからは分からない (実リレーへの問い合わせが必要)

## 設計方針

- 実装が準拠するドラフトと、広告する ALPN を一致させる。方針は次の 2 つから選び、選定理由を解決方法とコードコメントに残す
  - (a) draft-22 に準拠する: `protocols` を `["moqt-22"]` にする。実リレーが `moqt-22` を受け付けない場合は接続できなくなるため、sora-moq 側の対応状況を確認する
  - (b) draft-21 のワイヤを維持する: コメントを draft-21 の参照に戻し、README / devtools の表示も draft-21 に揃える (0814 の前提を変更する)
- (a) を選ぶ場合は、複数 draft を併記する (`["moqt-22", "moqt-21"]` のように優先順で広告する) ことも検討する。ただしサーバーが選択した値と実装の期待がずれた場合の挙動 (SETUP のバージョン交渉) を整理してから決める
- テスト (`src/session.test.ts` の `connect: WebTransport に protocols ...` を渡す) を新しい値に合わせて更新する
- 判断の結果は CHANGES.md に反映する (挙動変更を伴う場合は [CHANGE])

## 完了条件

- 広告するプロトコル識別子の方針 (draft-22 / draft-21 / 併記) が決まり、根拠がコードコメントと解決方法に記録されている
- 方針に合わせて `src/connect.ts` と `src/session.test.ts` が更新されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る
- 実リレーへの接続を伴う判断の場合は、その可否と確認方法が解決方法に記録されている (e2e-test ワークフローは停止したままにする)

## 参照

- draft-ietf-moq-transport-22 §6.2 (Version Negotiation) / §6.2.1 (WebTransport)
- `src/connect.ts`
- `src/session.test.ts` の `connect: WebTransport に protocols ['moqt-21'] を渡す`
- `tests/e2e/relay/*` (実リレー接続の E2E)
- `devtools/src/App.tsx` / `devtools/index.html` (draft 表記の表示)
- 関連 issue: 0812 (参照の v22 化。本 issue は ALPN の実値の扱い)

## 解決方法

{未着手}
