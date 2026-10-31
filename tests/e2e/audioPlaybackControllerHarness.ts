/** 実 Controller、実 signal、実出力を組み合わせ、購読の開始順だけを制御する。 */
import { createMediaPlayout, type MediaPlayout } from "moqt-js";
import { createAudioPlaybackController } from "../../devtools/src/hooks/audioPlaybackController";
import { SubscriberAudioStop } from "../../devtools/src/hooks/subscriberAudioStop";
import { createSubscriberInstance } from "../../devtools/src/signals/subscriber";
import { selectedAudioOutputDeviceId } from "../../devtools/src/signals/connectionSettings";
import { PreDecodeDelayStage } from "../../src/playout/preDecodeDelayStage";

export function createAudioControllerHarness() {
  const instance = createSubscriberInstance("audio-controller");
  const mediaPlayoutRef = { current: null as MediaPlayout | null };
  const states: (AudioContextState | null)[] = [];
  const baselines: unknown[] = [];
  const stage = new PreDecodeDelayStage<AudioData>({
    delayMs: 0,
    bytesOf: (data) => data.numberOfFrames * data.numberOfChannels * 4,
    onDue: (items) => {
      for (const data of items) {
        mediaPlayoutRef.current?.pushAudio(data);
        data.close();
      }
    },
  });
  const controller = createAudioPlaybackController({
    subscriberId: instance.id,
    mediaPlayoutRef,
    audioStopRef: { current: new SubscriberAudioStop() },
    flushAudioPreDecode: () => stage.flush(),
    getAudioPlaybackEnabledSignal: () => instance.audioPlaybackEnabled,
    playAudioEnabled: instance.audioPlaybackEnabled,
    getSelectedAudioOutputDeviceId: () => selectedAudioOutputDeviceId.value,
    getAudioContextSampleRate: () => 48000,
    onAudioContextStateChange: (state) => states.push(state),
    onAudioContextClosed: () => states.push(null),
    restartAudioPlayoutCumulative: () => baselines.push(mediaPlayoutRef.current?.getStats()),
  });
  return {
    controller,
    instance,
    mediaPlayoutRef,
    states,
    baselines,
    createPlayout: () => createMediaPlayout({ audio: {} }),
    select: (deviceId: string) => {
      selectedAudioOutputDeviceId.value = deviceId;
      return controller.setOutputDevice(deviceId);
    },
    push: (playout: MediaPlayout) => {
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: 48000,
        numberOfChannels: 1,
        numberOfFrames: 960,
        timestamp: 0,
        data: new Float32Array(960),
      });
      try {
        return playout.pushAudio(data).status;
      } finally {
        data.close();
      }
    },
    close: async () => {
      stage.stop();
      await controller.stopAudioPlayback();
      mediaPlayoutRef.current?.clearAll();
    },
  };
}
