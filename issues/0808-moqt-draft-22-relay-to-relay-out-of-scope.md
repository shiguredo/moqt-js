# relay-to-relay 通信がスコープ外であることを確認する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-relay-relay-scope
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §7 (Relays) は「For the purposes of this specification, a coordinated set of relays are treated as a single MOQT relay. How relays within such a set interconnect, and use cases built on relay to relay communication, are out of scope.」と明記した。moqt-js は CODEBASE.md のとおりクライアント専用であり、relay 間接続の実装を持たない。実装変更が不要であることを確認し、記録する。

## 現状

- `CODEBASE.md` の方針でクライアント (publisher / subscriber として接続する用途) のみを対象とする
- `src/dataStream/fetch.ts` の `encodeFetchHeader` / `encodeFetchObjectFields` はリレー実装用とのコメント付きで、ランタイムでは使わず PBT 専用である
- 受信した未対応リクエスト (SUBSCRIBE / FETCH / PUBLISH / namespace 系) は `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` で NOT_SUPPORTED を返す
- relay 間の相互接続に関するコード・設定・API は存在しない

## 設計方針

- 実装変更は行わない。relay 間接続が対象外である旨が README / CODEBASE.md / コメントに既に書かれているか確認し、必要なら最小限のコメントを追加する
- §7 の relay 一般の規定 (キャッシュ、Paused Subscription Handling など) のうち、クライアントが関係する記述 (paused subscription、Largest Object など) は該当する issue (0800 / 0804) 側で扱う

## 完了条件

- 実装変更が不要であることと、relay 間接続のコードが存在しないことが確認されている
- 必要に応じた最小限のコメント更新が完了している

## 参照

- draft-ietf-moq-transport-22 §7 (Relays)
- `CODEBASE.md`
- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage`

## 解決方法

{未着手}
