(function (global) {
  "use strict";
  const ENDING_SECONDS = 0.9;
  const DEFAULT_AIM = 0.42;
  const cancelled = () =>
    new global.DOMException("Export cancelled.", "AbortError");

  function draw(context, source, progress, aim = DEFAULT_AIM) {
    const size = context.canvas.width;
    const p = Math.min(1, Math.max(0, progress));
    context.fillStyle = "#000";
    context.fillRect(0, 0, size, size);
    if (p >= 1) return;
    if (p <= 0) {
      context.drawImage(source, 0, 0, size, size);
      return;
    }
    const pull = p * p * (3 - 2 * p);
    const height = size * (1 - pull);
    const target = size * aim;
    const sourceSize = source.videoWidth || source.width;
    // Thin image strips form a curved funnel; the lower edge contracts first.
    for (let row = 0; row < sourceSize; row += 2) {
      const t = row / sourceSize;
      const width =
        size *
        Math.pow(1 - pull, 0.8) *
        (1 - Math.pow(pull, 0.35) * Math.pow(t, 0.7));
      const center =
        size / 2 +
        (target - size / 2) * (pull + (1 - pull) * t * t * Math.sqrt(pull)) +
        size * 0.07 * Math.sin(t * Math.PI) * Math.sin(p * Math.PI);
      const y = size - height + t * height;
      context.drawImage(
        source,
        0,
        row,
        sourceSize,
        Math.min(2, sourceSize - row),
        center - width / 2,
        y,
        width,
        (2 * height) / sourceSize + 0.6,
      );
    }
  }

  function waitFor(video, event, signal, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        video.removeEventListener(event, loaded);
        video.removeEventListener("error", failed);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const loaded = () => finish();
      const failed = () =>
        finish(
          new Error("This video could not be decoded. Choose another MP4."),
        );
      const abort = () => finish(signal?.reason || cancelled());
      const timer = setTimeout(
        () => finish(new Error("Video processing timed out. Try again.")),
        timeout,
      );
      video.addEventListener(event, loaded, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async function process(
    file,
    {
      canvas,
      aim = DEFAULT_AIM,
      signal,
      exportVideo = false,
      progress = () => {},
    },
  ) {
    if (!(file instanceof File) || !file.size || file.size >= 512 * 1024 * 1024)
      throw new Error("Choose a teaser video under 512 MB.");
    if (!Number.isFinite(aim) || aim < 0.25 || aim > 0.7)
      throw new Error("Choose an aim position from 25% to 70%.");
    const operation = new AbortController();
    const abort = () => operation.abort(signal?.reason);
    const hidden = () => {
      if (exportVideo && document.hidden)
        operation.abort(
          new Error("Keep OFEnhancer visible while exporting, then try again."),
        );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    document.addEventListener("visibilitychange", hidden);
    hidden();
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = !exportVideo;
    video.preload = "auto";
    const url = URL.createObjectURL(file);
    let timer, stream, recorder, audio, audioSource;
    try {
      const loaded = waitFor(video, "loadeddata", operation.signal);
      video.src = url;
      await loaded;
      if (video.videoWidth !== video.videoHeight)
        throw new Error(
          "Suction ending needs a square (1:1) video. Export a square clip first.",
        );
      if (!Number.isFinite(video.duration) || video.duration < 1)
        throw new Error("Choose a square teaser at least one second long.");
      const size = Math.min(1080, video.videoWidth) & ~1;
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Video rendering is unavailable.");
      const start = Math.max(0, video.duration - ENDING_SECONDS);
      const paint = () => {
        draw(context, video, (video.currentTime - start) / ENDING_SECONDS, aim);
        progress(Math.min(1, video.currentTime / video.duration));
      };
      let finished;
      const chunks = [];
      if (exportVideo) {
        const mimeType = [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4",
        ].find((type) => global.MediaRecorder?.isTypeSupported(type));
        if (!mimeType || !canvas.captureStream)
          throw new Error(
            "MP4 export needs a recent Chrome or WebView2. Update it and try again.",
          );
        stream = canvas.captureStream(30);
        if (!global.AudioContext)
          throw new Error(
            "Audio export is unavailable. Update Chrome or WebView2.",
          );
        audio = new global.AudioContext();
        audioSource = audio.createMediaElementSource(video);
        const destination = audio.createMediaStreamDestination();
        audioSource.connect(destination);
        destination.stream
          .getAudioTracks()
          .forEach((track) => stream.addTrack(track));
        await audio.resume();
        recorder = new global.MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 7000000,
          audioBitsPerSecond: 128000,
        });
        let bytes = 0;
        finished = new Promise((resolve, reject) => {
          recorder.ondataavailable = ({ data }) => {
            bytes += data.size;
            if (bytes >= 512 * 1024 * 1024) {
              reject(
                new Error(
                  "The rendered teaser exceeds 512 MB. Choose a shorter clip.",
                ),
              );
              video.pause();
              recorder.stop();
            } else if (data.size) chunks.push(data);
          };
          recorder.onerror = () =>
            reject(new Error("MP4 export failed. Try again."));
          recorder.onstop = () =>
            resolve(new Blob(chunks, { type: "video/mp4" }));
        });
        // Recording errors may arrive while playback is still pending.
        void finished.catch(() => {});
      } else {
        const sought = waitFor(video, "seeked", operation.signal);
        video.currentTime = start;
        await sought;
      }
      operation.signal.throwIfAborted();
      paint();
      const ended = waitFor(
        video,
        "ended",
        operation.signal,
        (video.duration + 30) * 1000,
      );
      void ended.catch(() => {});
      timer = setInterval(paint, 1000 / 30);
      if (recorder) recorder.start(250);
      await video.play();
      await (finished
        ? Promise.race([
            ended,
            finished.then(() => {
              throw new Error(
                "Export stopped before the video finished. Try again.",
              );
            }),
          ])
        : ended);
      draw(context, video, 1, aim);
      if (!exportVideo) return null;
      // Include a fully collapsed frame in the actual encoded result.
      await new Promise((resolve) => setTimeout(resolve, 80));
      operation.signal.throwIfAborted();
      recorder.stop();
      const blob = await finished;
      if (!blob.size) throw new Error("The exported MP4 is empty. Try again.");
      const output = new File(
        [blob],
        `${file.name.replace(/\.[^.]+$/, "")} (suction).mp4`,
        { type: "video/mp4" },
      );
      output.source = "generated";
      return output;
    } finally {
      signal?.removeEventListener("abort", abort);
      document.removeEventListener("visibilitychange", hidden);
      operation.abort();
      clearInterval(timer);
      video.pause();
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
      audioSource?.disconnect();
      await audio?.close().catch(() => {});
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }

  function mount({ preview, getFile, useFile, locked, busy, onBusy }) {
    const root = document.createElement("details");
    root.className = "teaser-ending";
    root.hidden = true;
    root.innerHTML = `<summary>Suction ending</summary>
      <div class="teaser-ending-editor">
        <canvas aria-label="Suction ending preview"></canvas>
        <video controls playsinline aria-label="Exported teaser preview" hidden></video>
        <div class="teaser-ending-target" aria-hidden="true"><span>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>
        </span></div>
        <label>Aim toward Like <input type="range" min="25" max="70" value="42" aria-label="Like button aim position"></label>
        <p class="hint">Approximate X timeline position. Adjust the aim for your layout; mobile and full-screen views can differ.</p>
        <div class="teaser-ending-actions"><button type="button" data-action="preview">Preview ending</button><button type="button" data-action="export" disabled>Export MP4</button><button type="button" data-action="cancel" hidden>Cancel</button></div>
        <div class="teaser-ending-actions" data-result hidden><a download>Download MP4</a><button type="button" data-action="use">Use in draft</button></div>
        <p role="status" class="teaser-ending-status"></p>
      </div>`;
    preview.after(root);
    const canvas = root.querySelector("canvas");
    const rendered = root.querySelector("video");
    const aim = root.querySelector("input");
    const status = root.querySelector('[role="status"]');
    const button = (action) => root.querySelector(`[data-action="${action}"]`);
    const result = root.querySelector("[data-result]");
    let controller,
      output,
      outputUrl,
      reviewed = false,
      sourceFile;
    function clear() {
      reviewed = false;
      output = null;
      rendered.pause();
      rendered.removeAttribute("src");
      rendered.load();
      URL.revokeObjectURL(outputUrl);
      outputUrl = "";
      result.hidden = true;
      rendered.hidden = true;
      canvas.hidden = false;
      button("export").disabled = true;
    }
    function reset() {
      controller?.abort();
      clear();
      sourceFile = getFile();
      status.textContent = "";
      root.open = false;
      root.hidden = !sourceFile || locked();
    }
    aim.addEventListener("input", () => {
      clear();
      root.style.setProperty("--ending-aim", `${aim.value}%`);
    });
    root.addEventListener("toggle", () => {
      if (root.open && (busy() || locked())) root.open = false;
      preview.hidden = root.open;
      if (root.open) {
        preview.pause();
        const context = canvas.getContext("2d");
        canvas.width = canvas.height = 480;
        if (preview.readyState >= 2) draw(context, preview, 0);
      } else controller?.abort();
    });
    async function run(exportVideo) {
      if (
        controller ||
        busy() ||
        locked() ||
        !getFile() ||
        (exportVideo && !reviewed)
      )
        return;
      const file = getFile();
      const operation = new AbortController();
      controller = operation;
      onBusy(true);
      aim.disabled =
        button("preview").disabled =
        button("export").disabled =
          true;
      button("cancel").hidden = false;
      result.hidden = true;
      rendered.hidden = true;
      canvas.hidden = false;
      status.textContent = exportVideo
        ? "Exporting… Keep this window open."
        : "Previewing ending…";
      try {
        const generated = await process(file, {
          canvas,
          aim: Number(aim.value) / 100,
          signal: operation.signal,
          exportVideo,
          progress: (p) => {
            if (exportVideo)
              status.textContent = `Exporting… ${Math.round(p * 100)}%`;
          },
        });
        if (getFile() !== file || operation.signal.aborted) return;
        reviewed = true;
        if (generated) {
          output = generated;
          URL.revokeObjectURL(outputUrl);
          outputUrl = URL.createObjectURL(output);
          rendered.src = outputUrl;
          rendered.hidden = false;
          canvas.hidden = true;
          const download = result.querySelector("a");
          download.href = outputUrl;
          download.download = output.name;
          result.hidden = false;
          status.textContent = "MP4 ready. The original clip is unchanged.";
        } else status.textContent = "Ending previewed. Ready to export.";
      } catch (error) {
        reviewed = false;
        status.textContent =
          error.name === "AbortError"
            ? "Cancelled. The original clip is unchanged."
            : error.message;
      } finally {
        controller = null;
        aim.disabled = button("preview").disabled = false;
        button("export").disabled = !reviewed;
        button("cancel").hidden = true;
        onBusy(false);
      }
    }
    button("preview").addEventListener("click", () => void run(false));
    button("export").addEventListener("click", () => void run(true));
    button("cancel").addEventListener("click", () => controller?.abort());
    button("use").addEventListener("click", () => {
      if (!output || busy() || locked()) return;
      useFile(output);
    });
    window.addEventListener("pagehide", () => {
      controller?.abort();
      clear();
    });
    return { reset };
  }
  global.OFEnhancerTeaserEnding = Object.freeze({ draw, process, mount });
})(globalThis);
