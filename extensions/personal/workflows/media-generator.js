"use strict";

// Generated media stays in the current upload window. The chosen source file is
// never rewritten, and the result is only handed to the existing upload flow.
globalThis.CreatorMediaGenerator = (() => {
  const THUMBNAIL_WIDTH = 640;
  const THUMBNAIL_HEIGHT = 360;
  const TEASER_WIDTH = 1280;
  const TEASER_HEIGHT = 720;
  const MAX_TEASER_BYTES = 50 * 1024 * 1024;

  function openVideo(file) {
    if (!(file instanceof File) || !file.size)
      throw new Error("Choose a readable full video before generating media.");
    const video = document.createElement("video");
    video.playsInline = true;
    video.preload = "metadata";
    const url = URL.createObjectURL(file);
    video.src = url;
    const dispose = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    return { video, url, dispose };
  }

  function waitForMetadata(video) {
    const pending =
      video.readyState >= 1 && Number.isFinite(video.duration)
        ? Promise.resolve(video.duration)
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => finish(new Error("Video metadata timed out.")),
              30000,
            );
            const finish = (error) => {
              clearTimeout(timer);
              video.removeEventListener("loadedmetadata", loaded);
              video.removeEventListener("error", failed);
              error ? reject(error) : resolve(video.duration);
            };
            const loaded = () => finish();
            const failed = () =>
              finish(new Error("Chrome could not read the full video."));
            video.addEventListener("loadedmetadata", loaded);
            video.addEventListener("error", failed);
          });
    return pending.then((duration) => {
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !video.videoWidth ||
        !video.videoHeight
      )
        throw new Error("The full video has no seekable video track.");
      return duration;
    });
  }

  function seek(video, seconds) {
    const at = Math.min(
      Math.max(0, seconds),
      Math.max(0, video.duration - 0.05),
    );
    if (Math.abs(video.currentTime - at) < 0.025 && video.readyState >= 2)
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("The video could not seek to this frame.")),
        30000,
      );
      const finish = (error) => {
        clearTimeout(timer);
        video.removeEventListener("seeked", ready);
        video.removeEventListener("error", failed);
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () =>
        finish(new Error("Chrome could not decode this frame."));
      video.addEventListener("seeked", ready);
      video.addEventListener("error", failed);
      video.currentTime = at;
    });
  }

  function drawCover(context, video, width, height, crop = {}) {
    const ratio = Math.max(
      width / video.videoWidth,
      height / video.videoHeight,
    );
    const zoom = Math.min(2, Math.max(1, Number(crop.zoom) || 1));
    const cropWidth = width / ratio / zoom;
    const cropHeight = height / ratio / zoom;
    const cropX = Math.min(1, Math.max(-1, Number(crop.x) || 0));
    const cropY = Math.min(1, Math.max(-1, Number(crop.y) || 0));
    context.drawImage(
      video,
      ((video.videoWidth - cropWidth) * (cropX + 1)) / 2,
      ((video.videoHeight - cropHeight) * (cropY + 1)) / 2,
      cropWidth,
      cropHeight,
      0,
      0,
      width,
      height,
    );
  }

  function drawThumbnailPreview(video, canvas, crop = {}) {
    const context = canvas.getContext("2d");
    if (!context || !video.videoWidth) return;
    drawCover(context, video, canvas.width, canvas.height, crop);
  }

  function waitForPresentedFrame(video) {
    return new Promise((resolve) => {
      if (!video.requestVideoFrameCallback) {
        requestAnimationFrame(resolve);
        return;
      }
      const timer = setTimeout(resolve, 250);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function thumbnailFromVideo(file, seconds = null, crop = {}) {
    const { video, dispose } = openVideo(file);
    try {
      const duration = await waitForMetadata(video);
      await seek(
        video,
        seconds === null
          ? Math.min(3, Math.max(0.1, duration * 0.02))
          : seconds,
      );
      await waitForPresentedFrame(video);
      const canvas = document.createElement("canvas");
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = THUMBNAIL_HEIGHT;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Thumbnail generation is unavailable.");
      drawCover(context, video, canvas.width, canvas.height, crop);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob?.size || blob.size >= 2_000_000)
        throw new Error(
          "The generated thumbnail exceeds 2 MB. Choose another frame.",
        );
      return new File(
        [blob],
        `${file.name.replace(/\.[^.]+$/, "").slice(0, 90)} (frame 640x360).png`,
        {
          type: "image/png",
        },
      );
    } finally {
      dispose();
    }
  }

  function teaserScenes(duration) {
    const total = Math.min(29, Math.max(1, duration - 0.1));
    const fractions = [0.0125, 0.0875, 0.25, 0.5, 0.75, 0.9];
    const length = total / fractions.length;
    return fractions.map((fraction) => ({
      start: Math.min(
        duration * fraction,
        Math.max(0, duration - length - 0.1),
      ),
      length,
    }));
  }

  async function teaserFromVideo(file, onProgress = (_message) => {}) {
    if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream)
      throw new Error(
        "Preview generation requires a recent Chrome or WebView2. Choose a teaser file instead.",
      );
    const mimeType = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType)
      throw new Error(
        "This browser cannot create an MP4 preview. Choose a teaser file instead.",
      );
    const { video, dispose } = openVideo(file);
    let audioContext;
    let canvasStream;
    let recorder;
    let paintTimer;
    try {
      const duration = await waitForMetadata(video);
      const scenes = teaserScenes(duration);
      const canvas = document.createElement("canvas");
      canvas.width = TEASER_WIDTH;
      canvas.height = TEASER_HEIGHT;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Preview generation is unavailable.");
      canvasStream = canvas.captureStream(30);
      const tracks = [...canvasStream.getVideoTracks()];
      if (globalThis.AudioContext) {
        audioContext = new AudioContext();
        const source = audioContext.createMediaElementSource(video);
        const destination = audioContext.createMediaStreamDestination();
        source.connect(destination);
        tracks.push(...destination.stream.getAudioTracks());
        await audioContext.resume();
      }
      const chunks = [];
      recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: 7_000_000,
        audioBitsPerSecond: 128_000,
      });
      const finished = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => reject(new Error("Preview recording failed."));
        recorder.onstop = () =>
          resolve(new Blob(chunks, { type: "video/mp4" }));
      });
      const paint = () => {
        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (video.readyState >= 2) {
          const ratio = Math.min(
            canvas.width / video.videoWidth,
            canvas.height / video.videoHeight,
          );
          const width = video.videoWidth * ratio;
          const height = video.videoHeight * ratio;
          context.drawImage(
            video,
            (canvas.width - width) / 2,
            (canvas.height - height) / 2,
            width,
            height,
          );
        }
      };
      paintTimer = setInterval(paint, 33);
      paint();
      recorder.start(1000);
      for (let index = 0; index < scenes.length; index++) {
        const scene = scenes[index];
        onProgress(`Creating preview scene ${index + 1} of ${scenes.length}…`);
        if (recorder.state === "recording") recorder.pause();
        video.pause();
        await seek(video, scene.start);
        await video.play();
        if (recorder.state === "paused") recorder.resume();
        await new Promise((resolve) =>
          setTimeout(resolve, scene.length * 1000),
        );
      }
      video.pause();
      recorder.stop();
      const blob = await finished;
      if (!blob.size || blob.size >= MAX_TEASER_BYTES)
        throw new Error(
          "The generated preview exceeds 50 MB. Choose a smaller teaser file.",
        );
      return new File(
        [blob],
        `${file.name.replace(/\.[^.]+$/, "").slice(0, 90)} (teaser).mp4`,
        {
          type: "video/mp4",
        },
      );
    } finally {
      if (paintTimer) clearInterval(paintTimer);
      if (recorder?.state !== "inactive") recorder?.stop();
      canvasStream?.getTracks().forEach((track) => track.stop());
      await audioContext?.close();
      dispose();
    }
  }

  function mediaStore() {
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(
        "ofenhancer-generated-media",
        1,
      );
      request.onupgradeneeded = () =>
        request.result.createObjectStore("media", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error("Generated media could not be saved for upload recovery."),
        );
    });
  }

  async function saveGeneratedMedia(sessionId, role, source, file) {
    if (
      !/^[a-f0-9]{48}$/.test(sessionId) ||
      !["teaser", "thumbnail"].includes(role)
    )
      throw new Error("Invalid generated media session.");
    const db = await mediaStore();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("media", "readwrite");
        const store = transaction.objectStore("media");
        store.put({
          key: `${sessionId}/${role}`,
          source: {
            name: source.name,
            size: source.size,
            lastModified: source.lastModified,
          },
          file,
        });
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          if (!cursor.result.key.startsWith(`${sessionId}/`))
            cursor.result.delete();
          cursor.result.continue();
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () =>
          reject(
            new Error(
              "Generated media could not be saved for upload recovery.",
            ),
          );
        transaction.onabort = transaction.onerror;
      });
    } finally {
      db.close();
    }
  }

  async function loadGeneratedMedia(sessionId, role, source) {
    if (!source || !/^[a-f0-9]{48}$/.test(sessionId)) return null;
    const db = await mediaStore();
    try {
      const record = await new Promise((resolve, reject) => {
        const request = db
          .transaction("media", "readonly")
          .objectStore("media")
          .get(`${sessionId}/${role}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(new Error("Saved generated media could not be read."));
      });
      if (
        !record ||
        record.source.name !== source.name ||
        record.source.size !== source.size ||
        record.source.lastModified !== source.lastModified ||
        !(record.file instanceof File)
      )
        return null;
      record.file.source = "generated";
      return record.file;
    } finally {
      db.close();
    }
  }

  async function clearGeneratedMedia() {
    const db = await mediaStore();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("media", "readwrite");
        transaction.objectStore("media").clear();
        transaction.oncomplete = resolve;
        transaction.onerror = () =>
          reject(new Error("Saved generated media could not be cleared."));
      });
    } finally {
      db.close();
    }
  }

  return {
    waitForMetadata,
    seek,
    thumbnailFromVideo,
    drawThumbnailPreview,
    teaserFromVideo,
    teaserScenes,
    saveGeneratedMedia,
    loadGeneratedMedia,
    clearGeneratedMedia,
  };
})();
