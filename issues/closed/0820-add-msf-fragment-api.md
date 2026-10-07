# msf fragment の解析結果を公開 API に追加する

- Created: 2026-10-07
- Completed: 2026-10-07
- Branch: feature/add-msf-fragment-api
- Polished: 2026-10-07

## 目的

MOQT URI の msf fragment (`#msf:<track-identifier>&c4m=<base64 encoded token>`) を消費側のアプリが解釈できるようにする。draft-ietf-moq-msf-01 §11.1 は、msf fragment の値が特定の Track を識別し、track-identifier は §11.1.2 の MSF namespace-name 文字列として符号化され、クライアントが接続確立後にその識別子で SUBSCRIBE または FETCH を起こすと定める。Track は MOQT の Full Track Name (Track Namespace と Track Name の組。draft-ietf-moq-transport-22 §2.4.1) で識別される。fragment はサーバーへ送信されず、クライアントがローカルで解釈する (draft-ietf-moq-transport-22 §6.1.1)。moqt-js は c4m からの認可トークンの解決と transport の選択を行うが、track-identifier を消費側へ渡す公開 API が無い。

## 現状

- `src/msf/fragment.ts` に `parseMsfFragmentValue` と `interface MsfFragmentValue` がある。`MsfFragmentValue` は `trackNamespace` (名前空間のフィールド列) / `trackName` / `parameters` を返す
- `src/msf.ts` (facade) は `parseMsfFragmentValue` と `type MsfFragmentValue` を再輸出している
- `src/index.ts` の MSF の再エクスポートは Catalog / Timeline と関連する型・定数を列挙しており、`parseMsfFragmentValue` と `MsfFragmentValue` を含まない。同じ箇所に「公開するのは Catalog / Timeline と関連する型・定数のみ。検証・fragment・range などの内部ヘルパーはモジュール内に留める」と書かれており、fragment を公開しないことは意図的な方針である
- devtools は `../../../src/msf/fragment.ts` とリポジトリ相対で import している (`devtools/src/utils/msfFragment.ts`)
- moqt-js 自身の利用箇所は 2 つある。`src/msf/c4mAuthorization.ts` の `resolveMsfAuthorizationToken` は `parseMsfFragmentValue` で c4m を解決する。`connection=q|wt` の検証は `src/msf/fragment.ts` の `assertMsfConnectionSupported` が担い、`src/connect.ts` の `connect` から呼ばれる。どちらも track-identifier の結果は使っていない
- `Session.fragment` は生の `MoqtFragment` (`src/moqtUri.ts`) を返す。`MoqtFragment` は `type` と `value` を持ち、URI が `moqt://relay.example.com/app#msf:customer-livestream-123--catalog&connection=wt` のとき `{ type: "msf", value: "customer-livestream-123--catalog&connection=wt" }` になる。消費側は同じ解析を自前で実装しないと `trackNamespace` と `trackName` を得られない
- `docs/MSF.md` の「moqt-js での公開 API」と `README.md` の「実装状況 > MOQT Streaming Format > URI / 認可」は MSF の公開 API と msf fragment の扱いを列挙している。どちらにも解析結果を返す API は無い
- `CHANGES.md` の `## develop` には、`parseMsfFragmentValue` を helper として追加した `[ADD]` と、「MSF の公開 API を明示的な export リストにする」`[CHANGE]` (内部ヘルパーとして fragment を非公開にする) がある

## 設計方針

- `src/index.ts` の MSF の再エクスポートに `parseMsfFragmentValue` と `type MsfFragmentValue` を追加する
  - 名前空間を分けた再エクスポート (`export * as MSF`) は `src/msf.ts` の内部ヘルパーまで公開してしまうため採らない。既存の並びに 1 関数と 1 型を足す
  - 「fragment は内部に留める」方針を、消費側に必要な `parseMsfFragmentValue` とその戻り値の型だけ変える。`getConnectionParameter` / `assertMsfConnectionSupported` などの残りのヘルパーは公開しない
  - `src/index.ts` の方針コメント (「検証・fragment・range などの内部ヘルパーはモジュール内に留める」) も、この変更に合わせて直す
  - 公開するのはこの 2 つだけであり、`Session` に解析済みの値を足す変更は行わない
- `devtools/src/utils/msfFragment.ts` の相対 import を公開 API の import に置き換える
  - 自リポジトリで公開 API を実際に使うことで、公開しても破綻しないことを確かめる
- `docs/MSF.md` の「moqt-js での公開 API」に `parseMsfFragmentValue` と `MsfFragmentValue` を追加し、`README.md` の「実装状況 > MOQT Streaming Format > URI / 認可」に msf fragment の track-identifier を解析して返す公開 API を追加する
- `CHANGES.md` の `## develop` を最終的な差分に整理する
  - `[ADD] MSF URI Fragment Type "msf" (§11.1) の解析 helper parseMsfFragmentValue を追加する` を、解析結果を公開 API として提供する 1 エントリに書き換える
  - `[CHANGE] MSF の公開 API を明示的な export リストにする` の「Catalog / Timeline / トラック検索と関連する型・定数のみに絞る」という列挙に msf fragment の解析を加え (または列挙をやめ)、内部ヘルパーの列挙から `fragment` を外す
- 公開後の消費側の使い方

  ```ts
  import { connect, parseMsfFragmentValue } from "moqt-js";

  // connection=q (Native QUIC) は未実装のため connect() がエラーになる。WebTransport を選ぶ
  const session = await connect(
    "moqt://relay.example.com/app#msf:customer-livestream-123--catalog&connection=wt",
  );
  if (session.fragment?.type === "msf") {
    const { trackNamespace, trackName, parameters } = parseMsfFragmentValue(session.fragment.value);
    // trackNamespace: ["customer", "livestream", "123"]
    // trackName: "catalog"
    // parameters: [["connection", "wt"]]

    // 取り出した名前空間とトラック名で購読する (callbacks の object は必須)
    await session.subscribe(trackNamespace, trackName, { object: () => {} });
  }
  ```

## 完了条件

- `import { parseMsfFragmentValue, type MsfFragmentValue } from "moqt-js"` が型検査と実行時の両方で通ること
- `devtools/src/utils/msfFragment.ts` が公開 API を import していること
- `parseMsfFragmentValue` の既存テスト (`src/msf.test.ts` / `src/msf.prop.ts`) が引き続き通ること
- `vp run build` で `dist/index.d.ts` を生成し、`parseMsfFragmentValue` と `MsfFragmentValue` が現れること
- `docs/MSF.md` の「moqt-js での公開 API」と `README.md` の「実装状況 > MOQT Streaming Format > URI / 認可」に公開 API が追記されていること
- `CHANGES.md` の `## develop` が最終的な差分になっていること (helper の `[ADD]` の整理と、`[CHANGE]` の公開リストの列挙および内部ヘルパーの列挙の修正)
- `vp check` / `vp test run` / `vp run build:devtools` が通ること

## 解決方法

- `src/index.ts` の MSF の再エクスポートに `parseMsfFragmentValue` と `type MsfFragmentValue` を追加した。方針コメントも「Catalog / Timeline / msf fragment の解析 / トラック検索と関連する型・定数のみ」に直した。`getConnectionParameter` / `assertMsfConnectionSupported` などの残りのヘルパーは公開していない
- `devtools/src/utils/msfFragment.ts` の相対 import を `moqt-js` からの import に置き換えた。devtools がリポジトリ内で公開 API を使う利用者になったことを `devtools/src/utils/msfFragment.test.ts` の 1 テストで固定した
- `parseMsfFragmentValue` に `@throws` を追加し、到達可能な例外条件を列挙した
- `docs/MSF.md` の「moqt-js での公開 API」と `README.md` の「実装状況 > MOQT Streaming Format > URI / 認可」に公開 API を追記した。README には `Session.fragment` が `type === "msf"` のときの `value` (`msf:` を除いた値) を渡すことと、解析できない値では `Error` を投げることも書いた
- `CHANGES.md` の `## develop` を整理した
  - `parseMsfFragmentValue` を helper として追加した `[ADD]` を、解析結果を公開 API として提供する 1 エントリに書き換えた
  - `[CHANGE] MSF の公開 API を明示的な export リストにする` の列挙に msf fragment の解析を加え、内部ヘルパーの列挙から fragment を外した
  - `[UPDATE] moqt-devtools の msf fragment の解析を公開 API の import に置き換える` を `### misc` に追加した
- 検証
  - `vp check` / `vp test run` (198 ファイル / 3607 テスト) / `vp run build:devtools` / `vp run e2e-test` (92 テスト) が通ることを確認した
  - `vp run build` で生成した `dist/index.d.ts` に `parseMsfFragmentValue` と `MsfFragmentValue` が現れ、内部ヘルパーが現れないことを確認した
  - `node_modules/moqt-js` をこのリポジトリへ向けた検証用プロジェクトで `import { parseMsfFragmentValue, type MsfFragmentValue } from "moqt-js"` を型検査し、実行時にも取り出せることを確認した
- レビューで見つかった範囲外の内容 (空の Track Name の拒否に仕様の裏付けが無い点、msf fragment 解析の error path テストの不足、literal で書ける byte の hex 表現の受理、並列の中黒の統一) は、ユーザーの判断により本 issue では扱わず別 issue とする
