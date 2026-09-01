(() => {
  "use strict";

  if (globalThis.CreatorSocialDistributionOrchestrator) return;

  const COMPLETE = "sheet-complete";
  const TERMINAL = new Set(["failed", "blocked"]);

  function cleanError(error) {
    return String(error?.message || error || "Distribution step failed.")
      .trim()
      .slice(0, 500);
  }

  function platformFor(jobId) {
    if (jobId === "x" || jobId === "redgifs") return jobId;
    if (jobId.startsWith("reddit:")) return "reddit";
    throw new Error("Unknown social distribution job.");
  }

  function targetFor(plan, jobId) {
    if (!jobId.startsWith("reddit:")) return null;
    return (
      plan.targets.reddit.find(
        (target) => target.subreddit.toLowerCase() === jobId.slice(7),
      ) || null
    );
  }

  function assertSheetResult(result, label) {
    if (!new Set(["updated", "idempotent"]).has(result?.status)) {
      throw new Error(`${label} returned ${result?.status || "no status"}.`);
    }
    return result;
  }

  function create({ store, catalogueClient, adapterFor, now = Date.now }) {
    if (!store || !catalogueClient || typeof adapterFor !== "function") {
      throw new Error("Social distribution dependencies are unavailable.");
    }

    async function capture(session, jobId, dependencyUrl) {
      const adapter = adapterFor(jobId);
      const result = await adapter.captureResult({
        dependencyUrl,
        jobId,
        mode: session.plan.mode,
        plan: session.plan,
        target: targetFor(session.plan, jobId),
      });
      if (!result) return null;
      return store.checkpoint(session.id, jobId, {
        stage: "result-captured",
        resultId: result.resultId,
        resultUrl: result.resultUrl,
        updatedAt: now(),
        error: "",
      });
    }

    async function appendResult(session, jobId, currentFingerprint) {
      const job = session.jobs[jobId];
      const platform = platformFor(jobId);
      const ledger = await catalogueClient.appendDistributionLedger({
        eventId: "published",
        runId: session.id,
        jobId,
        platform,
        catalogueRow: session.plan.catalogue.row,
        catalogueId: session.plan.catalogue.id,
        resultId: job.resultId,
        resultUrl: job.resultUrl,
        status: "published",
        recordedAt: job.updatedAt || session.plan.authorization.at,
      });
      assertSheetResult(ledger, "Distribution ledger append");

      let compact = null;
      if (jobId === "x") {
        compact = await catalogueClient.appendTwitterTeaser({
          row: session.plan.catalogue.row,
          id: session.plan.catalogue.id,
          fingerprint: currentFingerprint,
          statusUrl: job.resultUrl,
        });
        assertSheetResult(compact, "Twitter teaser append");
      } else if (jobId.startsWith("reddit:")) {
        compact = await catalogueClient.appendRedditPost({
          row: session.plan.catalogue.row,
          id: session.plan.catalogue.id,
          fingerprint: currentFingerprint,
          redditUrl: job.resultUrl,
        });
        assertSheetResult(compact, "Reddit post append");
      }
      const next = await store.checkpoint(session.id, jobId, {
        stage: COMPLETE,
        error: "",
        updatedAt: now(),
      });
      return {
        fingerprint: compact?.fingerprint || currentFingerprint,
        session: next,
      };
    }

    async function recoverFingerprint(session) {
      let fingerprint = session.plan.catalogue.fingerprint;
      for (const [jobId, job] of Object.entries(session.jobs)) {
        if (job.stage !== COMPLETE) continue;
        let result;
        if (jobId === "x") {
          result = await catalogueClient.appendTwitterTeaser({
            row: session.plan.catalogue.row,
            id: session.plan.catalogue.id,
            fingerprint,
            statusUrl: job.resultUrl,
          });
        } else if (jobId.startsWith("reddit:")) {
          result = await catalogueClient.appendRedditPost({
            row: session.plan.catalogue.row,
            id: session.plan.catalogue.id,
            fingerprint,
            redditUrl: job.resultUrl,
          });
        }
        if (result) {
          assertSheetResult(result, "Catalogue checkpoint recovery");
          fingerprint = result.fingerprint || fingerprint;
        }
      }
      return fingerprint;
    }

    async function fail(session, jobId, error, uncertain = false) {
      return store.checkpoint(session.id, jobId, {
        stage: uncertain ? "posted-link-unresolved" : "failed",
        error: cleanError(error),
        updatedAt: now(),
      });
    }

    async function runJob(sessionId, jobId, dependencyUrl, fingerprint) {
      let session = await store.load(sessionId);
      let job = session.jobs[jobId];
      if (!job || job.stage === COMPLETE || TERMINAL.has(job.stage)) {
        return { fingerprint, session };
      }

      if (
        job.stage === "submit-attempted" ||
        job.stage === "posted-link-unresolved"
      ) {
        try {
          session = (await capture(session, jobId, dependencyUrl)) || session;
        } catch (error) {
          if (job.stage === "submit-attempted") {
            session = await fail(session, jobId, error, true);
          }
          return { fingerprint, session };
        }
        job = session.jobs[jobId];
        if (job.stage !== "result-captured") {
          if (job.stage === "submit-attempted") {
            session = await fail(
              session,
              jobId,
              "The public result could not be resolved.",
              true,
            );
          }
          return { fingerprint, session };
        }
      }

      if (job.stage === "planned") {
        try {
          const adapter = adapterFor(jobId);
          await adapter.prepare({
            dependencyUrl,
            jobId,
            mode: session.plan.mode,
            plan: session.plan,
            target: targetFor(session.plan, jobId),
          });
          session = await store.checkpoint(sessionId, jobId, {
            stage: "prepared",
            error: "",
            updatedAt: now(),
          });
        } catch (error) {
          return {
            fingerprint,
            session: await fail(session, jobId, error, false),
          };
        }
        job = session.jobs[jobId];
      }

      if (job.stage === "prepared") {
        if (session.plan.mode === "manual") {
          try {
            session = (await capture(session, jobId, dependencyUrl)) || session;
          } catch {
            return { fingerprint, session };
          }
          if (session.jobs[jobId].stage === "prepared") {
            return { fingerprint, session };
          }
        } else {
          session = await store.checkpoint(sessionId, jobId, {
            stage: "submit-attempted",
            updatedAt: now(),
          });
          try {
            await adapterFor(jobId).submit({
              dependencyUrl,
              jobId,
              mode: session.plan.mode,
              plan: session.plan,
              target: targetFor(session.plan, jobId),
            });
          } catch (error) {
            return {
              fingerprint,
              session: await fail(session, jobId, error, true),
            };
          }
          try {
            session = (await capture(session, jobId, dependencyUrl)) || session;
          } catch (error) {
            return {
              fingerprint,
              session: await fail(session, jobId, error, true),
            };
          }
          if (session.jobs[jobId].stage !== "result-captured") {
            return {
              fingerprint,
              session: await fail(
                session,
                jobId,
                "The public result could not be resolved.",
                true,
              ),
            };
          }
        }
      }

      session = await store.load(sessionId);
      if (session.jobs[jobId].stage === "result-captured") {
        try {
          return await appendResult(session, jobId, fingerprint);
        } catch (error) {
          return {
            fingerprint,
            session: await store.checkpoint(sessionId, jobId, {
              stage: "result-captured",
              error: cleanError(error),
              updatedAt: now(),
            }),
          };
        }
      }
      return { fingerprint, session };
    }

    async function resumeSocialDistribution(sessionId) {
      let session = await store.load(sessionId);
      if (!session) throw new Error("Distribution session was not found.");
      let fingerprint = await recoverFingerprint(session);

      if (session.jobs.x) {
        const result = await runJob(sessionId, "x", "", fingerprint);
        session = result.session;
        fingerprint = result.fingerprint;
      }
      if (session.jobs.redgifs) {
        const result = await runJob(sessionId, "redgifs", "", fingerprint);
        fingerprint = result.fingerprint;
      }

      session = await store.load(sessionId);
      const redgifs = session.jobs.redgifs;
      const dependencyUrl = redgifs?.resultUrl || "";
      const redditJobs = Object.keys(session.jobs).filter((jobId) =>
        jobId.startsWith("reddit:"),
      );
      if (!dependencyUrl) {
        if (redgifs && redgifs.stage !== "prepared") {
          for (const jobId of redditJobs) {
            if (session.jobs[jobId].stage === "planned") {
              session = await store.checkpoint(sessionId, jobId, {
                stage: "blocked",
                error: "Redgifs did not produce a confirmed public URL.",
                updatedAt: now(),
              });
            }
          }
        }
        return store.load(sessionId);
      }

      for (const jobId of redditJobs) {
        session = await store.load(sessionId);
        if (session.jobs[jobId].stage === "blocked") {
          await store.unblock(sessionId, jobId);
        }
        const result = await runJob(
          sessionId,
          jobId,
          dependencyUrl,
          fingerprint,
        );
        fingerprint = result.fingerprint;
      }
      return store.load(sessionId);
    }

    async function retrySocialDestination(previousId, jobId, nextPlan) {
      const previous = await store.load(previousId);
      if (!previous || !previous.jobs[jobId]) {
        throw new Error("The previous distribution destination was not found.");
      }
      if (
        nextPlan?.id === previousId ||
        Number(nextPlan?.authorization?.at) <=
          Number(previous.plan.authorization.at) ||
        nextPlan?.authorization?.sha256 === previous.plan.authorization.sha256
      ) {
        throw new Error("Retry requires a new authorization and session.");
      }
      if (
        nextPlan?.catalogue?.row !== previous.plan.catalogue.row ||
        nextPlan?.catalogue?.id !== previous.plan.catalogue.id ||
        nextPlan?.socialFile?.sha256 !== previous.plan.socialFile.sha256
      ) {
        throw new Error(
          "Retry must preserve the exact catalogue and teaser pairing.",
        );
      }
      await store.create(nextPlan);
      return resumeSocialDistribution(nextPlan.id);
    }

    return Object.freeze({
      resumeSocialDistribution,
      retrySocialDestination,
      startSocialDistribution: resumeSocialDistribution,
    });
  }

  globalThis.CreatorSocialDistributionOrchestrator = Object.freeze({ create });
})();
