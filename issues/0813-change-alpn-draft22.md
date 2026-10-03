# 接続時に広告するプロトコル識別子を draft-22 に合わせるかを決める

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-alpn-draft22
- Polished: 2026-10-03

## 目的

draft-ietf-moq-transport-22 §6.2 (Session establishment) は、MOQT のバージョン交渉を QUIC の ALPN と WebTransport の WT-Available-Protocols で行うと定め、IETF ドラフトを識別する ALPN は「"moqt-" にドラフト番号を付けたもの」とする。

> ALPNs used to identify IETF drafts are created by appending the draft number to "moqt-". For example, draft-ietf-moq-transport-13 would be identified as "moqt-13".

0796〜0808 と 0812 で `src` と `devtools` のコメントを draft-22 に追随させ (README / docs の残りは 0814 の対象)、実装のワイヤも v22 の形式 (0796 の Location Filter など) になっているが、**接続時に広告するプロトコル識別子は `moqt-21` のまま**である。実装が draft-22 に準拠するのであれば `moqt-22` を広告する必要があり、この不一致を放置すると「コメントとワイヤは v22、広告は draft-21」という読み手を誤らせる状態が残る。

## 現状

- `src/connect.ts` は WebTransport の `protocols` に `["moqt-21"]` を設定する。直前のコメントは draft-22 §6.2 / §6.2.1 を引用しつつ「draft 版の ALPN は "moqt-" + draft 番号であり、draft-21 は "moqt-21"」と説明しており、v22 準拠の説明と広告値が食い違っている
- `src/session.test.ts` の `connect: WebTransport に protocols ['moqt-21'] を渡す` が現行値を固定している
- 実装のワイヤは v22 である。0796 が LOCATION FILTER を v22 の Location Filter Type 方式に変更済みで (v21 の Length 方式とは後方互換なし)、CHANGES.md にも [CHANGE] として記録されている
- 接続先の実リレー (sora-moq) は draft-21 であり、`tests/e2e/relay/*` はその実リレーへ接続する。`.github/workflows/e2e-test.yml` のコメントどおり、Location Filter のワイヤ形式が一致せず FETCH / subscribe のテストは失敗するため、ワークフローは自動実行を止めて workflow_dispatch のみが残っている
- `sora-moq` が `moqt-22` を受け付けるか (現在は `moqt-21` のみか、複数の draft を同時に受け付けるか) は本リポジトリからは分からない (確認には実リレー側への問い合わせが必要)

## 設計方針

- 判断の基準は CODEBASE.md の「最新ドラフトに準拠すること」と、完了済みの v22 ワイヤ対応 (0796) である。実装が準拠するドラフトと広告する ALPN を一致させ、選定理由を解決方法とコードコメントに残す。方針は次の 2 つから選ぶ
  - (a) draft-22 に準拠する: `protocols` を `["moqt-22"]` にする。実リレーが `moqt-22` を受け付けない場合は接続できなくなるため、sora-moq 側の対応状況を確認する (e2e-test ワークフローの再開は sora-moq が `moqt-22` に対応した後)
  - (b) draft-21 に合わせる: 広告値を `moqt-21` のまま保ち、コメントを draft-21 の参照に戻し、README / devtools の表示も draft-21 に揃える (0814 の前提を変更する)。ただし実装のワイヤは既に v22 であり、真に draft-21 へ戻すには 0796 を含むワイヤ変更の巻き戻しが必要になる。巻き戻さない限り「広告は `moqt-21`、ワイヤは v22」の不一致は消えない
- (a) の派生として、複数 draft を併記する (`["moqt-22", "moqt-21"]` のように優先順で広告する) ことも検討する。ただし v22 §6.1.2 が複数 ALPN の提示を許すのは「クライアントが対応するバージョン」だけであり、moqt-js が実装しているのは v22 のワイヤ 1 つである。ブラウザの WebTransport API はサーバーが選択したプロトコルをクライアントへ返さないため、選択結果に応じてワイヤを切り替えることもできない。したがって併記は、v21 と v22 の両方のワイヤを実装して初めて意味を持つ (SETUP にバージョン交渉の欄は無い。v22 §9.1 は Setup Options のみであり、変更履歴に "Always use ALPN for version negotiation (#499)" がある)
- テスト (`src/session.test.ts` の `connect: WebTransport に protocols ... を渡す`) を新しい値に合わせて更新する
- 判断の結果は CHANGES.md に反映する (挙動変更を伴う場合は [CHANGE])

## 完了条件

- 広告するプロトコル識別子の方針 (draft-22 への変更 / draft-21 への巻き戻し / 併記) が決まり、根拠がコードコメントと解決方法に記録されている
- 方針に合わせて `src/connect.ts` と `src/session.test.ts` が更新されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る
- 実リレーへの接続を伴う判断の場合は、その可否と確認方法が解決方法に記録されている (e2e-test ワークフローは停止したままにする)

## 参照

- draft-ietf-moq-transport-22 §6.1.2 (Dereferencing a MOQT URI) / §6.2 (Session establishment) / §6.2.1 (WebTransport) / §9.1 (SETUP)
- `refs/moq/draft-ietf-moq-transport-22.txt`
- `CODEBASE.md`
- `src/connect.ts` / `src/session.test.ts` の `connect: WebTransport に protocols ['moqt-21'] を渡す`
- `tests/e2e/relay/*` / `tests/e2e/main.ts` (実リレー接続の E2E)
- `devtools/src/App.tsx` / `devtools/index.html` (draft 表記の表示)
- `.github/workflows/e2e-test.yml` (実リレー接続テストの自動実行停止)
- 関連 issue: 0796 (Location Filter の v22 ワイヤ変更) / 0812 (参照の v22 化。ALPN の判断を対象外として残した) / 0814 (README・docs。本 issue の判断を前提とする)

## 解決方法

{未着手}
