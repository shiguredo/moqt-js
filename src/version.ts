/**
 * moqt-js バージョン情報
 *
 * ビルド時に vite.config.ts の define で埋め込まれる
 */

declare const __MOQT_JS_VERSION__: string;

/** moqt-js バージョン (package.json から取得) */
export const version: string = __MOQT_JS_VERSION__;

/** MOQT_IMPLEMENTATION パラメータの値 */
export const MOQT_IMPLEMENTATION_VALUE = `moqt-js/${version}`;
