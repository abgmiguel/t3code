class DictationCapture extends globalThis.AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) {
        for (let index = 0; index < mono.length; index++)
          mono[index] += channel[index] / channels.length;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}

globalThis.registerProcessor("dictation-capture", DictationCapture);
