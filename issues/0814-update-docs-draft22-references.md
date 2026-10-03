# README とドキュメント・E2E テストに残る draft-21 の参照を draft-22 に合わせる

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/update-docs-draft22-references
- Polished: 2026-10-03

## 目的

0812 で `src` と `devtools` の参照を draft-22 に揃えたが、`README.md` / `docs/*.md` / `tests/e2e/*` には draft-21 の参照が残っている。利用者が読む README とドキュメントが対応ドラフトを古く示したままだと、実装がどのドラフトに準拠しているかを誤解させる。

## 現状

`rg -n "moq-transport-21|draft-21" README.md docs tests examples` で 22 行 (重複を除くと 8 ファイル)。

- `README.md`: 参照リンク 2 箇所と「`draft-21` 対応」の記述 1 箇所
- `docs/LOW_LEVEL_API.md`: 5 箇所 (Fragment Identifier、Joining FETCH の削除、FIN 時の PROTOCOL_VIOLATION、制御ストリームの移動など)
- `docs/HIGH_LEVEL_API.md`: 4 箇所 (Object の順不同到着、publisher priority、priority の値域など)
- `tests/e2e/main.ts` (3) / `tests/e2e/relay/*.spec.ts` (6) / `tests/e2e/devtools-audio-meter.spec.ts` (1): 実リレー接続テストのコメント

大半は §6.1.1 / §8.9 / §9.1.4 / §11.3 / §2.1 / §5.1.1 / §10.4 のように v21 と v22 で番号が変わらない節を指しており、版表記の更新が中心である。ただし例外が 2 箇所ある。

- `tests/e2e/main.ts` の FILL TIMEOUT は v21 では §9.20.6 であり (v21 の §9.20.5 は OBJECT_DELIVERY_TIMEOUT)、v22 では §9.20.5 が FILL TIMEOUT になる。版表記を v22 に直すだけで正しい節を指すようになる
- `tests/e2e/relay/pubsub.spec.ts` の「Section 9.7 (SUBSCRIBE) — Section 9.8 (SUBSCRIBE_OK)」は v21 / v22 のどちらでも誤りで、正しくは Section 9.6 (SUBSCRIBE) — Section 9.7 (SUBSCRIBE_OK) である

「Joining FETCH は draft-21 で削除された」(`docs/LOW_LEVEL_API.md`) や「draft-ietf-moq-transport-21 §6.3 でリクエスト / レスポンスは双方向ストリームに移動した」(同) のような過去の変更を述べる記述は、版表記を保つか表現を変えるかの判断が要る。後者は単純に v22 表記へ置換すると v22 で起きた変更であるかのように読めるため、単純置換はできない。

## 設計方針

- 0813 (接続時に広告するプロトコル識別子) の結論を前提とし、0813 の実装が完了してから着手する。0813 が「広告値を `moqt-21` のままにする」(0813 の設計方針の (b)) を選んだ場合は、本 issue も README / docs / tests/e2e の版表記を draft-21 のまま揃える方向へ変更する (devtools の「対応ドラフト」表記は 0812 で draft-22 に更新済みであり、本 issue の対象外)
- 節番号は `refs/moq/draft-ietf-moq-transport-22.txt` と突き合わせ、番号が変わった節 (§3.x / §4.x / §7.x / §9.20.x / §11.1.x) があれば参照先を直す (0812 と同じ対応表を使う)
- 過去のドラフトでの変更を述べる記述は、事実として正しい版表記を残すか「削除された」という表現に直すかを 1 件ずつ判断し、判断理由をコメントに残す
- 実リレー接続テストのコメントも同様に更新する。テストの挙動 (接続先・期待値) は変えない

## 完了条件

- `rg -n "moq-transport-21|draft-21" README.md docs tests examples` の残りが、過去のドラフトを意図的に引用している箇所だけになっている
- 参照する節番号が draft-22 と一致している
- テストの挙動が変わっていない (`vp test run` の結果が同一)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- `refs/moq/draft-ietf-moq-transport-22.txt`
- `README.md` / `docs/HIGH_LEVEL_API.md` / `docs/LOW_LEVEL_API.md`
- `tests/e2e/main.ts` / `tests/e2e/relay/*.spec.ts` / `tests/e2e/devtools-audio-meter.spec.ts`
- 関連 issue: 0812 (src と devtools の参照を更新済み) / 0813 (ALPN の判断)

## 解決方法

{未着手}
