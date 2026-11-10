/**
 * AudioDecoderWrapper が復号へ渡す chunk の契約のテスト
 *
 * Node には WebCodecs が無いため、境界 (globalThis.AudioDecoder と
 * globalThis.EncodedAudioChunk) だけを置き換え、復号へ渡す EncodedAudioChunk に
 * duration を載せないことと、timestamp / type が渡した値になることを固定する。
 * 復号そのものの挙動は e2e の codec-wrappers が実ブラウザで確認する。
 */

import { test, assert } from "vite-plus/test";
import { AudioDecoderWrapper } from "./AudioDecoder";
import { withAudioDecoder, withEncodedAudioChunk } from "../testSupport/helpers";

/** 置き換えた AudioDecoder の decode() が受け取った chunk の記録 */
interface ObservedChunk {
  /** chunk の type */
  readonly type: "key" | "delta";
  /** chunk の timestamp (マイクロ秒) */
  readonly timestamp: number;
  /** chunk の duration (マイクロ秒)。未指定なら null */
  readonly duration: number | null;
}

/** 置き換える EncodedAudioChunk の init */
interface ObservedChunkInit {
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: AllowSharedBufferSource;
}

/**
 * decode() へ渡された chunk を記録する EncodedAudioChunk を組み立てる
 *
 * W3C WebCodecs (Working Draft 2026-11-09) 8.1.2 Constructors の「init.duration があれば
 * それを、無ければ null を [[duration]] に入れる」をそのまま実装する。0 は null に変換
 * しないため、Wrapper が duration: 0 を載せる実装に戻るとテストが失敗する。
 */
function createObservedEncodedAudioChunk(): unknown {
  return class {
    readonly type: "key" | "delta";
    readonly timestamp: number;
    readonly duration: number | null;

    constructor(init: ObservedChunkInit) {
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.duration = init.duration ?? null;
    }
  };
}

/**
 * 復号器の代役を組み立てる
 *
 * isCodecConfigured() は state === "configured" を要求するため、state を持たせる。
 */
function createObservedAudioDecoder(decoded: ObservedChunk[]): unknown {
  return class {
    readonly state = "configured";

    configure(): void {}

    decode(chunk: ObservedChunk): void {
      decoded.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration });
    }

    close(): void {}
  };
}

test("decode: 直接モードは chunk に duration を載せない", async () => {
  const decoded: ObservedChunk[] = [];
  await withEncodedAudioChunk(createObservedEncodedAudioChunk(), async () => {
    await withAudioDecoder(createObservedAudioDecoder(decoded), async () => {
      const errors: Error[] = [];
      const wrapper = new AudioDecoderWrapper(false, {
        output: () => {},
        error: (error) => {
          errors.push(error);
        },
      });
      await wrapper.configure("opus", 48_000, 2);

      wrapper.decode(new Uint8Array([0x11, 0x22]), "key", 12_345);
      wrapper.close();

      assert.deepEqual(errors, []);
    });
  });

  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0], { type: "key", timestamp: 12_345, duration: null });
});

test("decode: timestamp が null のときは chunk の timestamp が 0 になり、duration は載らない", async () => {
  const decoded: ObservedChunk[] = [];
  await withEncodedAudioChunk(createObservedEncodedAudioChunk(), async () => {
    await withAudioDecoder(createObservedAudioDecoder(decoded), async () => {
      const errors: Error[] = [];
      const wrapper = new AudioDecoderWrapper(false, {
        output: () => {},
        error: (error) => {
          errors.push(error);
        },
      });
      await wrapper.configure("opus", 48_000, 2);

      wrapper.decode(new Uint8Array([0x33]), "key", null);
      wrapper.close();

      assert.deepEqual(errors, []);
    });
  });

  // LOC TIMESTAMP が無い Object は媒体時刻 0 として復号へ渡す (既存の契約)
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0], { type: "key", timestamp: 0, duration: null });
});
