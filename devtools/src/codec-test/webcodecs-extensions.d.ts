/**
 * WebCodecs の型拡張
 *
 * src/types.d.ts はリポジトリ root の tsconfig でのみ読み込まれ、
 * devtools の tsconfig (include は devtools/src のみ) では読み込まれない。
 * テストページは src/codec を直接 import するため、ここで同じ拡張を宣言し、
 * 既存の型エラーを増やさないようにする。
 */
interface VideoEncoderConfig {
  hevc?: {
    format?: "annexb" | "hevc";
  };
}
