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
  async function clipFile(clip, request, progress, current = () => true) {
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
      if (!current()) throw new Error("Video loading cancelled.");
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
    renderCatalogue = null,
    layoutCatalogue = () => {},
    request = global.OFEnhancerHost.request,
    onSaved = () => {},
  }) {
    if (active) {
      active.focus();
      return;
    }
    const dialog = node("dialog", "xt-composer-dialog");
    let catalogueObserver = null;
    let previewObserver = null,
      previewTimer = null,
      previewGeneration = 0;
    let playingPreview = null,
      editorLoadTimer = null;
    function stopPreview() {
      clearTimeout(previewTimer);
      previewGeneration++;
      if (playingPreview) {
        playingPreview.pause();
        playingPreview.removeAttribute("src");
        playingPreview.load();
        playingPreview.remove();
        playingPreview = null;
      }
    }
    function stopEditorLoading() {
      clearTimeout(editorLoadTimer);
      content.querySelector(".xt-editor-error")?.remove();
      content.removeAttribute("aria-busy");
    }
    function previewCard(choice, clip) {
      const media = node("span", "xt-clip-media");
      const image = node("img", "");
      image.alt = "";
      image.hidden = true;
      image.onerror = () => {
        media.dataset.failed = "true";
      };
      const duration = node("span", "xt-clip-duration");
      media.append(image, duration);
      choice.prepend(media);
      let posterPromise = null,
        playbackPromise = null;
      const fetchPreview = (playback = false) => {
        if (playback)
          return (playbackPromise ||= request("getTeaserClipPreview", {
            clipId: clip.clipId,
            playback: true,
          }).catch((error) => {
            playbackPromise = null;
            throw error;
          }));
        return (posterPromise ||= request("getTeaserClipPreview", {
          clipId: clip.clipId,
        }));
      };
      choice.loadPoster = async () => {
        try {
          const result = await fetchPreview();
          if (!choice.isConnected) return;
          if (typeof result.posterUrl !== "string" || !result.posterUrl)
            throw new Error("Video preview unavailable.");
          image.onload = () => {
            image.hidden = false;
            media.dataset.loaded = "true";
          };
          image.src = result.posterUrl;
          if (Number.isFinite(result.duration)) {
            const seconds = Math.round(result.duration);
            duration.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
          }
        } catch {
          media.dataset.failed = "true";
        }
      };
      const start = () => {
        stopPreview();
        const generation = previewGeneration;
        previewTimer = setTimeout(async () => {
          try {
            const result = await fetchPreview(true);
            if (
              generation !== previewGeneration ||
              !choice.isConnected ||
              document.hidden ||
              !result.videoUrl
            )
              return;
            const video = node("video", "xt-clip-video");
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.preload = "none";
            video.src = result.videoUrl;
            playingPreview = video;
            media.append(video);
            await video.play();
          } catch {
            if (generation === previewGeneration) stopPreview();
          }
        }, 180);
      };
      choice.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "touch") start();
      });
      choice.addEventListener("pointerleave", stopPreview);
      choice.addEventListener("focus", start);
      choice.addEventListener("blur", stopPreview);
      previewObserver.observe(choice);
    }
    const visibilityChanged = () => {
      if (document.hidden) stopPreview();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    active = dialog;
    dialog.setAttribute("aria-label", `Teaser for ${dayLabel(date)}`);
    const heading = node("header", "xt-composer-heading");
    const title = node("h2", "", `Teaser planner · ${dayLabel(date)}`);
    const close = action("Close");
    heading.append(title, close);
    const more = action("");
    more.hidden = true;
    more.setAttribute("aria-label", "File actions");
    more.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
    const tools = node("div", "xt-render-handoff xt-composer-tools");
    tools.id = `teaser-file-actions-${date}`;
    tools.setAttribute("popover", "auto");
    more.setAttribute("popovertarget", tools.id);
    heading.insertBefore(more, close);
    more.addEventListener("click", () => {
      const bounds = more.getBoundingClientRect();
      tools.style.top = `${bounds.bottom + 8}px`;
      tools.style.left = `${Math.max(12, Math.min(bounds.right - 200, window.innerWidth - 212))}px`;
    });
    const destinations = node("div", "xt-composer-destinations");
    destinations.hidden = true;
    destinations.setAttribute("role", "group");
    destinations.setAttribute("aria-label", "Destination posts");
    const destination = node("div", "xt-planner-post-list");
    const search = node("input", "xt-planner-search");
    search.type = "search";
    search.placeholder = "Find a destination";
    search.setAttribute("aria-label", "Find a destination");
    search.addEventListener("input", () => {
      for (const row of destination.children)
        row.hidden = !row.textContent
          .toLowerCase()
          .includes(search.value.trim().toLowerCase());
    });
    const batchControls = node("div", "xt-planner-batch");
    const startLabel = node("label", "teaser-schedule-field", "Reddit starts");
    const start = node("input", "");
    start.type = "time";
    start.value = "18:00";
    startLabel.append(start);
    let gapMinutes = 15;
    batchControls.append(startLabel);
    const count = node("span", "xt-planner-count");
    const postsHeading = node("div", "xt-planner-posts-heading");
    postsHeading.append(node("h3", "", "Post to"), count);
    const communities = action("Choose communities");
    const removePost = action("Remove post");
    removePost.hidden = true;
    const postActions = node("div", "xt-planner-post-actions");
    const selectedInfo = node("p", "xt-planner-selected-info");
    postActions.append(communities, removePost);
    destinations.append(
      postsHeading,
      batchControls,
      search,
      destination,
      postActions,
      selectedInfo,
    );
    const content = node("div", "xt-composer-content");
    const status = node("p", "xt-composer-status");
    status.setAttribute("role", "status");
    dialog.append(heading, tools, destinations, content, status);
    document.body.append(dialog);
    const opener = document.activeElement;
    let iframe = null,
      context = null,
      dirty = false,
      loading = false,
      running = false,
      postId = "";
    const handoff = global.OFEnhancerTeaserRenderHandoff?.mount({
      dialog,
      heading,
      date,
      request,
      status,
      getContext: () => context,
      getFrame: () => iframe,
      busy: () =>
        running ||
        loading ||
        Boolean(context?.draft?.sessionId) ||
        Boolean(postId),
      loadFile: (clip, current) => clipFile(clip, request, status, current),
    });
    async function refreshDestinations() {
      const scrollTop = destination.scrollTop;
      const [reddit, twitter, batch] = await Promise.all([
        global.OFEnhancerTeaserDrafts.listPosts(date),
        global.OFEnhancerTeaserDrafts.get(date),
        global.OFEnhancerTeaserDrafts.getBatch(date),
      ]);
      batchControls.hidden = reddit.length === 0 && !postId;
      const enabled = reddit.filter((post) => post.enabled !== false).length;
      count.textContent = enabled
        ? `${enabled} ${enabled === 1 ? "community" : "communities"}`
        : "";
      search.hidden = reddit.length < 5;
      if (batch) {
        start.value = batch.start;
        gapMinutes = batch.gapMinutes;
      } else {
        try {
          const remembered = JSON.parse(
            localStorage.getItem("OFEnhancerRedditBatchPreferencesV1") || "{}",
          );
          if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(remembered.start || ""))
            start.value = remembered.start;
          if (
            Number.isInteger(remembered.gapMinutes) &&
            remembered.gapMinutes >= 1 &&
            remembered.gapMinutes <= 1440
          )
            gapMinutes = remembered.gapMinutes;
        } catch {
          /* Use defaults. */
        }
      }
      reddit.sort(
        (a, b) =>
          (a.order ?? a.updatedAt) - (b.order ?? b.updatedAt) ||
          a.id.localeCompare(b.id),
      );
      const posts = [{ ...twitter, id: "x", platform: "x" }, ...reddit];
      if (postId && !posts.some((post) => post.id === postId))
        posts.push({ id: postId, platform: "reddit" });
      destination.replaceChildren();
      for (const post of posts) {
        const name =
          post.platform === "x"
            ? "Twitter"
            : post.subreddit
              ? `r/${post.subreddit}`
              : "New Reddit post";
        const row = action("", "xt-planner-post");
        row.dataset.postId = post.id;
        row.setAttribute("aria-label", `Edit ${name} post`);
        row.setAttribute("aria-pressed", String(post.id === (postId || "x")));
        const state =
          post.platform === "reddit"
            ? post.enabled === false
              ? "Not selected"
              : post.sessionId
                ? post.status
                : "Local draft"
            : post.status || "New";
        row.append(node("strong", "", name));
        if (post.id === (postId || "x"))
          selectedInfo.textContent = post.sessionId ? `${name} · ${state}` : "";
        row.title = post.file?.name || post.name || "Choose a clip";
        row.addEventListener("click", () => void switchPost(post.id));
        if (post.platform === "reddit") {
          const target = node("div", "xt-planner-target");
          const check = node("input", "");
          check.type = "checkbox";
          check.checked = post.enabled !== false;
          check.setAttribute("aria-label", `Include ${name}`);
          check.addEventListener("change", async () => {
            if (loading || running) {
              check.checked = post.enabled !== false;
              return;
            }
            check.disabled = true;
            loading = true;
            try {
              await global.OFEnhancerTeaserDrafts.setPostEnabled(
                post.id,
                check.checked,
              );
              await refreshDestinations();
              await Promise.resolve(onSaved());
            } catch (error) {
              check.checked = post.enabled !== false;
              status.textContent = error.message;
            } finally {
              loading = false;
              check.disabled = false;
            }
          });
          target.append(check, row);
          destination.append(target);
        } else destination.append(row);
      }
      search.dispatchEvent(new Event("input"));
      destination.scrollTop = scrollTop;
      removePost.hidden = !postId;
      removePost.disabled = Boolean(
        reddit.find((post) => post.id === postId)?.sessionId,
      );
    }
    async function updateBatch() {
      if (loading || running || !start.value || !start.validity.valid) return;
      loading = true;
      start.disabled = true;
      for (const row of destination.querySelectorAll("button,input"))
        row.disabled = true;
      try {
        await global.OFEnhancerTeaserDrafts.saveBatch({
          date,
          start: start.value,
          gapMinutes,
        });
        try {
          localStorage.setItem(
            "OFEnhancerRedditBatchPreferencesV1",
            JSON.stringify({
              start: start.value,
              gapMinutes,
            }),
          );
        } catch {
          /* The batch is still saved. */
        }
        await refreshDestinations();
        status.textContent = "Reddit timing saved · local drafts only.";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        loading = false;
        start.disabled = false;
        for (const row of destination.querySelectorAll("button,input"))
          row.disabled = false;
      }
    }
    start.addEventListener("change", () => void updateBatch());
    communities.addEventListener("click", async () => {
      if (running || loading) return;
      if (dirty) {
        status.textContent = "Save this draft before choosing communities.";
        return;
      }
      loading = true;
      try {
        const source = await (postId
          ? global.OFEnhancerTeaserDrafts.getPost(postId)
          : global.OFEnhancerTeaserDrafts.get(date));
        if (!source?.file)
          throw new Error("Save a clip and title before choosing communities.");
        const client = iframe?.contentWindow?.CreatorCatalogueClient;
        const presets = iframe?.contentWindow?.CreatorSubredditPresets;
        if (!client?.getSubredditPresetSnapshot || !presets)
          throw new Error("Reconnect the catalogue to load communities.");
        const response = await client.getSubredditPresetSnapshot();
        if (!dialog.isConnected) return;
        const targets = presets.rankReady(
          presets.normalizeSnapshot(response.rows),
        );
        const added = new Set(
          (await global.OFEnhancerTeaserDrafts.listPosts(date)).map((post) =>
            post.subreddit.toLowerCase(),
          ),
        );
        destinations.querySelector(".xt-planner-community-picker")?.remove();
        const picker = node("div", "xt-planner-community-picker");
        const filter = node("input", "");
        filter.type = "search";
        filter.placeholder = "Search communities";
        filter.setAttribute("aria-label", "Search worksheet communities");
        const list = node("div", "xt-planner-community-list");
        const picked = new Set();
        const add = action("Add selected (0)");
        add.disabled = true;
        for (const preset of targets) {
          const label = node("label", "xt-planner-community");
          const check = node("input", "");
          check.type = "checkbox";
          check.disabled =
            preset.status === "Rejected" ||
            added.has(preset.subreddit.toLowerCase());
          label.append(
            check,
            node("span", "", `r/${preset.subreddit}`),
            node(
              "small",
              "",
              added.has(preset.subreddit.toLowerCase())
                ? "Added"
                : preset.status,
            ),
          );
          label.title = [preset.status, preset.notes]
            .filter(Boolean)
            .join(" � ");
          label.dataset.name = preset.subreddit.toLowerCase();
          check.addEventListener("change", () => {
            if (check.checked) picked.add(preset.subreddit);
            else picked.delete(preset.subreddit);
            add.textContent = `Add selected (${picked.size})`;
            add.disabled = picked.size === 0;
          });
          list.append(label);
        }
        filter.addEventListener("input", () => {
          for (const row of list.children)
            row.hidden = !row.dataset.name.includes(
              filter.value.trim().toLowerCase().replace(/^r\//, ""),
            );
        });
        const cancel = action("Cancel");
        cancel.addEventListener("click", () => picker.remove());
        const actions = node("div", "xt-planner-post-actions");
        actions.append(add, cancel);
        const message = node(
          "p",
          "",
          `${targets.length} worksheet communities`,
        );
        message.setAttribute("role", "status");
        picker.append(filter, list, message, actions);
        postActions.after(picker);
        add.addEventListener("click", async () => {
          if (loading || running || !picked.size) return;
          if (dirty) {
            message.textContent = "Save this draft before adding communities.";
            return;
          }
          const selected = [...picked];
          loading = true;
          add.disabled = true;
          cancel.disabled = true;
          try {
            const template = await (postId
              ? global.OFEnhancerTeaserDrafts.getPost(postId)
              : global.OFEnhancerTeaserDrafts.get(date));
            if (!template?.file)
              throw new Error(
                "Save a clip and title before adding communities.",
              );
            await global.OFEnhancerTeaserDrafts.saveBatch({
              date,
              start: start.value,
              gapMinutes,
            });
            await global.OFEnhancerTeaserDrafts.savePosts(
              { ...template, date, time: start.value },
              selected,
            );
            picker.remove();
            await refreshDestinations();
            await Promise.resolve(onSaved());
            status.textContent = `${selected.length} Reddit drafts added · not scheduled.`;
          } catch (error) {
            message.textContent = error.message;
            add.disabled = false;
            cancel.disabled = false;
          } finally {
            loading = false;
          }
        });
      } catch (error) {
        status.textContent = error.message;
      } finally {
        loading = false;
      }
    });
    const confirmDiscard = () =>
      global.OFEnhancerDialogDismiss.confirm({
        title: "Discard changes?",
        message: "Your unsaved teaser edits will be lost.",
        acceptLabel: "Discard changes",
        cancelLabel: "Keep editing",
      });
    async function switchPost(id) {
      if (running || loading || (dirty && !(await confirmDiscard()))) {
        return;
      }
      destinations.querySelector(".xt-planner-community-picker")?.remove();
      // Preserve the controls before replacing their current iframe document.
      heading.after(destinations);
      destinations.hidden = true;
      dirty = false;
      iframe = null;
      postId = id === "x" ? "" : id;
      loading = true;
      try {
        await refreshDestinations();
        const draft = postId
          ? await global.OFEnhancerTeaserDrafts.getPost(postId)
          : await global.OFEnhancerTeaserDrafts.get(date);
        if (!dialog.isConnected) return;
        if (draft) edit(draft.file, null, draft);
        else {
          episode = null;
          await choose();
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        loading = false;
      }
    }
    removePost.addEventListener("click", async () => {
      if (
        running ||
        loading ||
        !(await global.OFEnhancerDialogDismiss.confirm({
          title: "Remove draft?",
          message: "This Reddit draft will be removed.",
          acceptLabel: "Remove draft",
          cancelLabel: "Keep draft",
        }))
      )
        return;
      try {
        await global.OFEnhancerTeaserDrafts.removePost(postId);
        dirty = false;
        await onSaved();
        await switchPost("x");
      } catch (error) {
        status.textContent = error.message;
      }
    });
    let confirming = false;
    const closeDialog = async () => {
      if (running) {
        status.textContent =
          "Keep this window open while Twitter preparation is running.";
        return;
      }
      if (confirming) return;
      if (dirty) {
        confirming = true;
        const discard = await confirmDiscard();
        confirming = false;
        if (!discard || running) return;
      }
      if (dialog.dataset.closing) return;
      dialog.dataset.closing = "true";
      dialog.inert = true;
      void dialog
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 140,
          fill: "forwards",
        })
        .finished.catch(() => {})
        .then(() => dialog.close());
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
      if (
        event.data?.type === "ofenhancer:teaser-render-manual" &&
        event.data.file instanceof File
      ) {
        context.file = event.data.file;
        context.clipId = null;
        context.loadingMedia = false;
      }
      handoff?.receive(event.data || {});
      if (event.data?.type === "ofenhancer:teaser-ready")
        iframe.contentWindow.postMessage(
          { type: "ofenhancer:teaser-context", ...context },
          location.origin,
        );
      if (
        event.data?.type === "ofenhancer:teaser-initialized" &&
        event.data.date === date
      ) {
        context.formReady = true;
        iframe.style.removeProperty("visibility");
        stopEditorLoading();
        if (!dialog.open) {
          dialog.showModal();
          close.focus();
        }
      }
      if (event.data?.type === "ofenhancer:teaser-dirty") {
        dirty = true;
        if (status.dataset.saved) status.textContent = "";
        delete status.dataset.saved;
      }
      if (
        event.data?.type === "ofenhancer:teaser-episode" &&
        typeof event.data.title === "string"
      ) {
        title.textContent = event.data.title || `Teaser · ${dayLabel(date)}`;
        if (
          event.data.episodeKey &&
          event.data.episodeKey !== context?.episodeKey
        ) {
          context.episodeKey = event.data.episodeKey;
          const folder = tools.querySelector(".xt-episode-folder");
          if (folder) folder.disabled = false;
          void handoff?.setEpisode(context.episodeKey, !postId);
        }
      }
      if (event.data?.type === "ofenhancer:teaser-running") {
        running = event.data.running === true;
        more.disabled = running;
        const episodeButton = heading.querySelector(".teaser-link-episode");
        if (episodeButton)
          episodeButton.disabled =
            running || Boolean(context?.draft?.sessionId);
        handoff?.refresh();
      }
      if (
        [
          "ofenhancer:teaser-copying",
          "ofenhancer:teaser-copy-error",
          "ofenhancer:teaser-imported",
        ].includes(event.data?.type)
      )
        delete status.dataset.saved;
      if (event.data?.type === "ofenhancer:teaser-copying")
        status.textContent = "Copying to .TWEETS…";
      if (event.data?.type === "ofenhancer:teaser-copy-error")
        status.textContent = event.data.message;
      if (
        event.data?.type === "ofenhancer:teaser-imported" &&
        event.data.episodeKey === context?.episodeKey &&
        event.data.file instanceof File
      ) {
        context.file = event.data.file;
        context.clipId = event.data.clipId;
        context.draft = event.data.draft;
        status.textContent = `Copied as ${event.data.file.name}`;
        void handoff?.setEpisode(context.episodeKey, !postId);
      }
      if (
        event.data?.type === "ofenhancer:teaser-size" &&
        Number.isFinite(event.data.height) &&
        !dialog.dataset.editor
      )
        iframe.style.height = `${Math.min(20000, Math.max(200, event.data.height))}px`;
      if (event.data?.type === "ofenhancer:teaser-saved") {
        dirty = false;
        status.dataset.saved = "true";
        status.textContent = postId
          ? "Reddit draft saved locally · not scheduled."
          : "Draft saved for this day.";
        void refreshDestinations().catch((error) => {
          delete status.dataset.saved;
          status.textContent = error.message;
        });
        Promise.resolve(onSaved()).catch(() => {
          delete status.dataset.saved;
          status.textContent = "Draft saved. Refresh the calendar to see it.";
        });
      }
    };
    window.addEventListener("message", receive);
    dialog.addEventListener(
      "close",
      () => {
        catalogueObserver?.disconnect();
        previewObserver?.disconnect();
        stopPreview();
        stopEditorLoading();
        document.removeEventListener("visibilitychange", visibilityChanged);
        handoff?.close();
        window.removeEventListener("message", receive);
        dialog.remove();
        active = null;
        opener?.focus?.();
      },
      { once: true },
    );
    function edit(file = null, clip = null, draft = null) {
      delete status.dataset.saved;
      if (
        file &&
        (!file.size ||
          file.size >= 512 * 1024 * 1024 ||
          !/\.(mp4|mov|m4v|webm)$/i.test(file.name))
      ) {
        status.textContent =
          "Choose an MP4, MOV, M4V or WebM video under 512 MB.";
        return;
      }
      catalogueObserver?.disconnect();
      previewObserver?.disconnect();
      stopPreview();
      stopEditorLoading();
      dialog.dataset.editor = "true";
      dirty = Boolean(file && !draft);
      title.textContent =
        episodes.find((item) => item.sourceKey === draft?.episodeKey)?.title ||
        episode?.title ||
        file?.name ||
        clip?.name ||
        `Teaser · ${dayLabel(date)}`;
      context = {
        date,
        file,
        episodeTitle:
          episodes.find((item) => item.sourceKey === draft?.episodeKey)
            ?.title ||
          episode?.title ||
          "",
        episodeKey:
          draft?.episodeKey || episode?.sourceKey || clip?.episodeKey || "",
        clipId: draft?.clipId || clip?.clipId || null,
        draft,
        postId,
        platform: postId ? "reddit" : "x",
        loadingMedia: Boolean(clip && !file),
      };
      const back = action("Replace video");
      back.classList.add("xt-change-clip");
      heading.querySelector(".xt-choose-video")?.remove();
      heading.querySelector(".xt-change-clip")?.remove();
      heading.querySelector(".xt-episode-folder")?.remove();
      heading.querySelector(".teaser-copy-file")?.remove();
      heading.querySelector(".teaser-link-episode")?.remove();
      tools.hidePopover();
      tools.replaceChildren();
      more.hidden = false;
      const folder = action("Open episode folder");
      folder.classList.add("xt-episode-folder");
      folder.disabled = !context.episodeKey;
      folder.addEventListener("click", async () => {
        tools.hidePopover();
        try {
          await request("openTeaserEpisodeFolder", {
            episodeKey: context.episodeKey,
          });
        } catch (error) {
          status.textContent = error.message;
        }
      });
      tools.append(folder);
      close.setAttribute("aria-label", "Close");
      close.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
      back.addEventListener("click", () => {
        if (!running && !loading)
          iframe?.contentDocument
            ?.querySelector("#uploadSocialTeaser")
            ?.click();
      });
      iframe = node("iframe", "xt-composer-frame");
      iframe.style.visibility = "hidden";
      iframe.title = postId
        ? "Reddit teaser draft"
        : "Twitter teaser upload hub";
      iframe.src = `upload-console.html?teaserDay=${encodeURIComponent(date)}`;
      const frame = iframe;
      iframe.addEventListener("load", () => {
        if (iframe !== frame || !dialog.isConnected) return;
        const mediaHeading = frame.contentDocument?.querySelector(
          ".teaser-media-header",
        );
        if (mediaHeading) mediaHeading.append(back);
        const episodeButton = frame.contentDocument?.querySelector(
          ".teaser-link-episode",
        );
        if (episodeButton) {
          heading.querySelector(".teaser-link-episode")?.remove();
          episodeButton.classList.add("xt-action");
          heading.insertBefore(
            episodeButton,
            heading.querySelector(".xt-vegas-trigger") || more,
          );
        }
        const copy = frame.contentDocument?.querySelector(".teaser-copy-file");
        if (copy) {
          tools.querySelector(".teaser-copy-file")?.remove();
          copy.classList.add("xt-action");
          copy.replaceChildren(document.createTextNode("Copy to .TWEETS"));
          copy.addEventListener("click", () => tools.hidePopover());
          tools.append(copy);
        }
        const posts = frame.contentDocument?.querySelector(
          ".teaser-planner-posts",
        );
        if (posts) {
          destinations.hidden = false;
          posts.append(destinations);
        }
      });
      function waitForForm() {
        stopEditorLoading();
        editorLoadTimer = setTimeout(() => {
          if (iframe !== frame || !dialog.isConnected) return;
          const error = node(
            "div",
            "xt-editor-error",
            "The editor could not open.",
          );
          error.setAttribute("role", "alert");
          const retry = action("Retry");
          retry.addEventListener("click", () => {
            heading.after(destinations);
            destinations.hidden = true;
            frame.style.visibility = "hidden";
            waitForForm();
            frame.contentWindow.location.reload();
          });
          error.append(retry);
          content.prepend(error);
          if (!dialog.open) dialog.showModal();
        }, 10000);
      }
      content.replaceChildren(iframe);
      waitForForm();
      void handoff?.setEpisode(context.episodeKey, !postId);
      status.textContent = postId ? "Local Reddit draft · not scheduled." : "";
    }
    async function editClip(clip, linked) {
      if (loading) return;
      episode = linked || null;
      edit(null, clip);
      const frame = iframe;
      const pending = context;
      const current = () =>
        dialog.isConnected && iframe === frame && context === pending;
      loading = true;
      try {
        const file = await clipFile(clip, request, status, current);
        if (!current()) return;
        context.file = file;
        context.loadingMedia = false;
        frame.contentWindow.postMessage(
          { type: "ofenhancer:teaser-file", date, clipId: clip.clipId, file },
          location.origin,
        );
        status.textContent = "";
      } catch (error) {
        if (!current()) return;
        delete status.dataset.saved;
        context.loadingMedia = false;
        status.textContent = linked
          ? `${error.message} Open the episode folder to create a replacement.`
          : error.message;
        context.mediaError = error.message;
        frame.contentWindow.postMessage(
          { type: "ofenhancer:teaser-file-error", date, clipId: clip.clipId },
          location.origin,
        );
      } finally {
        loading = false;
        handoff?.refresh();
      }
    }
    async function choose() {
      more.hidden = true;
      tools.hidePopover();
      tools.replaceChildren();
      heading.querySelector(".teaser-link-episode")?.remove();
      stopEditorLoading();
      stopPreview();
      previewObserver?.disconnect();
      previewObserver = new global.IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (entry.isIntersecting) {
              previewObserver.unobserve(entry.target);
              void entry.target.loadPoster();
            }
        },
        { root: content, rootMargin: "100px" },
      );
      delete status.dataset.saved;
      catalogueObserver?.disconnect();
      delete dialog.dataset.editor;
      handoff?.close();
      if (!episode && !episodes.length) {
        edit();
        return;
      }
      heading.querySelector(".xt-choose-video")?.remove();
      heading.querySelector(".xt-change-clip")?.remove();
      heading.querySelector(".xt-episode-folder")?.remove();
      heading.querySelector(".teaser-copy-file")?.remove();
      heading.after(destinations);
      destinations.hidden = true;
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
      if (episode) {
        add.className = "xt-action xt-choose-video";
        add.title = "Choose video";
        add.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 3H5v18h14V8ZM14 3v5h5M8 14h8m-4-4v8"/></svg>';
        heading.insertBefore(add, close);
      } else grid.append(add);
      content.replaceChildren(grid, input);
      grid.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      grid.addEventListener("drop", (event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files?.[0];
        if (file && !loading) edit(file);
      });
      title.textContent =
        episode?.title || `Teaser planner · ${dayLabel(date)}`;
      title.title = `${title.textContent} · ${dayLabel(date)}`;
      if (episode) {
        const folder = action("");
        folder.classList.add("xt-episode-folder");
        folder.setAttribute("aria-label", "Open episode folder");
        folder.title = "Open episode folder";
        folder.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3Z"/></svg>';
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
        heading.insertBefore(folder, close);
      }
      let clips = [];
      let catalogueView = null;
      if (renderCatalogue && !episode) {
        const catalogue = renderCatalogue((item) => {
          episode = item;
          const available = clips.filter(
            (clip) => clip.episodeKey === item.sourceKey,
          );
          if (available.length === 1) void editClip(available[0], item);
          else void choose();
        });
        const upload = node("li", "xt-card xt-upload-choice");
        add.className = "xt-episode xt-clip-add";
        upload.append(add);
        let wall = catalogue.querySelector(".xt-cards");
        if (!wall) {
          wall = node("ul", "xt-cards");
          catalogue.append(wall);
        }
        wall.prepend(upload);
        const wrapper = node("div", "xt xt-composer-catalogue");
        wrapper.append(catalogue);
        wrapper.addEventListener("dragover", (event) => event.preventDefault());
        wrapper.addEventListener("drop", (event) => {
          event.preventDefault();
          const file = event.dataTransfer?.files?.[0];
          if (file && !loading) edit(file);
        });
        catalogueView = wrapper;
        content.replaceChildren(wrapper, input);
        layoutCatalogue(wall);
        if (global.ResizeObserver) {
          catalogueObserver = new ResizeObserver(() =>
            layoutCatalogue(wrapper.querySelector(".xt-cards")),
          );
          catalogueObserver.observe(wrapper);
        }
      }
      status.textContent = catalogueView ? "" : "Loading ready clips…";
      try {
        const library = await request("getTeaserClips", {});
        if (
          !dialog.isConnected ||
          iframe ||
          !(catalogueView || grid).isConnected
        )
          return;
        const ranked = new Map(
          recommendations.map((item, index) => [
            item.episode.sourceKey,
            { ...item, rank: index + 1 },
          ]),
        );
        clips = (library.clips || [])
          .filter((clip) => !episode || clip.episodeKey === episode.sourceKey)
          .sort(
            (left, right) =>
              (ranked.get(left.episodeKey)?.rank || Infinity) -
              (ranked.get(right.episodeKey)?.rank || Infinity),
          );
        if (episode && !clips.length) {
          edit();
          return;
        }
        if (catalogueView) {
          const wall = catalogueView.querySelector(".xt-cards");
          for (const clip of clips.filter((item) => !item.episodeKey)) {
            const item = node("li", "xt-card xt-unlinked-choice");
            const choice = action("", "xt-episode");
            choice.title = clip.name;
            choice.setAttribute("aria-label", clip.name);
            choice.append(
              node("span", "xt-thumb"),
              node("span", "xt-pick-reason", "Unlinked clip"),
            );
            choice.addEventListener("click", () => editClip(clip, null));
            item.append(choice);
            wall.append(item);
          }
          layoutCatalogue(wall);
          status.textContent = "";
          return;
        }
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
          choice.title = clip.name;
          choice.setAttribute("aria-label", `Open ${clip.name}`);
          const stem = clip.name.replace(/\.[^.]+$/, "");
          const shortName = episode
            ? stem
                .replace(/^.*?(?=(?:__?t\d+|teaser|teasr)[-_])/i, "")
                .replace(/^_+/, "")
            : stem;
          choice.append(
            node("strong", "", shortName || stem),
            node(
              "small",
              "",
              clip.state === "failed"
                ? "Needs re-edit"
                : episode
                  ? clip.name.split(".").pop().toUpperCase()
                  : linked?.title || "Unlinked clip",
            ),
          );
          previewCard(choice, clip);
          choice.addEventListener("click", () => editClip(clip, linked));
          grid.append(choice);
        }
        const withoutClips = episodes
          .filter(
            (item) =>
              (!episode || item.sourceKey === episode.sourceKey) &&
              !clips.some((clip) => clip.episodeKey === item.sourceKey),
          )
          .sort(
            (left, right) =>
              (ranked.get(left.sourceKey)?.rank || Infinity) -
              (ranked.get(right.sourceKey)?.rank || Infinity),
          );
        for (const item of withoutClips) {
          const choice = action("", "xt-clip-choice xt-episode-choice");
          choice.dataset.episodeKey = item.sourceKey;
          choice.append(
            node("strong", "", item.title),
            node("small", "", "Create teaser"),
          );
          choice.addEventListener("click", () => {
            episode = item;
            edit();
          });
          grid.append(choice);
        }
        status.textContent = clips.length
          ? ""
          : "No ready clips here yet. Choose a video to start.";
      } catch {
        if (
          !dialog.isConnected ||
          iframe ||
          !(catalogueView || grid).isConnected
        )
          return;
        if (episode) edit();
        status.textContent = catalogueView
          ? "Ready clips are unavailable. Choose an episode or a video."
          : "Ready clips are unavailable. You can still choose a video.";
      }
    }
    try {
      await refreshDestinations();
      const draft = await global.OFEnhancerTeaserDrafts.get(date);
      if (draft) edit(draft.file, null, draft);
      else await choose();
    } catch (error) {
      await choose();
      status.textContent = error.message;
    }
    if (!dialog.open && (!iframe || context?.formReady)) {
      dialog.showModal();
      close.focus();
    }
  }
  global.OFEnhancerTeaserComposer = Object.freeze({ open, clipFile });
})(globalThis);
