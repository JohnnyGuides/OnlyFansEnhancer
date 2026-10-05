(function (global) {
  "use strict";
  let active = null;
  function node(tag, className, text) {
    const item = document.createElement(tag);
    item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function action(text, className = "xt-action") {
    const item = node("button", className, text);
    item.type = "button";
    return item;
  }
  function dayLabel(day) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(new Date(day + "T12:00:00"));
  }
  async function clipFile(clip, request, progress) {
    if (
      !Number.isSafeInteger(clip.size) ||
      clip.size <= 0 ||
      clip.size >= 512 * 1024 * 1024
    )
      throw new Error("Choose a teaser video under 512 MB.");
    const chunks = [];
    let token = "",
      offset = 0;
    for (;;) {
      const result = await request("getTeaserClipChunk", {
        clipId: clip.clipId,
        offset,
        ...(token ? { token } : {}),
      });
      if (
        result.offset !== offset ||
        result.size !== clip.size ||
        result.sha256 !== clip.sha256 ||
        result.name !== clip.name
      )
        throw new Error(
          "This teaser changed. Refresh the list before choosing it again.",
        );
      const bytes = Uint8Array.from(atob(result.chunk), (character) =>
        character.charCodeAt(0),
      );
      if (!bytes.length || offset + bytes.length > clip.size)
        throw new Error("The teaser could not be read.");
      chunks.push(bytes);
      token = result.token;
      offset += bytes.length;
      progress.textContent = `Opening video… ${Math.round((offset / clip.size) * 100)}%`;
      if (result.done) break;
    }
    if (offset !== clip.size)
      throw new Error("The teaser could not be read completely.");
    const file = new File(chunks, clip.name, {
      type: /\.webm$/i.test(clip.name)
        ? "video/webm"
        : /\.mov$/i.test(clip.name)
          ? "video/quicktime"
          : "video/mp4",
      lastModified: clip.lastModified,
    });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== clip.sha256)
      throw new Error("The teaser did not pass its integrity check.");
    return file;
  }
  async function open({
    date,
    episodes = [],
    episode = null,
    recommendations = [],
    request = global.OFEnhancerHost.request,
    onSaved = () => {},
  }) {
    if (active) {
      active.focus();
      return;
    }
    const dialog = node("dialog", "xt-composer-dialog");
    active = dialog;
    dialog.setAttribute("aria-label", `Teaser for ${dayLabel(date)}`);
    const heading = node("header", "xt-composer-heading");
    const title = node("h2", "", `Teaser · ${dayLabel(date)}`);
    const close = action("Close");
    heading.append(title, close);
    const content = node("div", "xt-composer-content");
    const status = node("p", "xt-composer-status");
    status.setAttribute("role", "status");
    dialog.append(heading, content, status);
    document.body.append(dialog);
    const opener = document.activeElement;
    let iframe = null,
      context = null,
      dirty = false,
      loading = false,
      running = false;
    const closeDialog = () => {
      if (running) {
        status.textContent =
          "Keep this window open while Twitter preparation is running.";
        return;
      }
      if (dirty && !confirm("Close without saving the changes to this teaser?"))
        return;
      dialog.close();
    };
    close.addEventListener("click", closeDialog);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    const receive = (event) => {
      if (
        !iframe ||
        event.source !== iframe.contentWindow ||
        event.origin !== location.origin
      )
        return;
      if (event.data?.type === "ofenhancer:teaser-ready")
        iframe.contentWindow.postMessage(
          { type: "ofenhancer:teaser-context", ...context },
          location.origin,
        );
      if (event.data?.type === "ofenhancer:teaser-dirty") dirty = true;
      if (event.data?.type === "ofenhancer:teaser-running")
        running = event.data.running === true;
      if (event.data?.type === "ofenhancer:teaser-saved") {
        dirty = false;
        status.textContent = "Draft saved for this day.";
        Promise.resolve(onSaved()).catch(() => {
          status.textContent = "Draft saved. Refresh the calendar to see it.";
        });
      }
    };
    window.addEventListener("message", receive);
    dialog.addEventListener(
      "close",
      () => {
        window.removeEventListener("message", receive);
        dialog.remove();
        active = null;
        opener?.focus?.();
      },
      { once: true },
    );
    function edit(file, clip = null, draft = null) {
      if (
        !file.size ||
        file.size >= 512 * 1024 * 1024 ||
        !/\.(mp4|mov|m4v|webm)$/i.test(file.name)
      ) {
        status.textContent =
          "Choose an MP4, MOV, M4V or WebM video under 512 MB.";
        return;
      }
      dirty = !draft;
      context = {
        date,
        file,
        episodeKey:
          draft?.episodeKey || episode?.sourceKey || clip?.episodeKey || "",
        clipId: draft?.clipId || clip?.clipId || null,
        draft,
      };
      const back = action("Change clip");
      back.addEventListener("click", () => {
        if (
          !running &&
          (!dirty || confirm("Replace this clip and discard unsaved changes?"))
        ) {
          dirty = false;
          iframe = null;
          void choose();
        }
      });
      iframe = node("iframe", "xt-composer-frame");
      iframe.title = "Twitter teaser upload hub";
      iframe.src = `upload-console.html?teaserDay=${encodeURIComponent(date)}`;
      content.replaceChildren(back, iframe);
      status.textContent = "";
    }
    async function choose() {
      const grid = node("div", "xt-clip-choices");
      const input = node("input", "");
      input.type = "file";
      input.accept =
        "video/mp4,video/webm,video/quicktime,.mp4,.mov,.m4v,.webm";
      input.hidden = true;
      const add = action("", "xt-clip-choice xt-clip-add");
      add.setAttribute("aria-label", "Choose a new teaser video");
      add.append(
        node("span", "xt-plus", "+"),
        node("span", "", "Choose video"),
      );
      add.addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) edit(file);
      });
      grid.append(add);
      content.replaceChildren(grid, input);
      grid.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      grid.addEventListener("drop", (event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files?.[0];
        if (file && !loading) edit(file);
      });
      if (episode) {
        const folder = action("Open episode folder");
        folder.addEventListener("click", async () => {
          try {
            await request("openTeaserEpisodeFolder", {
              episodeKey: episode.sourceKey,
            });
          } catch {
            status.textContent =
              "The episode folder is unavailable. Choose a finished teaser video instead.";
          }
        });
        content.prepend(
          node("p", "xt-composer-episode", episode.title),
          folder,
        );
      }
      status.textContent = "Loading ready clips…";
      try {
        const library = await request("getTeaserClips", {});
        if (!dialog.isConnected || iframe) return;
        const ranked = new Map(
          recommendations.map((item, index) => [
            item.episode.sourceKey,
            { ...item, rank: index + 1 },
          ]),
        );
        const clips = (library.clips || [])
          .filter((clip) => !episode || clip.episodeKey === episode.sourceKey)
          .sort(
            (left, right) =>
              (ranked.get(left.episodeKey)?.rank || Infinity) -
              (ranked.get(right.episodeKey)?.rank || Infinity),
          );
        for (const clip of clips) {
          const choice = action("", "xt-clip-choice");
          const linked = episodes.find(
            (item) => item.sourceKey === clip.episodeKey,
          );
          choice.dataset.episodeKey = clip.episodeKey || "";
          const recommendation = ranked.get(clip.episodeKey);
          if (recommendation) {
            choice.dataset.recommendationRank = String(recommendation.rank);
            choice.title = `${recommendation.reason}. ${recommendation.detail}`;
            choice.setAttribute("aria-description", choice.title);
          }
          if (linked?.thumbnailAssetId) {
            const image = node("img", "");
            image.alt = "";
            image.loading = "lazy";
            image.src = `https://thumbs.ofenhancer.local/${encodeURIComponent(linked.thumbnailAssetId)}`;
            image.addEventListener("error", () => image.remove());
            choice.append(image);
          }
          choice.append(
            node("strong", "", linked?.title || clip.name),
            node(
              "small",
              "",
              clip.state === "failed" ? "Needs re-edit" : clip.name,
            ),
          );
          if (recommendation) choice.append(node("small", "", "Recommended"));
          choice.addEventListener("click", async () => {
            if (loading) return;
            loading = true;
            choice.disabled = true;
            try {
              const file = await clipFile(clip, request, status);
              if (dialog.isConnected) edit(file, clip);
            } catch (error) {
              status.textContent = error.message;
            } finally {
              loading = false;
              choice.disabled = false;
            }
          });
          grid.append(choice);
        }
        status.textContent = clips.length
          ? ""
          : "No ready clips here yet. Choose a video to start.";
      } catch {
        status.textContent =
          "Ready clips are unavailable. You can still choose a video.";
      }
    }
    dialog.showModal();
    close.focus();
    try {
      const draft = await global.OFEnhancerTeaserDrafts.get(date);
      if (draft) edit(draft.file, null, draft);
      else await choose();
    } catch (error) {
      await choose();
      status.textContent = error.message;
    }
  }
  global.OFEnhancerTeaserComposer = Object.freeze({ open, clipFile });
})(globalThis);
