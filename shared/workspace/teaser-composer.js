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
    renderCatalogue = null,
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
    const title = node("h2", "", `Teaser planner · ${dayLabel(date)}`);
    const close = action("Close");
    heading.append(title, close);
    const destinations = node("div", "xt-composer-destinations");
    destinations.hidden = true;
    destinations.setAttribute("role", "group");
    destinations.setAttribute("aria-label", "Destination posts");
    const destination = node("div", "xt-planner-post-list");
    const addPost = action("Add Reddit post");
    const removePost = action("Remove post");
    removePost.hidden = true;
    const postActions = node("div", "xt-planner-post-actions");
    postActions.append(addPost, removePost);
    destinations.append(node("h3", "", "Posts"), destination, postActions);
    const content = node("div", "xt-composer-content");
    const status = node("p", "xt-composer-status");
    status.setAttribute("role", "status");
    dialog.append(heading, destinations, content, status);
    document.body.append(dialog);
    const opener = document.activeElement;
    let iframe = null,
      context = null,
      dirty = false,
      loading = false,
      running = false,
      postId = "";
    async function refreshDestinations() {
      const [reddit, twitter] = await Promise.all([
        global.OFEnhancerTeaserDrafts.listPosts(date),
        global.OFEnhancerTeaserDrafts.get(date),
      ]);
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
          post.platform === "reddit" ? "Local draft" : post.status || "New";
        row.append(
          node("strong", "", name),
          node(
            "span",
            "xt-planner-post-state",
            `${post.time || "—"} · ${state}`,
          ),
          node("small", "", post.file?.name || post.name || "Choose a clip"),
        );
        row.addEventListener("click", () => void switchPost(post.id));
        destination.append(row);
      }
      removePost.hidden = !postId;
    }
    async function switchPost(id, reuseClip = false) {
      if (
        running ||
        loading ||
        (dirty && !confirm("Switch posts and discard unsaved changes?"))
      ) {
        return;
      }
      const previous = context;
      // Preserve the controls before replacing their current iframe document.
      heading.after(destinations);
      destinations.hidden = true;
      dirty = false;
      iframe = null;
      postId = id === "x" ? "" : id;
      loading = true;
      try {
        const source =
          reuseClip && previous
            ? (await (previous.postId
                ? global.OFEnhancerTeaserDrafts.getPost(previous.postId)
                : global.OFEnhancerTeaserDrafts.get(date))) || previous
            : previous;
        await refreshDestinations();
        const draft = postId
          ? await global.OFEnhancerTeaserDrafts.getPost(postId)
          : await global.OFEnhancerTeaserDrafts.get(date);
        if (!dialog.isConnected) return;
        if (draft) edit(draft.file, null, draft);
        else if (reuseClip && source?.file) {
          episode =
            episodes.find((item) => item.sourceKey === source.episodeKey) ||
            episode;
          edit(source.file);
          context.episodeKey = source.episodeKey || "";
        } else {
          episode = null;
          await choose();
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        loading = false;
      }
    }
    addPost.addEventListener(
      "click",
      () => void switchPost(crypto.randomUUID(), true),
    );
    removePost.addEventListener("click", async () => {
      if (running || loading || !confirm("Remove this Reddit draft?")) return;
      try {
        await global.OFEnhancerTeaserDrafts.removePost(postId);
        dirty = false;
        await onSaved();
        await switchPost("x");
      } catch (error) {
        status.textContent = error.message;
      }
    });
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
      if (
        event.data?.type === "ofenhancer:teaser-size" &&
        Number.isFinite(event.data.height)
      )
        iframe.style.height = `${Math.min(20000, Math.max(200, event.data.height))}px`;
      if (event.data?.type === "ofenhancer:teaser-saved") {
        dirty = false;
        status.textContent = postId
          ? "Reddit draft saved locally · not scheduled."
          : "Draft saved for this day.";
        void refreshDestinations().catch((error) => {
          status.textContent = error.message;
        });
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
    function edit(file = null, clip = null, draft = null) {
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
      dirty = Boolean(file && !draft);
      context = {
        date,
        file,
        episodeKey:
          draft?.episodeKey || episode?.sourceKey || clip?.episodeKey || "",
        clipId: draft?.clipId || clip?.clipId || null,
        draft,
        postId,
        platform: postId ? "reddit" : "x",
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
      iframe.title = postId
        ? "Reddit teaser draft"
        : "Twitter teaser upload hub";
      iframe.src = `upload-console.html?teaserDay=${encodeURIComponent(date)}`;
      const frame = iframe;
      iframe.addEventListener(
        "load",
        () => {
          if (iframe !== frame || !dialog.isConnected) return;
          const posts = frame.contentDocument?.querySelector(
            ".teaser-planner-posts",
          );
          if (posts) {
            destinations.hidden = false;
            posts.append(destinations);
          }
        },
        { once: true },
      );
      content.replaceChildren(back, iframe);
      status.textContent = postId ? "Local Reddit draft · not scheduled." : "";
    }
    async function editClip(clip, linked) {
      if (loading) return;
      loading = true;
      try {
        const file = await clipFile(clip, request, status);
        if (dialog.isConnected) edit(file, clip);
      } catch (error) {
        if (!dialog.isConnected) return;
        if (linked) {
          episode = linked;
          edit();
          status.textContent = `${error.message} Open the episode folder to edit a replacement teaser.`;
        } else status.textContent = error.message;
      } finally {
        loading = false;
      }
    }
    async function choose() {
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
        if (episode && !clips.length) {
          edit();
          return;
        }
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
          const wall = catalogue.querySelector(".xt-cards");
          if (!wall) {
            status.textContent = "";
            return;
          }
          wall.prepend(upload);
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
          const wrapper = node("div", "xt xt-composer-catalogue");
          wrapper.append(catalogue);
          wrapper.addEventListener("dragover", (event) =>
            event.preventDefault(),
          );
          wrapper.addEventListener("drop", (event) => {
            event.preventDefault();
            const file = event.dataTransfer?.files?.[0];
            if (file && !loading) edit(file);
          });
          content.replaceChildren(wrapper, input);
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
        if (episode) edit();
        status.textContent =
          "Ready clips are unavailable. You can still choose a video.";
      }
    }
    dialog.showModal();
    close.focus();
    try {
      await refreshDestinations();
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
