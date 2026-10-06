(function (global) {
  "use strict";
  function init(hub) {
    const day = new URLSearchParams(location.search).get("teaserDay");
    if (
      !global.OFEnhancerTeaserDrafts.validDay(day) ||
      window.parent === window
    )
      return null;
    document.body.classList.add("calendar-teaser");
    const get = (selector) => document.querySelector(selector);
    const notify = (type, extra = {}) =>
      window.parent.postMessage(
        { type: `ofenhancer:teaser-${type}`, ...extra },
        location.origin,
      );
    const caption = get("#socialCaption");
    const captionLabel = caption.previousElementSibling;
    caption.maxLength = 280;
    caption.placeholder = "Write the teaser caption…";
    captionLabel.textContent = "Twitter caption";
    get("#socialHeading").textContent = "Twitter teaser";
    const panel = document.createElement("div");
    panel.className = "teaser-preview-panel";
    panel.innerHTML =
      '<div class="teaser-planner-media"><video class="teaser-video-preview" controls playsinline preload="auto" aria-label="Teaser preview"></video><div class="teaser-thumbnail-panel"><img alt="Teaser thumbnail" hidden><button type="button" class="teaser-use-frame">Use frame</button><label class="teaser-thumbnail-upload">Image<input type="file" accept="image/png,image/jpeg" hidden></label></div></div><div class="teaser-planner-settings"><div class="teaser-planner-posts"></div></div>';
    caption.previousElementSibling.before(panel);
    const preview = panel.querySelector("video"),
      image = panel.querySelector("img");
    const chooseVideo = document.createElement("button");
    chooseVideo.type = "button";
    chooseVideo.className = "teaser-choose-video";
    chooseVideo.textContent = "Choose or drop teaser video";
    preview.before(chooseVideo);
    chooseVideo.addEventListener("click", () =>
      get("#uploadSocialTeaser").click(),
    );
    panel.addEventListener("dragover", (event) => event.preventDefault());
    panel.addEventListener("drop", (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file && !hub.busy() && !context?.draft?.sessionId) acceptFile(file);
    });
    const timeLabel = document.createElement("label");
    timeLabel.textContent = "Posting time";
    timeLabel.className = "teaser-schedule-field";
    const time = document.createElement("input");
    time.type = "time";
    time.value = "18:00";
    timeLabel.append(time);
    caption.after(timeLabel);
    const replyLabel = document.createElement("label");
    replyLabel.textContent = "Reply (min)";
    replyLabel.className = "teaser-schedule-field";
    const replyDelay = document.createElement("input");
    replyDelay.type = "number";
    replyDelay.min = "1";
    replyDelay.max = "1440";
    replyDelay.value = "15";
    replyLabel.append(replyDelay);
    timeLabel.after(replyLabel);
    const linkFields = get("#socialPaidLinkFields");
    linkFields.querySelector('label[for="socialPaidLink"]').textContent =
      "Video link";
    const scheduleRow = document.createElement("div");
    scheduleRow.className = "teaser-schedule-row";
    caption.after(scheduleRow);
    scheduleRow.append(timeLabel, replyLabel, linkFields);
    const customLink = get("#socialCustomPaidLinkField");
    scheduleRow.after(customLink);
    panel
      .querySelector(".teaser-planner-settings")
      .append(captionLabel, caption, scheduleRow, customLink);
    const subredditLabel = document.createElement("label");
    subredditLabel.textContent = "Subreddit";
    subredditLabel.className = "teaser-schedule-field";
    subredditLabel.hidden = true;
    const subreddit = document.createElement("input");
    subreddit.type = "text";
    subreddit.placeholder = "r/community";
    subreddit.maxLength = 23;
    subreddit.setAttribute("aria-label", "Subreddit");
    subredditLabel.append(subreddit);
    subreddit.addEventListener("input", () => notify("dirty"));
    const PREFS = "OFEnhancerTeaserPreferencesV1";
    let preferences = {};
    try {
      preferences = JSON.parse(localStorage.getItem(PREFS) || "{}") || {};
    } catch {
      /* Use defaults. */
    }
    const remember = () => {
      if (context?.platform === "reddit") return;
      const option = get("#socialPaidLink").selectedOptions[0];
      const linkKind =
        option?.value === "custom"
          ? "custom"
          : /onlyfans/i.test(option?.textContent || "")
            ? "onlyfans"
            : /fansly/i.test(option?.textContent || "")
              ? "fansly"
              : "";
      try {
        localStorage.setItem(
          PREFS,
          JSON.stringify({
            time: time.value,
            replyDelayMinutes: Number(replyDelay.value),
            linkKind,
            customUrl:
              linkKind === "custom" ? get("#socialCustomPaidLink").value : "",
          }),
        );
      } catch {
        /* The day draft can still be saved. */
      }
    };
    for (const control of [
      time,
      replyDelay,
      get("#socialPaidLink"),
      get("#socialCustomPaidLink"),
    ])
      control.addEventListener("change", remember);
    const folder = document.createElement("button");
    folder.type = "button";
    folder.textContent = "Open episode folder";
    get("#catalogueControls").append(folder);
    const association = document.createElement("div");
    association.className = "teaser-association";
    const changeMatch = document.createElement("button");
    changeMatch.type = "button";
    changeMatch.textContent = "Change episode";
    changeMatch.setAttribute("aria-expanded", "false");
    association.append(changeMatch, folder);
    get("#catalogueControls").prepend(association);
    const updateLinked = () => {
      changeMatch.title = hub.candidate()?.title || "No linked episode";
      changeMatch.setAttribute(
        "aria-label",
        `Change episode: ${changeMatch.title}`,
      );
    };
    updateLinked();
    changeMatch.addEventListener("click", () => {
      const expanded = document.body.classList.toggle("teaser-matching");
      changeMatch.setAttribute("aria-expanded", String(expanded));
      if (expanded) get("#catalogueSearch").focus();
    });
    get("#catalogueControls").addEventListener("click", () =>
      setTimeout(updateLinked, 0),
    );
    get("#catalogueRow").addEventListener("change", updateLinked);
    const automatic = get('input[name="socialMode"][value="autonomous"]');
    automatic.closest("label").title =
      "Unchecked: prepare the Twitter draft for manual posting. Checked: post or schedule, then add the first reply.";
    get("#uploadActions").prepend(automatic.closest("label"));
    folder.addEventListener("click", async () => {
      try {
        const key = hub.candidate()?.id;
        if (!key) throw new Error("Choose a catalogue episode first.");
        if (window.parent.OFEnhancerHost)
          await window.parent.OFEnhancerHost.request(
            "openTeaserEpisodeFolder",
            { episodeKey: key },
          );
        else throw new Error("The episode folder is unavailable.");
      } catch (error) {
        fail(error);
      }
    });
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save draft";
    save.id = "saveTeaserDraft";
    get("#uploadActions").prepend(association);
    get("#uploadButton").before(save);
    let thumbnail = null,
      context = null,
      revision = 0,
      videoUrl = "",
      imageUrl = "",
      previewReady = Promise.resolve();
    function fail(error) {
      get("#uploadError").textContent = error.message;
    }
    function useThumbnail(file, dirty = true) {
      ++revision;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      thumbnail = file;
      imageUrl = URL.createObjectURL(file);
      image.src = imageUrl;
      image.hidden = false;
      preview.poster = imageUrl;
      if (dirty) notify("dirty");
    }
    async function showFile(file, restored = null) {
      preview.hidden = false;
      panel.querySelector(".teaser-thumbnail-panel").hidden = false;
      chooseVideo.hidden = true;
      const current = ++revision;
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      videoUrl = URL.createObjectURL(file);
      preview.src = videoUrl;
      try {
        const frame =
          (restored &&
            (await hub.normalizeThumbnail(
              new File([restored], "teaser-thumbnail.png", {
                type: restored.type || "image/png",
              }),
            ))) ||
          (await global.CreatorMediaGenerator.thumbnailFromVideo(file, 0, {
            square: true,
          }));
        if (current === revision) useThumbnail(frame, !restored);
      } catch (error) {
        fail(
          new Error(
            `Thumbnail unavailable: ${error.message} Choose an image or another frame.`,
          ),
        );
      }
    }
    async function saveDraft() {
      if (!hub.file()) throw new Error("Choose a teaser video.");
      if (
        !time.validity.valid ||
        !time.value ||
        (context?.platform !== "reddit" &&
          (!replyDelay.validity.valid ||
            !Number.isInteger(Number(replyDelay.value))))
      )
        throw new Error("Choose a valid posting time and reply delay.");
      await previewReady;
      const candidate = hub.candidate();
      const reddit = context?.platform === "reddit";
      const saved = await global.OFEnhancerTeaserDrafts[
        reddit ? "savePost" : "save"
      ]({
        ...(reddit
          ? {
              id: context.postId,
              subreddit: subreddit.value.trim().replace(/^r\//i, ""),
            }
          : {}),
        date: day,
        file: hub.file(),
        thumbnail,
        caption: caption.value,
        episodeKey: candidate?.id || "",
        clipId: context?.clipId,
        time: time.value,
        replyDelayMinutes: Number(replyDelay.value),
        paidUrl: hub.paidUrl(),
      });
      notify("saved");
      if (!reddit) remember();
      if (!reddit && candidate?.id && window.parent.OFEnhancerHost) {
        try {
          await window.parent.OFEnhancerHost.request("setTeaserPlanSlot", {
            date: day,
            episodeKey: candidate.id,
            ...(context?.clipId && candidate.id === context.episodeKey
              ? { clipId: context.clipId }
              : {}),
          });
        } catch {
          throw new Error(
            "Draft saved. The catalogue calendar could not update; reconnect Chrome and save again.",
          );
        }
      }
      return saved;
    }
    save.addEventListener("click", async () => {
      if (hub.busy()) return;
      save.disabled = true;
      try {
        await saveDraft();
        get("#uploadError").textContent = "";
      } catch (error) {
        fail(error);
      } finally {
        save.disabled = false;
      }
    });
    panel
      .querySelector(".teaser-use-frame")
      .addEventListener("click", async () => {
        if (hub.busy() || !hub.file()) return;
        try {
          useThumbnail(
            await global.CreatorMediaGenerator.thumbnailFromVideo(
              hub.file(),
              preview.currentTime,
              { square: true },
            ),
          );
        } catch (error) {
          fail(error);
        }
      });
    panel.querySelector("input").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (file && !hub.busy()) {
        try {
          useThumbnail(await hub.normalizeThumbnail(file));
        } catch (error) {
          fail(error);
        }
      }
    });
    function acceptFile(file) {
      if (
        !file.size ||
        file.size >= 512 * 1024 * 1024 ||
        !/\.(mp4|mov|m4v|webm)$/i.test(file.name)
      ) {
        fail(new Error("Choose an MP4, MOV, M4V or WebM video under 512 MB."));
        return;
      }
      file.source = "generated";
      if (context && context.file !== file) context.clipId = null;
      hub.setFile(file);
      previewReady = showFile(file);
      notify("dirty");
      if (!hub.candidate())
        void hub
          .associate(context?.episodeKey || "", "")
          .then(() => {
            hub.preferLink(preferences.linkKind, preferences.customUrl);
            updateLinked();
          })
          .catch(fail);
    }
    get("#uploadSocialTeaser").addEventListener("change", () => {
      if (hub.file()) acceptFile(hub.file());
    });
    for (const control of [
      caption,
      time,
      replyDelay,
      get("#socialPaidLink"),
      get("#socialCustomPaidLink"),
      get("#catalogueRow"),
    ])
      control.addEventListener("input", () => notify("dirty"));
    let accepted = false;
    window.addEventListener("message", async (event) => {
      if (
        accepted ||
        event.source !== window.parent ||
        event.origin !== location.origin ||
        event.data?.type !== "ofenhancer:teaser-context" ||
        event.data.date !== day ||
        !(
          event.data.file instanceof File ||
          (event.data.file === null &&
            typeof event.data.episodeKey === "string" &&
            event.data.episodeKey)
        )
      )
        return;
      accepted = true;
      context = event.data;
      if (context.platform === "reddit") {
        document.body.classList.add("calendar-reddit-draft");
        caption.maxLength = 300;
        caption.placeholder = "Write the Reddit title…";
        captionLabel.textContent = "Reddit title";
        subredditLabel.hidden = false;
        scheduleRow.prepend(subredditLabel);
        subreddit.value = context.draft?.subreddit || "";
        timeLabel.hidden = true;
        replyLabel.hidden = true;
        linkFields.hidden = true;
        customLink.hidden = true;
        automatic.closest("label").hidden = true;
        get("#uploadButton").hidden = true;
        get("#uploadButton").disabled = true;
        save.textContent = "Save draft";
        get("#socialHeading").textContent = "Reddit draft";
      }
      if (context.file) context.file.source = "generated";
      hub.setFile(context.file);
      caption.value = context.draft?.caption || "";
      time.value =
        context.draft?.time ||
        (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preferences.time || "")
          ? preferences.time
          : "18:00");
      replyDelay.value = String(
        context.draft?.replyDelayMinutes ||
          (Number.isInteger(preferences.replyDelayMinutes) &&
          preferences.replyDelayMinutes >= 1 &&
          preferences.replyDelayMinutes <= 1440
            ? preferences.replyDelayMinutes
            : 15),
      );
      if (context.file)
        previewReady = showFile(context.file, context.draft?.thumbnail);
      else {
        preview.hidden = true;
        panel.querySelector(".teaser-thumbnail-panel").hidden = true;
      }
      if (context.draft?.sessionId) {
        save.disabled = true;
        get("#uploadButton").disabled = true;
        get("#runNotice").textContent = "This teaser has a saved upload run.";
        const review = document.createElement("button");
        review.type = "button";
        review.textContent = "Review saved run";
        save.before(review);
        review.addEventListener("click", async () => {
          review.disabled = true;
          notify("running", { running: true });
          try {
            await hub.resume(context.draft.sessionId);
          } catch (error) {
            fail(error);
          } finally {
            review.disabled = false;
            notify("running", { running: false });
          }
        });
      }
      try {
        await hub.associate(context.episodeKey, context.draft?.paidUrl || "");
        if (!context.draft)
          hub.preferLink(preferences.linkKind, preferences.customUrl);
        updateLinked();
      } catch (error) {
        fail(error);
      }
    });
    notify("ready");
    let sizeFrame;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(sizeFrame);
      sizeFrame = requestAnimationFrame(() =>
        notify("size", {
          height: Math.ceil(document.body.getBoundingClientRect().height),
        }),
      );
    });
    observer.observe(document.body);
    window.addEventListener("pagehide", () => {
      observer.disconnect();
      cancelAnimationFrame(sizeFrame);
      URL.revokeObjectURL(videoUrl);
      URL.revokeObjectURL(imageUrl);
    });
    return {
      day,
      saveDraft,
      notify,
      locked: () =>
        context?.platform === "reddit" || Boolean(context?.draft?.sessionId),
      thumbnail: () => thumbnail,
      options: () => {
        if (
          !time.validity.valid ||
          !time.value ||
          !replyDelay.validity.valid ||
          !Number.isInteger(Number(replyDelay.value))
        )
          throw new Error("Choose a valid posting time and reply delay.");
        const instant = new Date(`${day}T${time.value}:00`);
        if (!Number.isFinite(instant.getTime()))
          throw new Error("Choose a valid posting time.");
        return {
          sensitive: true,
          scheduledUtc:
            instant.getTime() > Date.now() ? instant.toISOString() : "",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          replyDelayMinutes: Number(replyDelay.value),
        };
      },
    };
  }
  global.OFEnhancerTeaserUploadMode = Object.freeze({ init });
})(globalThis);
