using OFEnhancer.Protocol;
using System.Text.Json;
using OFEnhancer.Desktop;

namespace OFEnhancer.Desktop.Tests;

[TestClass]
public class BrowserUploadChannelTests
{
    [TestMethod]
    public async Task ChromePageTimeoutRemovesUndeliveredCommandAndOnlyAcceptsKnownPages()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        using var cancellation = new CancellationTokenSource();
        var opening = channel.OpenChromePageAsync("extensions", cancellation.Token);
        cancellation.Cancel();
        await Assert.ThrowsExceptionAsync<TaskCanceledException>(() => opening);
        Assert.AreEqual(0, Json(channel.Exchange(Json(new { browserId = browser }))).GetProperty("commands").GetArrayLength());
        Assert.ThrowsException<InvalidOperationException>(() => channel.OpenChromePageAsync("settings/reset", CancellationToken.None));
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [TestMethod]
    public async Task ExpiryCancelsPendingWorkAndDoesNotSwitchToAnotherSoleBrowser()
    {
        var clock = new Clock();
        using var channel = new BrowserUploadChannel(clock);
        string first = Guid.NewGuid().ToString(), second = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = first }));
        var pending = channel.RequestAsync(Json(new { kind = "message" }));
        clock.Now += TimeSpan.FromSeconds(9);
        channel.Exchange(Json(new { browserId = second }));
        clock.Now += TimeSpan.FromSeconds(1);
        var status = Json(channel.Status());
        Assert.IsFalse(status.GetProperty("connected").GetBoolean());
        Assert.IsTrue(status.GetProperty("selectionRequired").GetBoolean());
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => pending);
        await Assert.ThrowsExceptionAsync<UploadCommandNotQueuedException>(() => channel.RequestAsync(Json(new { kind = "message" })));
        Assert.AreEqual(0, Json(channel.Exchange(Json(new { browserId = second }))).GetProperty("commands").GetArrayLength());
    }

    [TestMethod]
    public async Task RetiredConnectionCannotRestoreReadinessOrReceivePendingCommands()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString(), old = Guid.NewGuid().ToString(), current = Guid.NewGuid().ToString();
        JsonElement Exchange(string connection) => JsonSerializer.SerializeToElement(new { browserId = browser, connectionId = connection });
        channel.Exchange(Exchange(old));
        var pending = channel.RequestAsync(Json(new { kind = "message" }));
        Assert.AreEqual(0, Json(channel.Exchange(Exchange(current))).GetProperty("commands").GetArrayLength());
        await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => pending);
        Assert.ThrowsException<InvalidOperationException>(() => channel.Exchange(Exchange(old)));
        Assert.IsFalse(Json(channel.Status()).GetProperty("connected").GetBoolean());
    }
    [TestMethod]
    public async Task JsonAttachmentCannotEnterSelectedBrowserQueue()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        channel.Select(browser);
        foreach (var command in new object[] {
            new { kind = "file", filePath = "C:\\private\\inert.mp4", sessionId = "pending123", token = "matching-token" },
            new { kind = "message", message = new { type = "OFENHANCER_APP_REQUEST", payload = new { kind = "file", filePath = "C:\\private\\inert.mp4" } } },
            new { kind = "port", message = new { type = "file-response", filePath = "C:\\private\\inert.mp4" } }
        })
        {
            await Assert.ThrowsExceptionAsync<UploadCommandNotQueuedException>(() => channel.RequestAsync(Json(command)).WaitAsync(TimeSpan.FromMilliseconds(500)));
            Assert.AreEqual(0, Json(channel.Exchange(Json(new { browserId = browser }))).GetProperty("commands").GetArrayLength());
        }
    }

    [TestMethod]
    public async Task PreparationRejectionPreservesAdmissionAndRecoveryFieldsWithoutReplayingCommand()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        var pending = channel.RequestAsync(Json(new { kind = "message", message = new { type = "PREPARE_CREATOR_UPLOAD", sessionId = "neutral-preparation-run" } }));
        var exchange = Json(channel.Exchange(Json(new { browserId = browser })));
        Assert.AreEqual(1, exchange.GetProperty("commands").GetArrayLength());
        string commandId = exchange.GetProperty("commands")[0].GetProperty("id").GetString()!;
        var rejection = new { ok = false, error = "A previous draft needs review.", rejectionCode = "upload-preparation-recovery-required", recoveryRequired = true, uploadAdmission = "not-started" };
        channel.Exchange(Json(new { browserId = browser, replies = new[] { new { id = commandId, result = rejection } } }));
        JsonElement result = await pending;
        Assert.IsFalse(result.GetProperty("ok").GetBoolean());
        Assert.AreEqual(rejection.error, result.GetProperty("error").GetString());
        Assert.AreEqual(rejection.rejectionCode, result.GetProperty("rejectionCode").GetString());
        Assert.AreEqual("not-started", result.GetProperty("uploadAdmission").GetString());
        Assert.IsTrue(result.GetProperty("recoveryRequired").GetBoolean());
        Assert.AreEqual(0, Json(channel.Exchange(Json(new { browserId = browser }))).GetProperty("commands").GetArrayLength());
    }

    [TestMethod]
    public void UploadBindingAcknowledgementOnlyComesFromTheSelectedLiveBrowser()
    {
        using var channel = new BrowserUploadChannel();
        string selected = Guid.NewGuid().ToString(), foreign = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = selected }));
        channel.Select(selected);
        List<JsonElement> received = [];
        channel.EventReceived += value => received.Add(value);
        var events = new[] { new { portId = Guid.NewGuid().ToString(), message = new { type = "session-bound", sessionId = "neutral-preparation-run" } } };
        channel.Exchange(Json(new { browserId = foreign, events }));
        Assert.AreEqual(0, received.Count);
        channel.Exchange(Json(new { browserId = selected, events }));
        Assert.AreEqual(1, received.Count);
        Assert.AreEqual("session-bound", received[0].GetProperty("message").GetProperty("type").GetString());
        Assert.AreEqual("neutral-preparation-run", received[0].GetProperty("message").GetProperty("sessionId").GetString());
    }

    private static JsonElement Json(object value)
    {
        var result = JsonSerializer.SerializeToElement(value);
        if (!result.TryGetProperty("browserId", out var id)) return result;
        var data = result.EnumerateObject().ToDictionary(property => property.Name, property => (object)property.Value);
        data["connectionId"] = id;
        return JsonSerializer.SerializeToElement(data);
    }

    [TestMethod]
    public async Task RequestsRequireLiveBrowserAndRepliesStayBound()
    {
        var channel = new BrowserUploadChannel();
        await Assert.ThrowsExceptionAsync<UploadCommandNotQueuedException>(() => channel.RequestAsync(Json(new { kind = "message" })));
        string first = Guid.NewGuid().ToString(), second = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = first }));
        var request = channel.RequestAsync(Json(new { kind = "storageGet", keys = new[] { "creatorToolkitV2" } }));
        var exchange = Json(channel.Exchange(Json(new { browserId = first })));
        string id = exchange.GetProperty("commands")[0].GetProperty("id").GetString()!;
        channel.Exchange(Json(new { browserId = second, replies = new[] { new { id, result = new { wrong = true } } } }));
        Assert.IsFalse(request.IsCompleted);
        channel.Exchange(Json(new { browserId = first, replies = new[] { new { id, result = new { accepted = true } } } }));
        Assert.IsTrue((await request).GetProperty("accepted").GetBoolean());
    }

    [TestMethod]
    public async Task MultipleBrowsersRequireSelectionAndCannotSwitchWhileRunning()
    {
        var channel = new BrowserUploadChannel();
        string first = Guid.NewGuid().ToString(), second = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = first }));
        channel.Exchange(Json(new { browserId = second }));
        await Assert.ThrowsExceptionAsync<UploadCommandNotQueuedException>(() => channel.RequestAsync(Json(new { kind = "message" })));
        channel.Select(first);
        var request = channel.RequestAsync(Json(new { kind = "message" }));
        Assert.ThrowsException<InvalidOperationException>(() => channel.Select(second));
        var sent = Json(channel.Exchange(Json(new { browserId = first })));
        string id = sent.GetProperty("commands")[0].GetProperty("id").GetString()!;
        channel.Exchange(Json(new { browserId = first, replies = new[] { new { id, result = new { } } } }));
        await request;
        channel.Select(second);
    }

    private static (BrowserUploadChannel Channel, string Browser, string CommandId, Task<JsonElement> Request) Pending()
    {
        var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        var request = channel.RequestAsync(Json(new { kind = "message" }));
        var sent = Json(channel.Exchange(Json(new { browserId = browser })));
        return (channel, browser, sent.GetProperty("commands")[0].GetProperty("id").GetString()!, request);
    }

    [TestMethod]
    public async Task ReplyWithoutResultSettlesItsRequestWithAProtocolError()
    {
        var (channel, browser, id, request) = Pending();
        using (channel)
        {
            channel.Exchange(Json(new { browserId = browser, replies = new[] { new { id } } }));
            await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => request.WaitAsync(TimeSpan.FromSeconds(2)));
            channel.Select(browser);
            Assert.AreEqual(0, Json(channel.Exchange(Json(new { browserId = browser }))).GetProperty("commands").GetArrayLength());
        }
    }

    [TestMethod]
    public async Task ReplyWithNonStringErrorSettlesItsRequestWithAProtocolError()
    {
        var (channel, browser, id, request) = Pending();
        using (channel)
        {
            channel.Exchange(Json(new { browserId = browser, replies = new[] { new { id, error = new { code = 7 } } } }));
            var failure = await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => request.WaitAsync(TimeSpan.FromSeconds(2)));
            Assert.IsTrue(failure.Message.Length is > 0 and <= 200);
        }
    }

    [TestMethod]
    public async Task MalformedEntryWithoutIdDoesNotAbortTheRestOfTheBatch()
    {
        var (channel, browser, id, request) = Pending();
        using (channel)
        {
            var second = channel.RequestAsync(Json(new { kind = "message" }));
            List<JsonElement> received = [];
            channel.EventReceived += value => received.Add(value);
            var events = new[] { new { portId = Guid.NewGuid().ToString(), message = new { type = "session-bound" } } };
            object[] replies = [5, new { result = 1 }, new { id = 12, result = 1 }, new { id, result = new { ok = true } }];
            var exchange = Json(channel.Exchange(Json(new { browserId = browser, replies, events })));
            Assert.IsTrue((await request.WaitAsync(TimeSpan.FromSeconds(2))).GetProperty("ok").GetBoolean());
            Assert.AreEqual(1, received.Count);
            Assert.AreEqual(1, exchange.GetProperty("commands").GetArrayLength());
            Assert.IsFalse(second.IsCompleted);
        }
    }

    [TestMethod]
    public async Task ThrowingSubscriberStillReturnsTheExchangeResponseWithItsCommands()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        var request = channel.RequestAsync(Json(new { kind = "message" }));
        channel.EventReceived += _ => throw new InvalidOperationException("subscriber failed");
        var events = new[] { new { portId = Guid.NewGuid().ToString(), message = new { type = "a" } }, new { portId = Guid.NewGuid().ToString(), message = new { type = "b" } } };
        var exchange = Json(channel.Exchange(Json(new { browserId = browser, events })));
        Assert.AreEqual(1, exchange.GetProperty("commands").GetArrayLength());
        Assert.IsFalse(request.IsCompleted);
        await Task.CompletedTask;
    }

    [TestMethod]
    public void ThrowingFirstSubscriberDoesNotStopTheSecondFromReceivingTheEvent()
    {
        using var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        var request = channel.RequestAsync(Json(new { kind = "message" }));
        List<string> received = [];
        channel.EventReceived += _ => throw new InvalidOperationException("first subscriber failed");
        channel.EventReceived += value => received.Add(value.GetProperty("message").GetProperty("type").GetString()!);
        var events = new[] { new { portId = Guid.NewGuid().ToString(), message = new { type = "a" } }, new { portId = Guid.NewGuid().ToString(), message = new { type = "b" } } };
        var exchange = Json(channel.Exchange(Json(new { browserId = browser, events })));
        CollectionAssert.AreEqual(new[] { "a", "b" }, received);
        Assert.AreEqual(1, exchange.GetProperty("commands").GetArrayLength());
        Assert.IsFalse(request.IsCompleted);
    }

    [TestMethod]
    public async Task RefusalBeforeQueuingIsDistinctFromLossAfterQueuing()
    {
        var clock = new Clock();
        using var channel = new BrowserUploadChannel(clock);
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        var queued = channel.RequestAsync(Json(new { kind = "message", message = new { type = "PREPARE_CREATOR_UPLOAD" } }));
        Assert.AreEqual(1, Json(channel.Exchange(Json(new { browserId = browser }))).GetProperty("commands").GetArrayLength());
        clock.Now += TimeSpan.FromSeconds(11);
        channel.Status();
        // The queued command may have reached the browser, so its loss is not a refusal.
        var lost = await Assert.ThrowsExceptionAsync<InvalidOperationException>(() => queued.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.IsNotInstanceOfType(lost, typeof(UploadCommandNotQueuedException));
        // A new command against the disconnected browser is refused before queuing.
        await Assert.ThrowsExceptionAsync<UploadCommandNotQueuedException>(() => channel.RequestAsync(Json(new { kind = "message", message = new { type = "PREPARE_CREATOR_UPLOAD" } })));
    }

    [TestMethod]
    public async Task RequestsAfterDisposeFailAtOnce()
    {
        var channel = new BrowserUploadChannel();
        string browser = Guid.NewGuid().ToString();
        channel.Exchange(Json(new { browserId = browser }));
        channel.Dispose();
        await Assert.ThrowsExceptionAsync<UploadCommandNotQueuedException>(() => channel.RequestAsync(Json(new { kind = "message" })).WaitAsync(TimeSpan.FromSeconds(2)));
        await Assert.ThrowsExceptionAsync<UploadCommandNotQueuedException>(() => channel.OpenChromePageAsync("extensions", CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2)));
    }
}
