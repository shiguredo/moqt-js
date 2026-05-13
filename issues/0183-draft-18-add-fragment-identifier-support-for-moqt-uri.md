# moqt URI の Fragment Identifier をパースし Session で公開する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で moqt URI に Fragment Identifier が導入された。fragment はサーバーに送信されず、
セッション確立後にクライアントがローカルで処理する。

> Fragment identifiers MAY be used with moqt URIs. The fragment is not
> transmitted to the server; it is processed locally by the client
> after establishing the MOQT session.
>
> A moqt URI fragment MUST begin with a registered fragment type
> identifier, followed by a colon (:), followed by a type-specific
> value:
>
> moqt://example.com/app#<type>:<value>
>
> Fragment type identifiers MUST consist of ASCII lowercase letters,
> digits, and hyphens (a-z, 0-9, -).
>
> -- draft-ietf-moq-transport-18 §3.1.2

> This registry is initially empty.
>
> -- draft-ietf-moq-transport-18 §15.3

fragment type registry (§15.3) は現時点で登録済み type がゼロである。
よって本 issue では fragment のパース・検証・Session 経由での公開までを実装し、
具体的な subscribe/fetch への自動変換は将来の fragment type 登録後に別 issue で扱う。

## 変更内容

### 1. fragment パース関数を新設する (`src/moqtUri.ts` を新設する)

- `parseFragment(fragment: string): { type: string; value: string }` を実装する
- `#` を除去し、最初の `:` で type と value に分割する
- type の文字種を検証する（英小文字・数字・ハイフンのみ、空文字列は不可）
- 形式違反の場合は `Error` を throw する
  - コロンがない場合: `"fragment must contain a colon separator"`
  - type が空の場合: `"fragment type identifier must not be empty"`
  - type に不正な文字が含まれる場合: `"fragment type identifier must consist of ASCII lowercase letters, digits, and hyphens"`

### 2. `connect()` で fragment をパースし Session に渡す (`src/index.ts`)

- 0182 が `moqt://` → `https://` 変換時に fragment を除去する
- 除去した fragment 文字列を `parseFragment()` でパースする
- パース結果を `SessionImpl` のコンストラクタに渡す

### 3. `Session` インターフェースに `fragment` プロパティを追加する (`src/session.ts`)

- `Session` インターフェースに読み取り専用プロパティ `fragment: { type: string; value: string } | null` を追加する
- fragment が指定されなかった場合は `null`
- `SessionImpl` でコンストラクタ経由で受け取った値を保持する

### 4. devtools の ConnectionSettings に fragment 入力欄を追加する

- `devtools/src/signals/connectionSettings.ts` に `fragment` signal を追加する（デフォルト空文字列）
- `devtools/src/components/ConnectionSettings.tsx` に fragment 入力用のテキストフィールドを追加する
- 入力された fragment を URL に連結して `connect()` に渡す

## 該当箇所

| ファイル                                                 | 変更内容                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `src/moqtUri.ts` (新設)                                  | `parseFragment()` 関数を実装する                             |
| `src/index.ts:184-212`                                   | `connect()` 内で fragment をパースし `SessionImpl` に渡す    |
| `src/session.ts:602-675`                                 | `Session` インターフェースに `fragment` プロパティを追加する |
| `src/session.ts` (SessionImpl)                           | コンストラクタで fragment を受け取り保持する                 |
| `devtools/src/signals/connectionSettings.ts:14`          | `fragment` signal を追加する                                 |
| `devtools/src/components/ConnectionSettings.tsx:299-306` | fragment 入力フィールドを追加する                            |

## 期待される動作

- `connect("moqt://example.com/moqt#track:video")` → `session.fragment` は `{ type: "track", value: "video" }`
- `connect("moqt://example.com/moqt#ns:room/123")` → `session.fragment` は `{ type: "ns", value: "room/123" }`
- `connect("moqt://example.com/moqt")` → `session.fragment` は `null`
- `connect("moqt://example.com/moqt#novalue")` → `Error` を throw（コロンなし）
- `connect("moqt://example.com/moqt#:value")` → `Error` を throw（type が空）
- `connect("moqt://example.com/moqt#TYPE:value")` → `Error` を throw（type に大文字が含まれる）
- `connect("moqt://example.com/moqt#type:val:ue")` → `session.fragment` は `{ type: "type", value: "val:ue" }`（最初のコロンで分割）
- `connect("https://example.com/moqt#track:video")` → `session.fragment` は `{ type: "track", value: "video" }`（後方互換の https:// でも動作）

## テスト方針

### 単体テスト (`src/moqtUri.test.ts` を新設する)

- 正しい形式 `#type:value` が正しくパースされること
- コロンがない場合にエラーになること
- type が空の場合にエラーになること
- type に大文字が含まれる場合にエラーになること
- type に記号が含まれる場合にエラーになること
- value にコロンが含まれる場合でも正しく分割されること
- value が空でも受理されること (`#type:` → `{ type: "type", value: "" }`)
- 空文字列がエラーになること

## 影響範囲

- `Session` インターフェースに `fragment` プロパティが追加される（後方互換あり、null 許容）
- `connect()` の内部実装に fragment パースが追加される（API シグネチャに変更なし）
- devtools の ConnectionSettings UI に fragment 入力欄が追加される

## 関連 issue

- 0182: `connect()` の URL を `moqt://` スキームに対応させる（fragment 除去を担当。0182 を先に実装する）
- 0183 は 0182 に依存する。0182 で fragment が除去され、0183 でその除去後の値をパースして保存する
- fragment type が登録された後、subscribe/fetch への自動変換は別 issue で扱う

## 備考

- 現時点では fragment type registry が空のため、type 名の登録確認は行わない（全 type が未知）
- アプリケーションは `session.fragment` を参照し、独自に fragment type に応じた処理を実装できる
- `createMediaPublisher` / `createMediaSubscriber` は `connect()` が返す Session 経由で fragment にアクセス可能なため、変更不要
