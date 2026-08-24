import { defineConfig } from "vite-plus";
import { resolve, dirname, basename, extname } from "node:path";
import packageJson from "./package.json" with { type: "json" };

/**
 * Vite の ?worker インポートを tsdown / Rolldown でも扱えるようにするプラグイン。
 * ?worker で import されたワーカーは別 chunk として出力し、default export を
 * そのワーカー URL で初期化する Worker コンストラクタに置き換える。
 */
function moqtWorkerPlugin(): {
  name: string;
  resolveId(source: string, importer?: string): string | null;
  load(
    this: { emitFile: (asset: { type: "chunk"; id: string; fileName?: string }) => string },
    id: string,
  ): string | null;
} {
  return {
    name: "moqt-worker",
    resolveId(source, importer) {
      if (!source.endsWith("?worker")) {
        return null;
      }
      if (importer === undefined) {
        return null;
      }
      const base = source.slice(0, -"?worker".length);
      return resolve(dirname(importer), base) + "?worker";
    },
    load(id) {
      if (!id.endsWith("?worker")) {
        return null;
      }
      const workerPath = id.slice(0, -"?worker".length);
      const name = basename(workerPath, extname(workerPath));
      const ref = this.emitFile({
        type: "chunk",
        id: workerPath,
        fileName: `codec/workers/${name}.js`,
      });
      return `export default class extends Worker {
  constructor() {
    super(import.meta.ROLLUP_FILE_URL_${ref}, { type: "module" });
  }
}`;
    },
  };
}

export default defineConfig({
  define: {
    __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      // devtools 配下のテストが "moqt-js" をランタイム import するため、
      // パッケージ名をビルド済み dist ではなくソースへ解決する。
      // CI では dist が未生成のまま `vp test` が走り、パッケージ解決に失敗するため必要。
      "moqt-js": resolve(import.meta.dirname, "src/index.ts"),
    },
  },
  pack: {
    entry: resolve(import.meta.dirname, "src/index.ts"),
    format: ["esm"],
    outDir: "dist",
    dts: true,
    platform: "neutral",
    fromVite: true,
    define: {
      __MOQT_JS_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: [moqtWorkerPlugin()],
  },
  fmt: {
    ignorePatterns: ["dist/**", "devtools/dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**", "devtools/**", "examples/**", "tests/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    plugins: ["typescript", "oxc", "unicorn", "import", "promise", "react", "vitest"],
    categories: {
      // 明らかに間違っているコード
      correctness: "error",
      // パフォーマンスに影響するコード
      perf: "error",
      // 疑わしいコード
      suspicious: "error",
      // 厳格なルール
      pedantic: "error",
      // 制限ルールは個別に設定
      restriction: "off",
      // スタイルルール
      style: "error",
    },
    rules: {
      // ===== eslint: プロジェクト特性上無効化 =====
      // const 値と type の同名宣言 (`const X = {} as const` + `type X = ...`) は
      // TypeScript の値と型の名前空間分離によって意図的に成立させるため無効化
      "no-redeclare": "off",
      // 複数の const 宣言を 1 文に結合することを強制するルール。プロトコル実装では
      // エンコード処理を仕様と 1 対 1 で対応させるため宣言を 1 行 1 つに保つので無効化
      "one-var": "off",
      // プロトコル実装でバイトオフセット・サイズ指定・ビットマスク等に数値リテラルが必須
      "no-magic-numbers": "off",
      // 三項演算子は可読性を損なわない範囲で使用
      "no-ternary": "off",
      // 関数宣言と関数式の混在を許容
      "func-style": "off",
      // プロトコル実装で短い変数名 (id, ts 等) が必要
      "id-length": "off",
      // let 変数の条件分岐後の初期化パターンで必要
      "init-declarations": "off",
      // プロトコル処理関数は必然的に大きくなる
      "max-lines-per-function": "off",
      // プロトコル関数で引数が多くなる場合がある
      "max-params": "off",
      // プロトコル実装ファイルは必然的に大きくなる
      "max-lines": "off",
      // 逐次処理で await in loop が必要な場合がある
      "no-await-in-loop": "off",

      // import の並び順はフォーマッタに任せる
      "sort-imports": "off",
      // 日本語コメントには大文字小文字の概念がない
      "capitalized-comments": "off",
      // 16 進リテラルの大文字小文字はプロトコル仕様に合わせる
      "unicorn/number-literal-case": "off",
      // 数値区切りは既存コードに合わせる
      "unicorn/numeric-separators-style": "off",
      // querySelector よりも getElementById 等の直接メソッドを許容
      "unicorn/prefer-query-selector": "off",
      // switch case の波括弧スタイルは既存コードに合わせる
      "unicorn/switch-case-braces": "off",
      // catch 変数名は error 以外も許容 (e 等)
      "unicorn/catch-error-name": "off",
      // ネスト三項演算子は複雑な条件分岐で使用
      "unicorn/no-nested-ternary": "off",
      "no-nested-ternary": "off",
      // sort() は比較的安全に使用
      "unicorn/no-array-sort": "off",
      // 連続する Array#push() の単一呼び出しへの結合を強制するルール。
      // プロトコルエンコーダは 1 行 1 ワイヤフォーマットフィールドで
      // parts.push() する規約のため、結合すると仕様と行の対応が崩れる
      "unicorn/prefer-single-call": "off",
      // fast-check の arbitraries は fc.array(fc.string(...)) のように
      // ネストして組み立てるのが自然なため、呼び出し深さ制限は無効化する
      "unicorn/max-nested-calls": "off",
      // channelConfig 等の文字列から基数 10 で整数化する箇所では
      // Number.parseInt(..., 10) の意図が明確なため無効化する
      "unicorn/prefer-number-coercion": "off",
      // TypeScript のスプレッド構文は既存コードに合わせる
      "unicorn/prefer-spread": "off",
      // Map のスプレッドは既存コードで使用
      "oxc/no-map-spread": "off",
      // prefer-template は既存コードに合わせる
      "prefer-template": "off",
      // prefer-const は let で後から代入するパターンで必要
      "prefer-const": "off",
      // 孤立した if は既存コードに合わせる
      "unicorn/no-lonely-if": "off",
      "no-lonely-if": "off",
      // for-of は配列インデックスが必要な場合に for を使用
      "typescript/prefer-for-of": "off",
      // interface と function type の選択は既存コードに合わせる
      "typescript/prefer-function-type": "off",
      // any は devtools の overrides で許容
      "typescript/no-explicit-any": "off",
      // React hooks の依存配列は既存コードに合わせる
      "react/exhaustive-deps": "off",
      // Promise コンストラクタのパラメータ名は既存コードに合わせる
      "promise/param-names": "off",
      // no-console は src で 1 箇所のみ残っており対応不要
      "no-console": "off",
      // arrow-body-style は既存コードに合わせる
      "arrow-body-style": "off",
      // DOM 操作は既存パターンに合わせる
      "unicorn/prefer-dom-node-append": "off",
      "unicorn/prefer-at": "off",
      "unicorn/prefer-code-point": "off",
      "unicorn/prefer-type-error": "off",
      "unicorn/prefer-string-slice": "off",
      "unicorn/relative-url-style": "off",
      "unicorn/no-array-for-each": "off",
      "unicorn/no-unreadable-array-destructuring": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/no-array-reverse": "off",
      "unicorn/no-useless-undefined": "off",
      // テスト以外での non-null-assertion は避けるべきだが既存コードに合わせる
      "typescript/no-non-null-assertion": "off",
      // TypeScript の parameter-properties は許容
      "typescript/parameter-properties": "off",
      // import の重複は type import 分離で発生する
      "import/no-duplicates": "off",
      // 循環依存は既存アーキテクチャで避けられない
      "import/no-cycle": "off",
      // promise の always-return は既存コードに合わせる
      "promise/always-return": "off",
      // promise の catch-or-return は既存コードに合わせる
      "promise/catch-or-return": "off",
      // type import スタイルは既存コードに合わせる
      "typescript/consistent-type-imports": "off",
      // .then() パターンは既存コードで使用
      "promise/prefer-await-to-then": "off",
      // Promise.all のコールバックで await を許容
      "promise/prefer-await-to-callbacks": "off",
      // prefer-catch は既存コードに合わせる
      "promise/prefer-catch": "off",
      // 否定条件が明確な場合がある
      "no-negated-condition": "off",
      // type import の specifier スタイルは既存コードに合わせる
      "import/consistent-type-specifier-style": "off",
      // vitest のグローバル import パターンは既存コードに合わせる
      "vitest/no-importing-vitest-globals": "off",
      // 分割代入が常に可読とは限らない
      "prefer-destructuring": "off",
      // 1 ファイル複数クラスはコーデック実装で必要
      "max-classes-per-file": "off",
      // オブジェクトキーの並び順は可読性重視で手動管理
      "sort-keys": "off",
      // this を使用しないメソッドはインターフェース準拠で必要な場合がある
      "class-methods-use-this": "off",
      // no-shadow は TypeScript の型と変数の区別ができないため無効化
      "no-shadow": "off",
      // interface 準拠で async が必要だが await しない場合がある
      "require-await": "off",
      // 引数の再代入はプロトコル処理のオフセット更新等で必要
      "no-param-reassign": "off",
      // complexity は max: 20 で設定済みだが一部超過を許容
      complexity: ["error", { max: 40 }],
      // max-statements は max: 50 で設定済みだが一部超過を許容
      "max-statements": ["error", { max: 100 }],
      // ネスト深度はプロトコル処理で避けられない
      "max-depth": "off",
      // 末尾コメントは RFC 参照等で使用
      "no-inline-comments": "off",
      // continue はループ制御で有用
      "no-continue": "off",
      // TODO/FIXME コメントは issues で管理
      "no-warning-comments": "off",
      // WebCodecs API 等の PascalCase コンストラクタで必要
      "new-cap": "off",

      // ===== eslint: 危険なコードの禁止 =====
      // no-console は上部で無効化済み
      // debugger 文の使用を禁止
      "no-debugger": "error",
      // alert/confirm/prompt の使用を禁止
      "no-alert": "error",
      // eval() の使用を禁止
      "no-eval": "error",
      // new Function() の使用を禁止
      "no-new-func": "error",
      // javascript: URL の使用を禁止
      "no-script-url": "error",
      // fire-and-forget Promise パターン (void promise) で必要
      "no-void": "off",
      // with 文の使用を禁止
      "no-with": "error",

      // ===== eslint: 比較と変数 =====
      // 厳密等価演算子 (===, !==) を強制
      eqeqeq: "error",
      // var の使用を禁止 (let/const を使用)
      "no-var": "error",
      // 波括弧スタイルはフォーマッタに任せる
      curly: "off",
      // for-in ループで hasOwnProperty チェックを強制
      "guard-for-in": "error",

      // ===== eslint: 非推奨機能の禁止 =====
      // arguments.caller/callee の使用を禁止
      "no-caller": "error",
      // ネイティブオブジェクトの拡張を禁止
      "no-extend-native": "error",
      // 不要な bind() の使用を禁止
      "no-extra-bind": "error",
      // __iterator__ プロパティの使用を禁止
      "no-iterator": "error",
      // ラベル付き文の使用を禁止
      "no-labels": "error",
      // 不要なブロックの使用を禁止
      "no-lone-blocks": "error",
      // 複数行文字列 (バックスラッシュ) の使用を禁止
      "no-multi-str": "error",
      // プリミティブラッパーの new を禁止
      "no-new-wrappers": "error",
      // __proto__ プロパティの使用を禁止
      "no-proto": "error",

      // ===== eslint: コード品質 =====
      // return 文での代入を禁止
      "no-return-assign": "error",
      // 自己比較を禁止
      "no-self-compare": "error",
      // カンマ演算子の使用を禁止
      "no-sequences": "error",
      // リテラル値の throw を禁止 (Error オブジェクトを使用)
      "no-throw-literal": "error",
      // 未使用の式を禁止
      "no-unused-expressions": "error",
      // 不要な call()/apply() を禁止
      "no-useless-call": "error",
      // 不要な文字列連結を禁止
      "no-useless-concat": "error",

      // ===== eslint: モダン構文の推奨 =====
      // Math.pow() より ** 演算子を推奨
      "prefer-exponentiation-operator": "error",
      // Object.assign() よりスプレッド構文を推奨
      "prefer-object-spread": "error",
      // arguments より rest パラメータを推奨
      "prefer-rest-params": "error",
      // apply() よりスプレッド構文を推奨
      "prefer-spread": "error",
      // prefer-template は上部で無効化済み
      // parseInt() で基数を明示
      radix: "error",
      // Symbol に説明を必須
      "symbol-description": "error",

      // ===== eslint: 複雑度の制限 =====
      // 循環的複雑度と関数内ステートメント数は上部で設定済み

      // ===== eslint: パフォーマンスと正確性 =====
      // 配列メソッドのコールバックで return を強制
      "array-callback-return": "error",
      // コンストラクタでの return を禁止
      "no-constructor-return": "error",
      // Promise executor での return を禁止
      "no-promise-executor-return": "error",
      // Object.prototype メソッドの直接呼び出しを禁止
      "no-prototype-builtins": "error",
      // var のブロックスコープ外使用を禁止
      "block-scoped-var": "error",
      // new の結果を使用しない場合を禁止
      "no-new": "error",
      // 不要なコンストラクタを禁止
      "no-useless-constructor": "error",

      // ===== eslint: スタイル =====
      // switch の default を最後に配置
      "default-case-last": "error",
      // デフォルト引数を最後に配置
      "default-param-last": "error",
      // getter/setter をグループ化
      "grouped-accessor-pairs": "error",
      // 不要な計算プロパティを禁止
      "no-useless-computed-key": "error",
      // type import と value import の分離が必要なため無効化
      "no-duplicate-imports": "off",
      // Object.hasOwn() を推奨
      "prefer-object-has-own": "error",
      // parseInt より数値リテラルを推奨
      "prefer-numeric-literals": "error",
      // arrow-body-style は上部で無効化済み
      // Yoda 条件を禁止 (if (5 === x) → if (x === 5))
      yoda: "error",
      // 不要な else を禁止
      "no-else-return": "error",
      // 否定条件は上部で無効化済み
      // new Object() を禁止
      "no-object-constructor": "error",
      // 不要な return を禁止
      "no-useless-return": "error",
      // 引数の再代入は上部で無効化済み
      // class-methods-use-this は上部で無効化済み

      // ===== typescript: type-aware ルールの無効化 =====
      // WebCodecs API や Worker で any 型が避けられない
      "typescript/no-unsafe-member-access": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-return": "off",
      // 厳密な boolean 式は既存コードに合わせる
      "typescript/strict-boolean-expressions": "off",
      // void 式の混乱は既存コードに合わせる
      "typescript/no-confusing-void-expression": "off",
      // 冗長な型構成要素は既存コードに合わせる
      "typescript/no-redundant-type-constituents": "off",
      // Promise の誤用チェックは既存コードに合わせる
      "typescript/no-misused-promises": "off",
      // 非推奨 API の警告は既存コードに合わせる
      "typescript/no-deprecated": "off",
      // switch の網羅性チェックは既存コードに合わせる
      "typescript/switch-exhaustiveness-check": "off",
      // 不要な型引数は既存コードに合わせる
      "typescript/no-unnecessary-type-arguments": "off",
      // Promise を返す関数の async 強制は既存コードに合わせる
      "typescript/promise-function-async": "off",
      // Promise.reject で Error を強制は既存コードに合わせる
      "typescript/prefer-promise-reject-errors": "off",

      // ===== typescript: 非同期処理 =====
      // 非 Promise の await を禁止
      "typescript/await-thenable": "error",
      // 配列の delete を禁止 (splice を使用)
      "typescript/no-array-delete": "error",
      // toString() が意味のある値を返さないオブジェクトを検出
      "typescript/no-base-to-string": "error",
      // no-confusing-void-expression, no-deprecated は上部で無効化済み
      // 重複する型構成要素を禁止
      "typescript/no-duplicate-type-constituents": "error",
      // 未処理の Promise を禁止
      "typescript/no-floating-promises": "error",
      // 配列への for-in を禁止
      "typescript/no-for-in-array": "error",
      // 暗黙の eval を禁止
      "typescript/no-implied-eval": "error",
      // 無意味な void 演算子を禁止
      "typescript/no-meaningless-void-operator": "error",
      // 上部で無効化済み
      // "typescript/no-misused-promises": "error",
      // 不適切なスプレッドを禁止
      "typescript/no-misused-spread": "error",
      // 異なる型の enum 混在を禁止
      "typescript/no-mixed-enums": "error",
      // 上部で無効化済み
      // "typescript/no-redundant-type-constituents": "error",

      // ===== typescript: 不要なコードの検出 =====
      // 不要な boolean リテラル比較を禁止
      "typescript/no-unnecessary-boolean-literal-compare": "error",
      // 不要なテンプレート式を禁止
      "typescript/no-unnecessary-template-expression": "error",
      // 上部で無効化済み
      // "typescript/no-unnecessary-type-arguments": "error",
      // 不要な型アサーションを禁止
      "typescript/no-unnecessary-type-assertion": "error",

      // ===== typescript: 型安全性 =====
      // 上部で無効化済み
      // "typescript/no-unsafe-argument": "error",
      // 上部で無効化済み
      // "typescript/no-unsafe-assignment": "error",
      // 上部で無効化済み
      // "typescript/no-unsafe-call": "error",
      // 安全でない enum 比較を禁止
      "typescript/no-unsafe-enum-comparison": "error",
      // 上部で無効化済み
      // "typescript/no-unsafe-member-access": "error",
      // 上部で無効化済み
      // "typescript/no-unsafe-return": "error",
      // 上部で無効化済み
      // "typescript/no-unsafe-type-assertion": "error",
      // 安全でない単項マイナスを禁止
      "typescript/no-unsafe-unary-minus": "error",

      // ===== typescript: モダン構文の推奨 =====
      // 非 null アサーションのスタイル統一
      "typescript/non-nullable-type-assertion-style": "error",
      // Error オブジェクトのみを throw
      "typescript/only-throw-error": "error",
      // indexOf より includes を推奨
      "typescript/prefer-includes": "error",
      // || より ?? を推奨
      "typescript/prefer-nullish-coalescing": "error",
      // 上部で無効化済み
      // "typescript/prefer-promise-reject-errors": "error",
      // reduce の型パラメータを推奨
      "typescript/prefer-reduce-type-parameter": "error",
      // this 型の return を推奨
      "typescript/prefer-return-this-type": "error",
      // 上部で無効化済み
      // "typescript/promise-function-async": "error",
      // getter/setter の型を一致させる
      "typescript/related-getter-setter-pairs": "error",
      // sort() で比較関数を必須
      "typescript/require-array-sort-compare": "error",
      // interface 準拠で async が必要だが await しない場合がある
      "typescript/require-await": "off",
      // + 演算子のオペランドを制限
      "typescript/restrict-plus-operands": "error",
      // テンプレート式のオペランドを制限
      "typescript/restrict-template-expressions": "error",
      // async 関数で return await を強制
      "typescript/return-await": "error",
      // 上部で無効化済み
      // "typescript/strict-boolean-expressions": "error",
      // 上部で無効化済み
      // "typescript/switch-exhaustiveness-check": "error",
      // メソッドの this バインドを強制
      "typescript/unbound-method": "error",
      // catch コールバックで unknown 型を使用
      "typescript/use-unknown-in-catch-callback-variable": "error",

      // ===== typescript: enum =====
      // enum の重複値を禁止
      "typescript/no-duplicate-enum-values": "error",
      // no-explicit-any は上部で無効化済み

      // ===== typescript: null/undefined =====
      // 余分な非 null アサーションを禁止
      "typescript/no-extra-non-null-assertion": "error",
      // オプショナルチェーン後の非 null アサーションを禁止
      "typescript/no-non-null-asserted-optional-chain": "error",
      // 上部で無効化済み
      // "typescript/no-non-null-assertion": "error",

      // ===== typescript: その他 =====
      // this のエイリアスを禁止
      "typescript/no-this-alias": "error",
      // as const を推奨
      "typescript/prefer-as-const": "error",
      // prefer-for-of, prefer-function-type は上部で無効化済み
      // enum メンバーにリテラル値を推奨
      "typescript/prefer-literal-enum-member": "error",

      // ===== typescript: スタイル =====
      // Record 型を推奨
      "typescript/consistent-indexed-object-style": ["error", "record"],
      // interface を推奨
      "typescript/consistent-type-definitions": ["error", "interface"],
      // consistent-type-imports は上部で無効化済み
      // 配列型のスタイルは既存コードに合わせる
      "typescript/array-type": "off",
      // ts-expect-error 指令には説明を必須にする
      "typescript/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
        },
      ],
      // tslint コメントを禁止
      "typescript/ban-tslint-comment": "error",
      // 関数の戻り値型は overrides で制御
      "typescript/explicit-function-return-type": "off",
      // 紛らわしい非 null アサーションを禁止
      "typescript/no-confusing-non-null-assertion": "error",
      // 動的 delete を禁止
      "typescript/no-dynamic-delete": "error",
      // 空のオブジェクト型を禁止
      "typescript/no-empty-object-type": "error",
      // 不要なクラスを禁止
      "typescript/no-extraneous-class": "error",
      // import type の副作用は既存コードに合わせる
      "typescript/no-import-type-side-effects": "off",
      // 推論可能な型の明示を禁止
      "typescript/no-inferrable-types": "error",
      // 無効な void 型を禁止
      "typescript/no-invalid-void-type": "error",
      // namespace を禁止
      "typescript/no-namespace": "error",
      // require() を禁止
      "typescript/no-require-imports": "error",
      // 不要な空 export を禁止
      "typescript/no-useless-empty-export": "error",
      // ラッパーオブジェクト型を禁止
      "typescript/no-wrapper-object-types": "error",
      // 安全でない宣言マージを禁止
      "typescript/no-unsafe-declaration-merging": "error",
      // 安全でない Function 型を禁止
      "typescript/no-unsafe-function-type": "error",
      // enum 初期化子を推奨
      "typescript/prefer-enum-initializers": "error",
      // namespace キーワードを推奨
      "typescript/prefer-namespace-keyword": "error",
      // トリプルスラッシュ参照を禁止
      "typescript/triple-slash-reference": "error",
      // オーバーロードシグネチャを隣接配置
      "typescript/adjacent-overload-signatures": "error",
      // ジェネリクスコンストラクタのスタイル統一
      "typescript/consistent-generic-constructors": "error",
      // 不要な型制約を禁止
      "typescript/no-unnecessary-type-constraint": "error",

      // ===== oxc: バグ検出 =====
      // Math.PI などの近似定数を検出
      "oxc/approx-constant": "error",
      // arguments への配列メソッド適用を禁止
      "oxc/bad-array-method-on-arguments": "error",
      // プロトコル実装でビット演算 (|=) は正当に使用する
      "oxc/bad-bitwise-operator": "off",
      // charAt() の誤った比較を検出
      "oxc/bad-char-at-comparison": "error",
      // 誤った比較シーケンスを検出
      "oxc/bad-comparison-sequence": "error",
      // Math.min/max の誤用を検出
      "oxc/bad-min-max-func": "error",
      // オブジェクトリテラルの誤った比較を検出
      "oxc/bad-object-literal-comparison": "error",
      // replaceAll の誤った引数を検出
      "oxc/bad-replace-all-arg": "error",
      // 定数比較の矛盾を検出
      "oxc/const-comparisons": "error",
      // 二重比較を検出
      "oxc/double-comparisons": "error",
      // 消去演算 (x * 0) を検出
      "oxc/erasing-op": "error",
      // 誤ったリファクタリングによる代入を検出
      "oxc/misrefactored-assign-op": "error",
      // throw の欠落を検出
      "oxc/missing-throw": "error",
      // ループ内スプレッドの蓄積を禁止
      "oxc/no-accumulating-spread": "error",
      // 範囲外の数値引数を検出
      "oxc/number-arg-out-of-range": "error",
      // 再帰でのみ使用される引数を検出
      "oxc/only-used-in-recursion": "error",
      // 未呼び出しの配列コールバックを検出
      "oxc/uninvoked-array-callback": "error",
      // no-map-spread は上部で無効化済み

      // ===== unicorn: プロジェクト特性上無効化 =====
      // 既存ファイル名の変更は破壊的なため無効化 (PascalCase のクラスファイル等)
      "unicorn/filename-case": "off",
      // Worker の postMessage で targetOrigin は不要
      "unicorn/require-post-message-target-origin": "off",
      // Worker の onmessage パターンで addEventListener は冗長
      "unicorn/prefer-add-event-listener": "off",
      // globalThis の推奨は Worker 環境で複雑になる
      "unicorn/prefer-global-this": "off",

      // ===== unicorn: エラー処理 =====
      // catch 変数名は上部で無効化済み
      // 空配列スプレッドの一貫性
      "unicorn/consistent-empty-array-spread": "error",
      // 存在チェックのインデックス一貫性
      "unicorn/consistent-existence-index-check": "error",
      // 上部で無効化済み
      // "unicorn/consistent-function-scoping": "error",
      // Date クローンの一貫性
      "unicorn/consistent-date-clone": "error",
      // Error メッセージを必須
      "unicorn/error-message": "error",

      // ===== unicorn: コードスタイル =====
      // エスケープシーケンスの大文字化
      "unicorn/escape-case": "error",
      // 明示的な length チェック
      "unicorn/explicit-length-check": "error",
      // ビルトインの new 使用を統一
      "unicorn/new-for-builtins": "error",

      // ===== unicorn: 禁止パターン =====
      // eslint-disable の乱用を禁止
      "unicorn/no-abusive-eslint-disable": "error",
      // アクセサの再帰を禁止
      "unicorn/no-accessor-recursion": "error",
      // 内部使用と再エクスポートを兼ねる型 import + re-export パターン。
      // 多くの公開 API ファイル (createMediaPublisher.ts / createMediaSubscriber.ts /
      // error.ts) は内部実装で使った型をそのまま公開するため、import のみに統一する
      "unicorn/prefer-export-from": "off",
      // 配列コールバック参照を禁止
      "unicorn/no-array-callback-reference": "error",
      // 上部で無効化済み
      // "unicorn/no-array-for-each": "error",
      // 配列メソッドの this 引数を禁止
      "unicorn/no-array-method-this-argument": "error",
      // 上部で無効化済み
      // "unicorn/no-array-reduce": "error",
      // await 式のメンバーアクセスを禁止
      "unicorn/no-await-expression-member": "error",
      // Promise メソッド内の await を禁止
      "unicorn/no-await-in-promise-methods": "error",
      // 空ファイルを禁止
      "unicorn/no-empty-file": "error",
      // 16 進エスケープを禁止
      "unicorn/no-hex-escape": "error",
      // Uint8Array の即座の set 等で必要なパターン
      "unicorn/no-immediate-mutation": "off",
      // Array の instanceof を禁止
      "unicorn/no-instanceof-array": "error",
      // ビルトインの instanceof を禁止
      "unicorn/no-instanceof-builtins": "error",
      // 無効な fetch オプションを禁止
      "unicorn/no-invalid-fetch-options": "error",
      // slice の終端に length を禁止
      "unicorn/no-length-as-slice-end": "error",
      // 上部で無効化済み
      // "unicorn/no-lonely-if": "error",
      // マジックナンバーの flat 深度を禁止
      "unicorn/no-magic-array-flat-depth": "error",
      // 等価チェックでの否定を禁止
      "unicorn/no-negation-in-equality-check": "error",
      // ネストした三項演算子は上部で無効化済み
      // new Array() を禁止
      "unicorn/no-new-array": "error",
      // new Buffer() を禁止
      "unicorn/no-new-buffer": "error",
      // null を許可 (undefined との使い分けが必要なため)
      "unicorn/no-null": "off",
      // デフォルト引数にオブジェクトを禁止
      "unicorn/no-object-as-default-parameter": "error",
      // 単一 Promise の Promise メソッドを禁止
      "unicorn/no-single-promise-in-promise-methods": "error",
      // static のみのクラスを禁止
      "unicorn/no-static-only-class": "error",
      // thenable オブジェクトを禁止
      "unicorn/no-thenable": "error",
      // this の代入を禁止
      "unicorn/no-this-assignment": "error",
      // typeof undefined を禁止
      "unicorn/no-typeof-undefined": "error",
      // 不要な await を禁止
      "unicorn/no-unnecessary-await": "error",
      // 不要な slice 終端を禁止
      "unicorn/no-unnecessary-slice-end": "error",
      // 上部で無効化済み
      // "unicorn/no-unreadable-array-destructuring": "error",
      // 読みづらい IIFE を禁止
      "unicorn/no-unreadable-iife": "error",
      // 不要なスプレッドフォールバックを禁止
      "unicorn/no-useless-fallback-in-spread": "error",
      // 不要な length チェックを禁止
      "unicorn/no-useless-length-check": "error",
      // 不要な Promise.resolve/reject を禁止
      "unicorn/no-useless-promise-resolve-reject": "error",
      // 不要なスプレッドを禁止
      "unicorn/no-useless-spread": "error",
      // 不要な switch case を禁止
      "unicorn/no-useless-switch-case": "error",
      // 上部で無効化済み
      // "unicorn/no-useless-undefined": "error",
      // 不要な小数部を禁止 (1.0 → 1)
      "unicorn/no-zero-fractions": "error",

      // ===== unicorn: 数値リテラル =====
      // number-literal-case, numeric-separators-style は上部で無効化済み

      // ===== unicorn: モダン API の推奨 =====
      // find を推奨
      "unicorn/prefer-array-find": "error",
      // flatMap を推奨
      "unicorn/prefer-array-flat-map": "error",
      // flat を推奨
      "unicorn/prefer-array-flat": "error",
      // indexOf を推奨
      "unicorn/prefer-array-index-of": "error",
      // some を推奨
      "unicorn/prefer-array-some": "error",
      // 上部で無効化済み
      // "unicorn/prefer-at": "error",
      // 上部で無効化済み
      // "unicorn/prefer-code-point": "error",
      // Date.now() を推奨
      "unicorn/prefer-date-now": "error",
      // デフォルトパラメータを推奨
      "unicorn/prefer-default-parameters": "error",
      // globalThis の推奨は Worker 環境で複雑になるため上部で無効化済み
      // no-ternary を無効化しているため prefer-ternary も無効化
      "unicorn/prefer-ternary": "off",
      // 論理演算子を三項演算子より推奨
      "unicorn/prefer-logical-operator-over-ternary": "error",
      // Math.min/max を推奨
      "unicorn/prefer-math-min-max": "error",
      // Math.trunc を推奨
      "unicorn/prefer-math-trunc": "error",
      // モダンな Math API を推奨
      "unicorn/prefer-modern-math-apis": "error",
      // ネイティブ型変換関数を推奨
      "unicorn/prefer-native-coercion-functions": "error",
      // 負のインデックスを推奨
      "unicorn/prefer-negative-index": "error",
      // Number プロパティを推奨
      "unicorn/prefer-number-properties": "error",
      // Object.fromEntries を推奨
      "unicorn/prefer-object-from-entries": "error",
      // オプショナル catch バインディングを推奨
      "unicorn/prefer-optional-catch-binding": "error",
      // プロトタイプメソッドを推奨
      "unicorn/prefer-prototype-methods": "error",
      // Reflect.apply を推奨
      "unicorn/prefer-reflect-apply": "error",
      // RegExp.test を推奨
      "unicorn/prefer-regexp-test": "error",
      // Set.has を推奨
      "unicorn/prefer-set-has": "error",
      // Set.size を推奨
      "unicorn/prefer-set-size": "error",
      // 上部で無効化済み
      // "unicorn/prefer-spread": "error",
      // String.raw を推奨
      "unicorn/prefer-string-raw": "error",
      // replaceAll を推奨
      "unicorn/prefer-string-replace-all": "error",
      // 上部で無効化済み
      // "unicorn/prefer-string-slice": "error",
      // startsWith/endsWith を推奨
      "unicorn/prefer-string-starts-ends-with": "error",
      // trimStart/trimEnd を推奨
      "unicorn/prefer-string-trim-start-end": "error",
      // structuredClone を推奨
      "unicorn/prefer-structured-clone": "error",
      // トップレベル await を推奨
      "unicorn/prefer-top-level-await": "error",
      // 上部で無効化済み
      // "unicorn/prefer-type-error": "error",

      // ===== unicorn: 必須引数 =====
      // join の区切り文字を必須
      "unicorn/require-array-join-separator": "error",
      // toFixed の桁数を必須
      "unicorn/require-number-to-fixed-digits-argument": "error",

      // ===== unicorn: スタイル =====
      // switch-case-braces は上部で無効化済み
      // テキストエンコーディング識別子の大文字小文字を統一
      "unicorn/text-encoding-identifier-case": "error",
      // new Error() を強制
      "unicorn/throw-new-error": "error",
      // assert の一貫性
      "unicorn/consistent-assert": "error",
      // クラスフィールドを推奨
      "unicorn/prefer-class-fields": "error",
      // 匿名 default export を禁止
      "unicorn/no-anonymous-default-export": "error",

      // ===== import: 正確性 =====
      // default import の存在確認
      "import/default": "error",
      // export の整合性確認
      "import/export": "error",
      // import を先頭に配置 (type import の分離を許容)
      "import/first": "off",
      // named import の存在確認
      "import/named": "error",
      // namespace の存在確認
      "import/namespace": "error",

      // ===== import: 禁止パターン =====
      // 絶対パスの import を禁止
      "import/no-absolute-path": "error",
      // AMD を禁止
      "import/no-amd": "error",
      // CommonJS を禁止
      "import/no-commonjs": "error",
      // 上部で無効化済み
      // "import/no-cycle": "error",
      // 上部で無効化済み
      // "import/no-duplicates": "error",
      // 空の名前付きブロックを禁止
      "import/no-empty-named-blocks": "error",
      // ミュータブルな export を禁止
      "import/no-mutable-exports": "error",
      // default と同名の named export は既存コードに合わせる
      "import/no-named-as-default": "off",
      // default のメンバーアクセスを禁止
      "import/no-named-as-default-member": "error",
      // named として default を import することを禁止
      "import/no-named-default": "error",
      // 自己 import を禁止
      "import/no-self-import": "error",
      // webpack ローダー構文を禁止
      "import/no-webpack-loader-syntax": "error",
      // モジュール判定は上部で無効化済み
      // Node.js モジュールの使用は vite.config 等で必要
      "import/no-nodejs-modules": "off",
      // プロジェクト全体で named export を使用するため無効化
      "import/no-named-export": "off",
      // named export スタイルと矛盾するため無効化
      "import/group-exports": "off",
      // named export スタイルと矛盾するため無効化
      "import/prefer-default-export": "off",
      // export 位置の制約は named export スタイルで不要
      "import/exports-last": "off",
      // import * as パターンを使用するため無効化
      "import/no-namespace": "off",
      // CSS や副作用 import で名前なし import が必要
      "import/no-unassigned-import": "off",
      // モジュール判定は TypeScript に任せる
      "import/unambiguous": "off",

      // ===== promise: 必須パターン =====
      // 上部で無効化済み
      // "promise/always-return": "error",
      // new Promise を許可 (ストリーム処理等で必要)
      "promise/avoid-new": "off",
      // 上部で無効化済み
      // "promise/catch-or-return": "error",

      // ===== promise: 禁止パターン =====
      // Promise 内のコールバックを禁止
      "promise/no-callback-in-promise": "error",
      // 複数回の resolve/reject を禁止
      "promise/no-multiple-resolved": "error",
      // Promise のネストを禁止
      "promise/no-nesting": "error",
      // Promise の静的メソッドへの new を禁止
      "promise/no-new-statics": "error",
      // コールバック内の Promise を禁止
      "promise/no-promise-in-callback": "error",
      // finally での return を禁止
      "promise/no-return-in-finally": "error",
      // 不要な Promise ラップを禁止
      "promise/no-return-wrap": "error",
      // param-names は上部で無効化済み

      // ===== promise: モダン構文の推奨 =====
      // prefer-await-to-callbacks, prefer-await-to-then, prefer-catch は上部で無効化済み
      // 有効なパラメータを強制
      "promise/valid-params": "error",

      // ===== vitest: テストの品質 =====
      // TODO コメントの警告
      "vitest/warn-todo": "error",
      // vi/vitest の一貫した使用
      "vitest/consistent-vitest-vi": "error",
      // 呼び出し回数の検証を推奨
      "vitest/prefer-called-times": "error",
      // spy を推奨
      "vitest/prefer-spy-on": "error",
      // テストファイル名の一貫性
      "vitest/consistent-test-filename": "error",

      // ===== react: プロジェクト特性上無効化 =====
      // devtools コンポーネントのネスト構造上避けられない
      "react/jsx-max-depth": "off",
      // devtools で暗黙の submit type で問題なし
      "react/button-has-type": "off",
      // Preact のリスト描画でインデックスキーが必要な場合がある
      "react/no-array-index-key": "off",

      // ===== react: ライフサイクル (Preact 互換) =====
      // componentDidMount 内での setState を禁止
      "react/no-did-mount-set-state": "error",
      // componentWillUpdate 内での setState を禁止
      "react/no-will-update-set-state": "error",
      // unsafe ライフサイクルメソッドを禁止
      "react/no-unsafe": "error",
      // SFC 内での this 使用を禁止
      "react/no-this-in-sfc": "error",

      // ===== react: JSX の正確性 (Preact 互換) =====
      // リストに key プロパティを強制
      "react/jsx-key": "error",
      // 重複 props を禁止
      "react/jsx-no-duplicate-props": "error",
      // 未定義コンポーネントを禁止
      "react/jsx-no-undef": "error",
      // 複数スプレッドを禁止
      "react/jsx-props-no-spread-multi": "error",
      // children を props として渡すことを禁止
      "react/no-children-prop": "error",
      // dangerouslySetInnerHTML と children の併用禁止
      "react/no-danger-with-children": "error",
      // void 要素 (img, br 等) に children を禁止
      "react/void-dom-elements-no-children": "error",

      // ===== react: Hooks (Preact 互換) =====
      // Hooks のルール検証 (条件分岐内での使用禁止等)
      "react/rules-of-hooks": "error",
      // exhaustive-deps は上部で無効化済み

      // ===== react: セキュリティ (Preact 互換) =====
      // target="_blank" に rel="noopener noreferrer" を強制
      "react/jsx-no-target-blank": "error",
      // javascript: URL を禁止
      "react/jsx-no-script-url": "error",
      // iframe に sandbox 属性を強制
      "react/iframe-missing-sandbox": "error",
      // dangerouslySetInnerHTML を禁止
      "react/no-danger": "error",

      // ===== react: コード品質 (Preact 互換) =====
      // コメントがテキストノードになることを防止
      "react/jsx-no-comment-textnodes": "error",
      // エスケープされていない文字を禁止
      "react/no-unescaped-entities": "error",
      // style prop にオブジェクトを強制
      "react/style-prop-object": "error",
      // 不要な Fragment を禁止
      "react/jsx-no-useless-fragment": "error",

      // ===== react: スタイル (Preact 互換) =====
      // boolean 属性のスタイル統一 (checked={true} → checked)
      "react/jsx-boolean-value": "error",
      // 波括弧の使用統一
      "react/jsx-curly-brace-presence": "error",
      // Fragment のスタイル統一 (<></> vs <Fragment>)
      "react/jsx-fragments": "error",
      // コンポーネント名を PascalCase に
      "react/jsx-pascal-case": "error",
      // 自己閉じタグを推奨 (<div /> vs <div></div>)
      "react/self-closing-comp": "error",

      // ===== react: 不要なルール (Preact では無効化) =====
      // Preact では JSX プラグマを使用するため不要
      "react/react-in-jsx-scope": "off",

      // ===== typescript: 採用しない pedantic 系ルール =====
      // 全関数パラメータに readonly を要求するルール。プロトコル実装で
      // Uint8Array 等の引数が頻出し、外部 API 由来の型と相性が悪く採用困難
      "typescript/prefer-readonly-parameter-types": "off",
      // void を返す関数の strict チェックは Preact 互換のイベントハンドラで
      // 採用が困難なため無効化
      "typescript/strict-void-return": "off",
      // private フィールドの readonly 強制は段階的対応
      "typescript/prefer-readonly": "off",
      // メソッドシグネチャを property signature (close: () => void) に強制する
      // ルール。プロトコル実装でメソッドシグネチャ (close(): void) が一貫して
      // 使われており、外部 API (WebCodecs 等) との対称性も良いため採用しない
      "typescript/method-signature-style": "off",

      // ===== vitest: テスト規約と衝突するため不採用 =====
      // CLAUDE.md は vitest + Chai API (test / assert) のみ使用するポリシー。
      // describe / expect / hook を使わず、トップレベルの test() に日本語タイトルを
      // 付け、型ナローイングのために条件分岐を用いる。これらの規約と衝突する
      // vitest プラグイン由来のルールは全て無効化する
      // (lint プラグインは "vitest" のみ有効で "jest" は無効のため、
      //  jest/* ではなく vitest/* を無効化しないと発火する)
      "vitest/require-hook": "off",
      "vitest/no-hooks": "off",
      "vitest/require-top-level-describe": "off",
      "vitest/prefer-lowercase-title": "off",
      "vitest/prefer-expect-assertions": "off",
      "vitest/no-conditional-in-test": "off",
      "vitest/prefer-each": "off",
      "vitest/expect-expect": "off",

      // ===== eslint: プロジェクト特性上無効化 =====
      // 正規表現はいずれも ASCII 専用で Unicode フラグは不要
      "require-unicode-regexp": "off",
      // __MOQT_JS_VERSION__ は vite.config.ts の define で埋め込む
      // ビルド時グローバルでリネーム不可
      "no-underscore-dangle": "off",
      // 正規表現のキャプチャグループは単一使用箇所のみであり、
      // 位置引数 (?<_match, name>) のほうが読みやすいため名前付きグループ化を強制しない
      "eslint/prefer-named-capture-group": "off",

      // ===== vitest: import スタイル =====
      // `vite-plus/test` 経由で test / assert を import するためグローバル不使用
      "vitest/prefer-importing-vitest-globals": "off",

      // ===== import: 個別緩和 =====
      // 依存数の上限はプロトコル実装で必然的に多くなるため無効化
      "import/max-dependencies": "off",

      // ===== unicorn: 個別緩和 =====
      // Worker ファイルで TypeScript にモジュールとして扱わせるための `export {}` を許可
      "unicorn/require-module-specifiers": "off",
      // `x !== undefined` / `x !== null` の存在チェックは「存在したら検証」という
      // 自然な読み順を持ち、正条件へ反転すると可読性が下がるため無効化
      "unicorn/no-negated-condition": "off",
    },
    overrides: [
      {
        // devtools は console.log とトップレベル await を許可
        files: ["devtools/**/*.ts", "devtools/**/*.tsx"],
        rules: {
          "no-console": "off",
          "unicorn/prefer-top-level-await": "off",
          // TSX コンポーネントの戻り値型は JSX.Element で推論可能
          "typescript/explicit-function-return-type": "off",
        },
      },
      {
        // examples は console.log を許可
        files: ["examples/**/*.ts"],
        rules: {
          "no-console": "off",
          "unicorn/prefer-top-level-await": "off",
        },
      },
      {
        // codec ファイルは console.warn/error を許可、Worker は戻り値型の明示不要
        files: ["src/codec/**/*.ts"],
        rules: {
          "no-console": "off",
        },
      },
      {
        // Worker ファイルは戻り値型の明示不要
        files: ["src/codec/workers/**/*.ts"],
        rules: {
          "typescript/explicit-function-return-type": "off",
        },
      },
      {
        // 可変長整数デコーダはバイト長ごとにビットパターンのコメントを付けた
        // 分岐で構成しており、共通行を括り出すとコメント構造と可読性が崩れるため
        // branches-sharing-code を無効化する
        files: ["src/varint.ts"],
        rules: {
          "oxc/branches-sharing-code": "off",
        },
      },
      {
        // テストファイルは型安全性と type-aware ルールを緩和
        files: ["**/*.test.ts", "**/*.prop.ts"],
        rules: {
          "typescript/no-explicit-any": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/no-unnecessary-type-assertion": "off",
          "typescript/no-unnecessary-boolean-literal-compare": "off",
          "typescript/use-unknown-in-catch-callback-variable": "off",
          "typescript/prefer-nullish-coalescing": "off",
          "typescript/no-unsafe-return": "off",
        },
      },
    ],
  },
  test: {
    include: ["src/**/*.{test,prop}.ts", "devtools/src/**/*.{test,prop}.ts"],
    coverage: {
      provider: "v8",
      exclude: ["src/message/debug.ts"],
    },
  },
});
