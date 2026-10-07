# msf fragment の解析結果を公開 API に追加する

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/add-msf-fragment-api
- Polished: {YYYY-MM-DD}

## 目的

MOQT URI の msf fragment (`#msf:<track-identifier>&c4m=<base64url>`) を消費側のアプリが解釈できるようにする。fragment は relay へ送信されず、クライアントがローカルで解釈する (draft-ietf-moq-transport-22 §6.1.1)。MSF の招待リンクでは `msf` fragment の `track-identifier` が「接続後に最初に SUBSCRIBE / FETCH する Track の Full Track Name」を表す (draft-ietf-moq-msf-01 §11.1.2)。moqt-js は c4m からの認可トークンの解決と transport の選択を行うが、`track-identifier` を消費側へ渡す公開 API が無い。

## 現状

- `src/msf/fragment.ts` に `parseMsfFragmentValue` と `interface MsfFragmentValue` がある。`MsfFragmentValue` は `trackNamespace` (名前空間のフィールド列) / `trackName` / `parameters` を返す
- `src/msf.ts` (facade) は `parseMsfFragmentValue` と `type MsfFragmentValue` を再輸出している
- `src/index.ts` の MSF の再エクスポートは Catalog / Timeline と関連する型・定数を列挙しており、`parseMsfFragmentValue` と `MsfFragmentValue` を含まない。同じ箇所に「公開するのは Catalog / Timeline と関連する型・定数のみ。検証・fragment・range などの内部ヘルパーはモジュール内に留める」と書かれており、fragment を公開しないことは意図的な方針である
- devtools は `../../../src/msf/fragment.ts` とリポジトリ相対で import している (`devtools/src/utils/msfFragment.ts`)。公開 API ではないことがこの import から読み取れる
- moqt-js 自身は `src/msf/c4mAuthorization.ts` で `parseMsfFragmentValue` を使い、c4m の解決と `connection=q|wt` の検証を行っている。`track-identifier` の結果は使っていない
- `Session.fragment` は生の `MoqtFragment` (`src/moqtUri.ts`) を返す。`MoqtFragment` は `type` と `value` を持ち、URI が `moqt://relay.example.com/app#msf:customer-livestream-123--catalog&connection=q` のとき `{ type: "msf", value: "customer-livestream-123--catalog&connection=q" }` になる。消費側は同じ解析を自前で実装しないと `trackNamespace` と `trackName` を得られない

## 設計方針

- `src/index.ts` の MSF の再エクスポートに `parseMsfFragmentValue` と `type MsfFragmentValue` を追加する
  - 名前空間を分けた再エクスポート (`export * as MSF`) は既存の MSF の再エクスポートと重複するため採らない。既存の並びに 1 関数と 1 型を足す
  - 「fragment は内部に留める」方針を、消費側に必要な `parseMsfFragmentValue` とその戻り値の型だけ変える。`getConnectionParameter` / `assertMsfConnectionSupported` などの残りのヘルパーは公開しない
  - 公開するのはこの 2 つだけであり、`Session` に解析済みの値を足す変更は行わない
- `devtools/src/utils/msfFragment.ts` の相対 import を公開 API の import に置き換える
  - 自リポジトリで公開 API を実際に使うことで、公開しても破綻しないことを確かめる
- 公開後の消費側の使い方

  ```ts
  import { connect, parseMsfFragmentValue } from "moqt-js";

  const session = await connect(
    "moqt://relay.example.com/app#msf:customer-livestream-123--catalog&connection=q",
  );
  if (session.fragment?.type === "msf") {
    const { trackNamespace, trackName, parameters } = parseMsfFragmentValue(session.fragment.value);
    // trackNamespace: ["customer", "livestream", "123"]
    // trackName: "catalog"
    // parameters: [["connection", "q"]]

    // 取り出した名前空間とトラック名で購読する (callbacks の object は必須)
    await session.subscribe(trackNamespace, trackName, { object: () => {} });
  }
  ```

## 完了条件

- `import { parseMsfFragmentValue, type MsfFragmentValue } from "moqt-js"` が型検査と実行時の両方で通ること
- `devtools/src/utils/msfFragment.ts` が公開 API を import していること
- `parseMsfFragmentValue` の既存テスト (`src/msf.test.ts` / `src/msf.prop.ts`) が引き続き通ること
- 公開 API として `dist/index.d.ts` に `parseMsfFragmentValue` と `MsfFragmentValue` が現れること
- `vp check` / `vp test run` / `vp run build:devtools` が通ること
- `CHANGES.md` の `## develop` に `[ADD]` として記載すること

## 解決方法

{未着手}
