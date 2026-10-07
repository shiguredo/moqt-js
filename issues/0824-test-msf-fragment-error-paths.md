# msf fragment 解析の例外契約と Session.fragment の契約を固定するテストが無い

- Created: 2026-10-07
- Completed: {YYYY-MM-DD}
- Branch: feature/test-msf-fragment-error-paths
- Polished: {YYYY-MM-DD}

## 目的

`parseMsfFragmentValue` は `README.md` と `docs/MSF.md` で公開 API として案内しており、`README.md` は「解析できない値では `Error` を投げる」という契約を書いている。しかし `src/msf.test.ts` が固定している例外は `.2D` (大文字 hex) / `~` / `?` / `--` 欠落の 4 件だけで、到達可能な他の条件が未テストである。また `Session.fragment` が返す生の値から解析 API へ渡す経路も、テストで固定されていない。

## 現状

- `parseMsfFragmentValue` が throw する条件のうち、テストがあるのは次だけである (`src/msf.test.ts`)
  - 大文字 hex の percent-encoding (`ns.2D--track`)
  - unreserved でない literal (`ns~name--track`)
  - `?` の混入
  - `--` 区切りが無い入力
- 次の到達可能な条件は、どのテストファイルにも入力が無い
  - 空文字列 / 空の track-identifier (`&a=b`)
  - 空の track name (`ns--`)。受理するかは `issues/` の空 Track Name の issue の判断に従う
  - `.HH` が途中で終わる入力 (`ns.2--track`)
  - `key=value` 形式でない parameter (`ns--track&novalue`)
  - 空の parameter key (`ns--track&=x`)
  - percent-encoded byte が UTF-8 でない入力 (`ns.ff--track`)
- `src/msf.prop.ts` は正しい `key=value` しか生成しないため、parameter の error path には到達しない
- `Session.fragment` を検証するテストは無い。`src/moqUri.test.ts` は `normalizeMoqtUri` の戻り値だけを対象にしており、`src/connect.test.ts` は c4m の解決経由で「`value` に `msf:` が含まれない」ことを間接的に前提にしているだけである

## 設計方針

- `src/msf.test.ts` の `parseMsfFragmentValue` のテスト群に、上記の未テスト条件を 1 条件 1 テストで足し、入力とエラーメッセージの対応を固定する。`src/msf.prop.ts` で到達できないことが根拠であり、PBT へ移さない
- `Session.fragment` の契約は `src/connect.test.ts` に足す。`installSetupHandshakeTransport()` を使い、fragment 付きの MOQT URI で `connect()` した `Session.fragment` が `{ type: "msf", value: ... }` になり、その `value` を `parseMsfFragmentValue` に渡すと期待値が返ること、fragment が無い URI では `null` になることを固定する
- モックやスタブは使わず、既存の connect テストと同じ手順で実際の接続確立を使う
- 実装の挙動は変えない。テストのみを追加する
- `CHANGES.md` は `.md` 以外の変更ではないが、テストのみの変更でありリポジトリの慣行 (テスト追加は `[ADD]` に含める) に合わせて判断する

## 完了条件

- 上記の未テスト条件それぞれに、入力とエラーメッセージの対応を固定するテストがある (空の Track Name は別 issue の判断に従う)
- `Session.fragment` の契約 (`{ type: "msf", value }` / `parseMsfFragmentValue` に渡せる / fragment 無しは `null`) を固定するテストがある
- `vp check` / `vp test run` が通る
- モック・スタブを追加していない

## 参照

- `src/msf/fragment.ts` の `parseMsfFragmentValue` と `@throws`
- `src/msf.test.ts` の `parseMsfFragmentValue` のテスト群 / `src/msf.prop.ts`
- `src/connect.test.ts` の `installSetupHandshakeTransport` / `src/moqUri.ts` の `MoqtFragment` / `src/session.ts` の `Session.fragment`
- `README.md` の「実装状況 > MOQT Streaming Format > URI / 認可」

## 解決方法

{未着手}
