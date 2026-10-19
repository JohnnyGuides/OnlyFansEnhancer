(function (global) {
  "use strict";
  const ENDING_SECONDS = 0.9;
  const DEFAULT_AIM = 0.47;
  const cancelled = () =>
    new global.DOMException("Export cancelled.", "AbortError");

  function draw(context, source, progress, aim = DEFAULT_AIM, neck = 0) {
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
      const bend = Math.pow(pull, 0.35) * Math.pow(t, 0.7);
      const width =
        size * (Math.pow(1 - pull, 0.8) * (1 - bend) + neck * pull * bend);
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
      speed = 1,
      mode = "during-video",
      neck = 0,
      signal,
      exportVideo = false,
      progress = () => {},
    },
  ) {
    if (!(file instanceof File) || !file.size || file.size >= 512 * 1024 * 1024)
      throw new Error("Choose a teaser video under 512 MB.");
    if (!Number.isFinite(aim) || aim < 0 || aim > 1)
      throw new Error("Choose a warp target from 0% to 100%.");
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 3)
      throw new Error("Choose an ending speed from 0.5× to 3×.");
    if (!["last-frame", "during-video"].includes(mode))
      throw new Error("Choose Last frame or During video.");
    if (!Number.isFinite(neck) || neck < 0 || neck > 0.4)
      throw new Error("Choose a funnel width from 0% to 40%.");
    const endingSeconds = ENDING_SECONDS / speed;
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
      if (mode === "during-video" && video.duration < endingSeconds)
        throw new Error(
          `This speed needs a clip at least ${endingSeconds.toFixed(1)} seconds long. Choose a faster speed.`,
        );
      const size = Math.min(1080, video.videoWidth) & ~1;
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Video rendering is unavailable.");
      const start =
        mode === "last-frame" ? video.duration : video.duration - endingSeconds;
      const totalDuration =
        video.duration + (mode === "last-frame" ? endingSeconds : 0);
      const paint = () => {
        draw(
          context,
          video,
          (video.currentTime - start) / endingSeconds,
          aim,
          neck,
        );
        progress(Math.min(1, video.currentTime / totalDuration));
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
        video.currentTime = Math.min(start, video.duration - 0.05);
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
      clearInterval(timer);
      if (mode === "last-frame") {
        const frozen = document.createElement("canvas");
        frozen.width = frozen.height = size;
        frozen.getContext("2d").drawImage(video, 0, 0, size, size);
        const started = performance.now();
        while (performance.now() - started < endingSeconds * 1000) {
          operation.signal.throwIfAborted();
          const elapsed = (performance.now() - started) / 1000;
          draw(context, frozen, elapsed / endingSeconds, aim, neck);
          progress((video.duration + elapsed) / totalDuration);
          await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
        }
      }
      draw(context, video, 1, aim, neck);
      if (!exportVideo) return null;
      // Keep the video tail longer than audio encoder delay, with fresh black frames.
      stream.getAudioTracks().forEach((track) => track.stop());
      for (let frame = 0; frame < 4; frame++) {
        draw(context, video, 1, aim, neck);
        await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
      }
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
    const root = document.createElement("div");
    root.className = "teaser-ending file-actions";
    root.hidden = true;
    root.innerHTML = `<label class="teaser-ending-toggle"><input type="checkbox" aria-label="Suction ending">Suction ending</label>
      <button type="button" class="teaser-ending-gear" aria-label="Suction ending settings" title="Ending settings"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m9 3-.6 2.5-2.2 1.3L3.7 6l-2 3.5 1.9 1.8v2.5l-1.9 1.7 2 3.5 2.5-.8 2.2 1.3L9 22h4l.6-2.5 2.2-1.3 2.5.8 2-3.5-1.9-1.7v-2.5l1.9-1.8-2-3.5-2.5.8-2.2-1.3L13 3Z"/><circle cx="11" cy="12.5" r="3"/></svg></button>
      <dialog class="teaser-ending-dialog" aria-label="Suction ending settings">
      <header><h2>Suction ending</h2><button type="button" data-action="close" aria-label="Close ending settings"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <div class="teaser-ending-editor"><div class="teaser-ending-media"><div class="teaser-ending-stage">
        <canvas aria-label="Suction ending preview"></canvas>
        <video controls playsinline aria-label="Exported teaser preview" hidden></video>
        </div>
        <div class="teaser-ending-target" data-layout="desktop" title="X timeline guide; positions vary by viewer layout.">
          <div class="teaser-ending-target-track">
            <div class="teaser-ending-neck" role="slider" tabindex="0" aria-label="Funnel width" aria-valuemin="0" aria-valuemax="40" aria-valuenow="0" aria-valuetext="Point" aria-orientation="horizontal" title="Drag either edge to widen or narrow the funnel. Arrow keys adjust the width."></div>
            <div class="teaser-ending-target-handle" role="slider" tabindex="0" aria-label="Warp target" aria-valuemin="0" aria-valuemax="100" aria-valuenow="47" aria-valuetext="47% across video" aria-orientation="horizontal"></div>
            <span data-x-action="reply" title="Reply"><svg viewBox="0 0 24 24"><path d="M21 11.5a9 9 0 0 1-9 9H4l2-4a9 9 0 1 1 15-5Z"/></svg></span>
            <span data-x-action="repost" title="Repost"><svg viewBox="0 0 24 24"><path d="m3 7 4-4 4 4M7 3v13a3 3 0 0 0 3 3h3m8-2-4 4-4-4m4 4V8a3 3 0 0 0-3-3h-3"/></svg></span>
            <span data-x-action="like" title="Like"><svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></span>
            <span data-x-action="views" title="Views"><svg viewBox="0 0 24 24"><path d="M4 20V9m6 11V4m6 16v-8m5 8V2"/></svg></span>
            <span data-x-action="bookmark" title="Bookmark"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4Z"/></svg></span>
            <span data-x-action="share" title="Share"><svg viewBox="0 0 24 24"><path d="M12 15V2m-5 5 5-5 5 5M4 13v8h16v-8"/></svg></span>
          </div><div class="teaser-ending-target-caption"><span>Target <output data-aim>47%</output></span><span>Width <output data-neck>Point</output></span></div>
        </div></div>
        <div class="teaser-ending-settings"><label>Warp<select aria-label="Warp mode"><option value="last-frame">Last frame</option><option value="during-video" selected>During video</option></select></label>
        <label>X timeline<select aria-label="X timeline layout"><option value="desktop">Desktop web</option><option value="mobile">Mobile web</option></select></label>
        <label><span>Speed <output data-speed>1×</output></span><input type="range" min="0.5" max="3" step="0.25" value="1" aria-label="Ending speed" aria-valuetext="1×"></label>
        <p role="status" class="teaser-ending-status"></p>
        <div class="teaser-ending-actions"><button type="button" data-action="preview" aria-label="Preview ending">Preview</button><button type="button" data-action="export" disabled>Export MP4</button><button type="button" class="primary" data-action="use" disabled>Apply ending</button></div>
      </div></div></dialog>`;
    preview.after(root);
    const dialog = root.querySelector("dialog");
    const enabled = root.querySelector('[type="checkbox"]');
    const gear = root.querySelector(".teaser-ending-gear");
    const canvas = root.querySelector("canvas");
    const rendered = root.querySelector("video");
    const aim = root.querySelector('[aria-label="Warp target"]');
    const target = root.querySelector(".teaser-ending-target");
    const track = root.querySelector(".teaser-ending-target-track");
    const layout = root.querySelector('[aria-label="X timeline layout"]');
    const neckControl = root.querySelector('[aria-label="Funnel width"]');
    const neckValue = root.querySelector("[data-neck]");
    let aimPercent = DEFAULT_AIM * 100,
      neckPercent = 0,
      dragWidth = false;
    const speed = root.querySelector('[aria-label="Ending speed"]');
    const mode = root.querySelector('[aria-label="Warp mode"]');
    const speedValue = root.querySelector("[data-speed]");
    const aimValue = root.querySelector("[data-aim]");
    const status = root.querySelector('[role="status"]');
    const button = (action) => root.querySelector(`[data-action="${action}"]`);
    let controller,
      output,
      outputUrl,
      reviewed = false,
      appliedFile = null,
      originalFile = null;
    function clear() {
      reviewed = false;
      button("preview").hidden = false;
      output = null;
      rendered.pause();
      rendered.removeAttribute("src");
      rendered.load();
      URL.revokeObjectURL(outputUrl);
      outputUrl = "";
      rendered.hidden = true;
      canvas.hidden = false;
      canvas.width = canvas.height = 480;
      if (preview.readyState >= 2) draw(canvas.getContext("2d"), preview, 0);
      button("export").disabled = true;
      button("use").disabled = true;
    }
    function reset() {
      controller?.abort();
      clear();
      const sourceFile = getFile();
      if (sourceFile !== appliedFile) appliedFile = originalFile = null;
      enabled.checked = Boolean(appliedFile && sourceFile === appliedFile);
      status.textContent = "";
      dialog.close();
      root.hidden = !sourceFile || locked();
    }
    function syncControls() {
      root.style.setProperty("--ending-aim", `${aimPercent}%`);
      root.style.setProperty("--ending-neck", `${neckPercent}%`);
      neckValue.value = neckPercent ? `${neckPercent}%` : "Point";
      neckControl.setAttribute("aria-valuenow", String(neckPercent));
      neckControl.setAttribute("aria-valuetext", neckValue.value);
      aimValue.value = `${aimPercent}%`;
      speedValue.value = `${Number(speed.value)}×`;
      speed.setAttribute("aria-valuetext", speedValue.value);
      aim.setAttribute("aria-valuenow", String(aimPercent));
      aim.setAttribute("aria-valuetext", `${aimPercent}% across video`);
      for (const control of [speed])
        control.style.setProperty(
          "--range-fill",
          `${((Number(control.value) - Number(control.min)) / (Number(control.max) - Number(control.min))) * 100}%`,
        );
    }
    syncControls();
    for (const control of [speed, mode])
      control.addEventListener("input", () => {
        clear();
        syncControls();
        status.textContent = "";
      });
    function setAim(value) {
      if (controller || busy() || locked()) return;
      aimPercent = Math.min(100, Math.max(0, Math.round(value)));
      clear();
      syncControls();
      status.textContent = "";
    }
    function setNeck(value) {
      if (controller || busy() || locked()) return;
      neckPercent = Math.min(40, Math.max(0, Math.round(value)));
      clear();
      if (preview.readyState >= 2)
        draw(
          canvas.getContext("2d"),
          preview,
          0.75,
          aimPercent / 100,
          neckPercent / 100,
        );
      syncControls();
      status.textContent = "";
    }
    function point(event) {
      const bounds = track.getBoundingClientRect();
      const percent = ((event.clientX - bounds.left) / bounds.width) * 100;
      if (dragWidth) setNeck(Math.abs(percent - aimPercent) * 2);
      else setAim(percent);
    }
    track.addEventListener("pointerdown", (event) => {
      if (controller || busy() || locked() || event.button !== 0) return;
      track.setPointerCapture(event.pointerId);
      dragWidth = Boolean(event.target.closest(".teaser-ending-neck"));
      (dragWidth ? neckControl : aim).focus();
      point(event);
      event.preventDefault();
    });
    track.addEventListener("pointermove", (event) => {
      if (track.hasPointerCapture(event.pointerId)) point(event);
    });
    aim.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 10 : 1;
      const next = {
        ArrowLeft: aimPercent - step,
        ArrowRight: aimPercent + step,
        Home: 0,
        End: 100,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      setAim(next);
    });
    neckControl.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 10 : 1;
      const next = {
        ArrowLeft: neckPercent - step,
        ArrowRight: neckPercent + step,
        Home: 0,
        End: 40,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      setNeck(next);
    });
    layout.addEventListener("change", () => {
      target.dataset.layout = layout.value;
      setAim(layout.value === "mobile" ? 50 : 47);
    });
    function open() {
      if (busy() || locked() || !getFile()) return;
      preview.pause();
      if (!output) {
        rendered.src = preview.currentSrc || preview.src;
        rendered.hidden = false;
        canvas.hidden = true;
      }
      dialog.showModal();
    }
    gear.addEventListener("click", open);
    enabled.addEventListener("change", () => {
      if (busy() || locked()) {
        enabled.checked = Boolean(appliedFile && getFile() === appliedFile);
        return;
      }
      if (enabled.checked) open();
      else if (appliedFile && getFile() === appliedFile) {
        const source = originalFile;
        appliedFile = originalFile = null;
        useFile(source);
      }
    });
    button("close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      controller?.abort();
      rendered.pause();
      enabled.checked = Boolean(appliedFile && getFile() === appliedFile);
      gear.focus();
    });
    function downloadOutput() {
      const link = document.createElement("a");
      link.href = outputUrl;
      link.download = output.name;
      link.click();
    }
    function applyOutput() {
      const generated = output;
      if (getFile() !== appliedFile) originalFile = getFile();
      appliedFile = generated;
      useFile(generated);
    }
    async function run() {
      if (controller || busy() || locked() || !getFile()) return;
      const selected = getFile();
      const file = selected === appliedFile ? originalFile : selected;
      const operation = new AbortController();
      controller = operation;
      onBusy(true);
      aim.setAttribute("aria-disabled", "true");
      neckControl.setAttribute("aria-disabled", "true");
      layout.disabled =
        mode.disabled =
        speed.disabled =
        enabled.disabled =
        gear.disabled =
        button("export").disabled =
        button("use").disabled =
          true;
      rendered.hidden = true;
      canvas.hidden = false;
      rendered.pause();
      status.textContent = "Preparing preview…";
      button("preview").textContent = "Cancel";
      button("preview").setAttribute("aria-label", "Cancel preview");
      try {
        const generated = await process(file, {
          canvas,
          aim: aimPercent / 100,
          neck: neckPercent / 100,
          speed: Number(speed.value),
          mode: mode.value,
          signal: operation.signal,
          exportVideo: true,
          progress: (p) => {
            status.textContent = `Preparing preview… ${Math.round(p * 100)}%`;
          },
        });
        if (getFile() !== selected || operation.signal.aborted) return;
        reviewed = true;
        button("preview").hidden = true;
        if (generated) {
          output = generated;
          URL.revokeObjectURL(outputUrl);
          outputUrl = URL.createObjectURL(output);
          rendered.src = outputUrl;
          rendered.hidden = false;
          canvas.hidden = true;
          status.textContent = "";
          await rendered.play().catch(() => {});
        } else status.textContent = "";
      } catch (error) {
        reviewed = false;
        status.textContent =
          error.name === "AbortError" ? "Cancelled" : error.message;
      } finally {
        controller = null;
        aim.setAttribute("aria-disabled", "false");
        neckControl.setAttribute("aria-disabled", "false");
        layout.disabled =
          speed.disabled =
          mode.disabled =
          enabled.disabled =
          gear.disabled =
          button("preview").disabled =
            false;
        button("preview").textContent = "Preview";
        button("preview").setAttribute("aria-label", "Preview ending");
        button("export").disabled = !reviewed;
        button("use").disabled = !reviewed;
        onBusy(false);
      }
    }
    button("preview").addEventListener("click", () => {
      if (controller) controller.abort();
      else void run();
    });
    button("export").addEventListener("click", () => {
      if (controller || busy() || locked()) return;
      if (output) downloadOutput();
    });
    button("use").addEventListener("click", () => {
      if (controller || busy() || locked()) return;
      if (output) applyOutput();
    });
    window.addEventListener("pagehide", () => {
      controller?.abort();
      clear();
    });
    return { reset };
  }
  global.OFEnhancerTeaserEnding = Object.freeze({ draw, process, mount });
})(globalThis);
