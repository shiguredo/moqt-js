// CSS import の型宣言
declare module "*.css" {}

// WebCodecs / Worker まわりの型宣言はライブラリの src/types.d.ts を共有する
// (devtools/tsconfig.json が ../src/**/*.d.ts を取り込んでいる)。
// vite-plus/client は参照しない: *?worker の宣言がライブラリ側と重複するため。

// WebTransportSendStream の型宣言
type WebTransportSendStream = WritableStream<Uint8Array>;
