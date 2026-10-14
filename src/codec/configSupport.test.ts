/**
 * WebCodecs の設定対応確認のテスト
 *
 * Node には WebCodecs が無いため、globalThis.VideoDecoder / globalThis.AudioEncoder を
 * 境界として置き換え、判定規則 (false と reject の両方を非対応として扱う / supported が
 * 明示的に true のときだけ対応とみなす / WebCodecs 非搭載は別の文言で失敗する) だけを
 * 固定する。実ブラウザの WebCodecs を駆動する経路は e2e で確認する。
 */

import { test, assert } from "vite-plus/test";
import { isAudioEncoderConfigSupported, isVideoDecoderConfigSupported } from "./configSupport";
import { withAudioEncoder, withVideoDecoder } from "../testSupport/helpers";

/** 確認に使う映像デコーダー設定 (実際に configure する設定と同じ形) */
const CONFIG: VideoDecoderConfig = {
  codec: "vp8",
  codedWidth: 320,
  codedHeight: 240,
};

/** 確認に使う音声エンコーダー設定 (実際に configure する設定と同じ形) */
const AUDIO_CONFIG: AudioEncoderConfig = {
  codec: "opus",
  sampleRate: 48000,
  numberOfChannels: 1,
  bitrate: 64000,
};

test("isVideoDecoderConfigSupported: supported が true なら対応とみなす", async () => {
  // 対応を申告した設定はそのまま対応になる
  const probedConfigs: VideoDecoderConfig[] = [];
  await withVideoDecoder(
    {
      isConfigSupported: async (config: VideoDecoderConfig) => {
        probedConfigs.push(config);
        return { supported: true };
      },
    },
    async () => {
      assert.isTrue(await isVideoDecoderConfigSupported(CONFIG));
    },
  );
  // 確認した設定はそのまま (複製や改変をしない) 渡される
  assert.deepEqual(probedConfigs, [CONFIG]);
});

test("isVideoDecoderConfigSupported: supported が false なら非対応とみなす", async () => {
  // 非対応を申告した設定は非対応になる
  await withVideoDecoder({ isConfigSupported: async () => ({ supported: false }) }, async () => {
    assert.isFalse(await isVideoDecoderConfigSupported(CONFIG));
  });
});

test("isVideoDecoderConfigSupported: supported が省略されたら非対応とみなす", async () => {
  // supported の省略は「対応を確かめられない」ため非対応にする。
  // 省略を truthy 判定で通すと、非対応の設定でデコーダーを作ってしまう
  await withVideoDecoder({ isConfigSupported: async () => ({}) }, async () => {
    assert.isFalse(await isVideoDecoderConfigSupported(CONFIG));
  });
});

test("isVideoDecoderConfigSupported: isConfigSupported の reject は非対応とみなす", async () => {
  // 不正な設定では同期 throw せず reject した Promise が返る。
  // reject をそのまま伝播させると、非対応の設定で例外の種類が変わってしまう
  await withVideoDecoder(
    {
      isConfigSupported: async () => {
        throw new Error("NotSupportedError");
      },
    },
    async () => {
      assert.isFalse(await isVideoDecoderConfigSupported(CONFIG));
    },
  );
});

test("isVideoDecoderConfigSupported: VideoDecoder が無ければ別の文言で失敗する", async () => {
  // WebCodecs 非搭載の環境を非対応 codec として報告すると、原因を取り違える
  await withVideoDecoder(undefined, async () => {
    let thrown: unknown = null;
    try {
      await isVideoDecoderConfigSupported(CONFIG);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, "VideoDecoder is not available in this environment");
  });
});

test("isAudioEncoderConfigSupported: supported が true なら対応とみなす", async () => {
  // 対応を申告した設定はそのまま対応になる
  const probedConfigs: AudioEncoderConfig[] = [];
  await withAudioEncoder(
    {
      isConfigSupported: async (config: AudioEncoderConfig) => {
        probedConfigs.push(config);
        return { supported: true };
      },
    },
    async () => {
      assert.isTrue(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
    },
  );
  // 確認した設定はそのまま (複製や改変をしない) 渡される
  assert.deepEqual(probedConfigs, [AUDIO_CONFIG]);
});

test("isAudioEncoderConfigSupported: supported が false なら非対応とみなす", async () => {
  // 非対応を申告した設定は非対応になる。
  // `AudioEncoder.configure()` は未対応でも同期の例外を投げないため、
  // ここで弾かないと catalog を送ってから非同期のエラーになる
  await withAudioEncoder({ isConfigSupported: async () => ({ supported: false }) }, async () => {
    assert.isFalse(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
  });
});

test("isAudioEncoderConfigSupported: supported が省略されたら非対応とみなす", async () => {
  // supported の省略は「対応を確かめられない」ため非対応にする
  await withAudioEncoder({ isConfigSupported: async () => ({}) }, async () => {
    assert.isFalse(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
  });
});

test("isAudioEncoderConfigSupported: isConfigSupported の reject は非対応とみなす", async () => {
  // 不正な設定では同期 throw せず reject した Promise が返る。
  // reject をそのまま伝播させると、非対応の設定で例外の種類が変わってしまう
  await withAudioEncoder(
    {
      isConfigSupported: async () => {
        throw new Error("NotSupportedError");
      },
    },
    async () => {
      assert.isFalse(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
    },
  );
});

test("isAudioEncoderConfigSupported: AudioEncoder が無ければ別の文言で失敗する", async () => {
  // WebCodecs 非搭載の環境を非対応 codec として報告すると、原因を取り違える
  await withAudioEncoder(undefined, async () => {
    let thrown: unknown = null;
    try {
      await isAudioEncoderConfigSupported(AUDIO_CONFIG);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, "AudioEncoder is not available in this environment");
  });
});
